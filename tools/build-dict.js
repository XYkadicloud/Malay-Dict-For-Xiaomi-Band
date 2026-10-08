/******************************************************************************
 * @file        build-dict.js
 * @description 词库构建：多源合并 → 按首字母分片 + 中文/英文反查索引
 *              用法：node tools/build-dict.js
 *              输出：src/assets/dict/{index.txt, ms-*.txt, zh.txt, py-*.txt, en.txt}
 *
 *   数据源优先级（高 → 低；字段冲突时高优先级优先保留）：
 *     1. seed-words.js / seed-words-2.js   手写常用词（人工校对，最可靠）
 *     2. zhwiktionary-words.js             中文维基词典（直接中文释义）
 *     3. generated-words.js                Kaikki + ECDICT（英文释义，量大）
 *
 *   索引文件（★ 拆分成小文件，手环内存友好）
 *
 *   zh.txt            : { zh2ms }  中文词 → [马来语词]
 *   py-<letter>.txt   : { py }     拼音(按首字母分文件) → [中文词]
 *   en.txt            : { en2ms }  英文核心词 → [马来语词]
 *
 *   为什么要拆：
 *     v0.6 把所有索引塞进一个 zh.txt（1MB），运行时 JSON.parse 后占约 5.7MB 堆，
 *     叠加分片缓存后超出手环 JS 堆上限 → 切方向搜索就重启。
 *     拆开后：查拼音只加载对应首字母的小文件（约 20KB），峰值内存下降约 90%。
 ******************************************************************************/

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'src', 'assets', 'dict')

const POS_MAP = {
  n: 'n', v: 'v', a: 'adj', adv: 'adv', num: 'num',
  pron: 'pron', prep: 'prep', conj: 'conj', int: 'int',
  cls: 'cls', part: 'part'
}

/**
 * 数据源配置
 *   prio    优先级，越大越优先
 *   cleanZh 是否清理中文释义的模板残留（维基词典）
 *   enCol   第 4 段存的是英文释义而非马来文释义
 */
const SOURCES = [
  { file: 'seed-words.js', prio: 100 },
  { file: 'seed-words-2.js', prio: 100 },
  { file: 'zhwiktionary-words.js', prio: 60, cleanZh: true },
  { file: 'generated-words.js', prio: 30, enCol: true }
]

const WORD_RE = /^[a-z]+(?:[ -][a-z]+)*$/
const MAX_ZH2MS = 8        // 单个中文词最多关联多少个马来语词
const MAX_ZH_SINGLE = 8    // 单字 key 的配额（与整词一致，避免「吃」被挤掉 makan）
const MAX_EN2MS = 6        // 单个英文词最多关联多少个马来语词
const MAX_PY_PER_KEY = 12  // 单个拼音键最多挂多少个候选字

/* ------------------------- 中文释义清理 ------------------------- */

/** 去掉维基词典的模板/标点残留 */
function cleanZh(text) {
  let t = String(text || '')
  t = t.replace(/^[。．.、，,；;：:·・\s]+/, '')
  t = t.replace(/(詞源|词源|讀音|读音|發音|发音|名詞|名词|動詞|动词|形容詞|形容词|副詞|副词|代詞|代词)[:：]?/g, ' ')
  t = t.replace(/[（(][^）)]{0,20}[）)]/g, ' ')
  t = t.replace(/\s+/g, ' ')
  return t.trim()
}

/* ------------------------- 解析 ------------------------- */

/**
 * 行格式（用 | 分隔，共 7 段）：
 *   马来语|词性|中文|释义(英/马)|例句|同义词(逗号)|反义词(逗号)
 */
function parseLine(line, cfg) {
  if (!line || typeof line !== 'string') return null
  const raw = line.trim()
  if (!raw || raw.charAt(0) === '#') return null

  const parts = raw.split('|')
  const word = (parts[0] || '').trim().toLowerCase()
  if (!word || !WORD_RE.test(word)) return null

  const entry = { w: word }

  const pos = (parts[1] || '').trim()
  if (pos) entry.p = POS_MAP[pos] || pos

  let zh = (parts[2] || '').trim()
  if (cfg.cleanZh) zh = cleanZh(zh)
  if (zh) entry.zh = zh

  const fourth = (parts[3] || '').trim()
  if (cfg.enCol) {
    if (fourth) entry.en = fourth
  } else if (fourth) {
    entry.ms = fourth
  }

  const ex = (parts[4] || '').trim()
  if (ex) entry.ex = ex

  const syn = splitMalay(parts[5])
  if (syn.length) entry.syn = syn
  const ant = splitMalay(parts[6])
  if (ant.length) entry.ant = ant

  return entry
}

function splitMalay(text) {
  if (!text) return []
  const out = []
  const arr = String(text).split(',')
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i].trim().toLowerCase()
    if (s && WORD_RE.test(s) && out.indexOf(s) === -1) out.push(s)
  }
  return out
}

/** 合并重复词条：只补空缺，不覆盖已有（先到者优先） */
function mergeEntry(dst, src) {
  if (!dst.p && src.p) dst.p = src.p
  if (!dst.zh && src.zh) dst.zh = src.zh
  if (!dst.en && src.en) dst.en = src.en
  if (!dst.ms && src.ms) dst.ms = src.ms
  if (!dst.ex && src.ex) dst.ex = src.ex

  if (src.syn) {
    if (!dst.syn) dst.syn = []
    for (let i = 0; i < src.syn.length; i++) {
      if (dst.syn.indexOf(src.syn[i]) === -1 && src.syn[i] !== dst.w) dst.syn.push(src.syn[i])
    }
    if (!dst.syn.length) delete dst.syn
  }
  if (src.ant) {
    if (!dst.ant) dst.ant = []
    for (let i = 0; i < src.ant.length; i++) {
      if (dst.ant.indexOf(src.ant[i]) === -1 && src.ant[i] !== dst.w) dst.ant.push(src.ant[i])
    }
    if (!dst.ant.length) delete dst.ant
  }
}

/* ------------------------- 中文反查索引 ------------------------- */

const HANZI_RE = /[\u4e00-\u9fa5]/
const SPLIT_ZH = /[,，、;；\/|()（）\s]+/

function isAllHanzi(s) {
  if (!s) return false
  for (let i = 0; i < s.length; i++) {
    if (!HANZI_RE.test(s.charAt(i))) return false
  }
  return true
}

function wordPinyin(word, pinyinMap) {
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const p = pinyinMap[word.charAt(i)]
    if (!p) return null
    out += p
  }
  return out
}

function wordAbbr(word, pinyinMap) {
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const p = pinyinMap[word.charAt(i)]
    if (!p) return null
    out += p.charAt(0)
  }
  return out
}

function addPy(py, key, word) {
  if (!key) return
  if (!py[key]) py[key] = []
  if (py[key].indexOf(word) !== -1) return
  if (py[key].length >= MAX_PY_PER_KEY) return
  py[key].push(word)
}

function buildZhIndex(entries) {
  const pinyinMap = require(path.join(__dirname, 'pinyin-map.js'))

  const py = {}
  const zh2ms = {}
  let noPinyin = 0

  /** 注册一个中文 key → 马来语词（带去重与上限） */
  const reg = function (key, msWord, cap) {
    if (!key) return
    if (!zh2ms[key]) zh2ms[key] = []
    const limit = cap || MAX_ZH2MS
    if (zh2ms[key].indexOf(msWord) === -1 && zh2ms[key].length < limit) {
      zh2ms[key].push(msWord)
    }
  }

  /* ---------- 第一遍：只注册「整词」，保证整词命中优先级最高 ---------- */
  const pairs = []   // [{ word, msWord }] 供第二遍注册子串
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e.zh) continue
    const words = e.zh.split(SPLIT_ZH)
    for (let j = 0; j < words.length; j++) {
      const word = words[j].trim()
      if (!word || !isAllHanzi(word)) continue
      reg(word, e.w)
      pairs.push({ word: word, ms: e.w })
    }
  }

  /* ---------- 第二遍：注册子串（「蓝色」→ 蓝 / 色） ---------- */
  for (let i = 0; i < pairs.length; i++) {
    const word = pairs[i].word
    const ms = pairs[i].ms
    if (word.length < 2) continue     // 单字没有更短的子串
    for (let a = 0; a < word.length; a++) {
      for (let b = a + 1; b <= word.length; b++) {
        const sub = word.slice(a, b)
        if (sub === word) continue
        reg(sub, ms, MAX_ZH_SINGLE)
      }
    }
  }

  /* ---------- 拼音键 ---------- */
  for (let i = 0; i < pairs.length; i++) {
    const word = pairs[i].word
    const full = wordPinyin(word, pinyinMap)
    if (!full) {
      noPinyin++
      continue
    }
    addPy(py, full, word)

    // 首字母缩写（仅多字词，避免单字键爆炸）
    if (word.length >= 2) {
      const abbr = wordAbbr(word, pinyinMap)
      if (abbr && abbr !== full) addPy(py, abbr, word)
    }
  }

  return { py: py, zh2ms: zh2ms, noPinyin: noPinyin }
}

/* ------------------------- 英文反查索引 ------------------------- */

const STOP_EN = {}
;('a an the to of in on at for with by from as is are was were be been being ' +
 'this that these those it its his her their our your my ' +
 'and or but not no nor so if then than which who whom whose what ' +
 'one person people thing things kind sort type form state ' +
 'usually especially often sometimes typically generally ' +
 'used using use make makes made making').split(' ').forEach(function (w) {
  if (w) STOP_EN[w] = 1
})

/** 从英文释义里提取核心词（最多取前 3 个） */
function coreEnWords(text) {
  const out = []
  let t = String(text || '').toLowerCase()
  t = t.replace(/\([^)]*\)/g, ' ')
  t = t.replace(/[^a-z\s-]/g, ' ')
  const arr = t.split(/\s+/)
  for (let i = 0; i < arr.length && out.length < 3; i++) {
    const w = arr[i].trim()
    if (!w || w.length < 2) continue
    if (STOP_EN[w]) continue
    if (out.indexOf(w) === -1) out.push(w)
  }
  return out
}

function buildEnIndex(entries) {
  const en2ms = {}
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e.en) continue
    const ws = coreEnWords(e.en)
    for (let j = 0; j < ws.length; j++) {
      const k = ws[j]
      if (!en2ms[k]) en2ms[k] = []
      if (en2ms[k].indexOf(e.w) === -1 && en2ms[k].length < MAX_EN2MS) en2ms[k].push(e.w)
    }
  }
  return en2ms
}

/* ------------------------- 主流程 ------------------------- */

function main() {
  const collected = []
  const stat = {}

  for (let s = 0; s < SOURCES.length; s++) {
    const cfg = SOURCES[s]
    const p = path.join(__dirname, cfg.file)
    if (!fs.existsSync(p)) {
      console.warn('跳过不存在的源: ' + cfg.file)
      continue
    }
    let arr = null
    try {
      arr = require(p)
    } catch (e) {
      console.warn('加载失败 ' + cfg.file + ': ' + e)
      continue
    }
    if (!Array.isArray(arr)) continue
    let n = 0
    for (let i = 0; i < arr.length; i++) {
      const e = parseLine(arr[i], cfg)
      if (!e) continue
      e._prio = cfg.prio
      collected.push(e)
      n++
    }
    stat[cfg.file] = n
  }

  if (collected.length === 0) {
    console.error('没有可用的词条')
    process.exit(1)
  }

  collected.sort(function (a, b) { return b._prio - a._prio })

  const list = []
  const byWord = {}
  let merged = 0

  for (let i = 0; i < collected.length; i++) {
    const e = collected[i]
    if (byWord[e.w]) {
      mergeEntry(byWord[e.w], e)
      merged++
      continue
    }
    delete e._prio
    byWord[e.w] = e
    list.push(e)
  }

  list.sort(function (a, b) {
    return a.w < b.w ? -1 : (a.w > b.w ? 1 : 0)
  })

  const shards = {}
  for (let i = 0; i < list.length; i++) {
    const k = list[i].w.charAt(0)
    if (!shards[k]) shards[k] = []
    shards[k].push(list[i])
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

  const old = fs.readdirSync(OUT_DIR)
  for (let i = 0; i < old.length; i++) {
    const f = old[i]
    if (f.indexOf('ms-') === 0 || f.indexOf('py-') === 0 || f.indexOf('zh-') === 0
      || f.indexOf('en-') === 0
      || f === 'index.txt' || f === 'index.json'
      || f === 'zh.txt' || f === 'zh.json' || f === 'en.txt' || f === 'en.json') {
      fs.unlinkSync(path.join(OUT_DIR, f))
    }
  }

  const letters = Object.keys(shards).sort()
  let totalBytes = 0
  let maxShard = 0
  let maxLetter = ''
  const shardInfo = {}

  for (let i = 0; i < letters.length; i++) {
    const k = letters[i]
    const json = JSON.stringify(shards[k])
    fs.writeFileSync(path.join(OUT_DIR, 'ms-' + k + '.txt'), json, 'utf8')
    const b = Buffer.byteLength(json, 'utf8')
    totalBytes += b
    shardInfo[k] = shards[k].length
    if (b > maxShard) { maxShard = b; maxLetter = k }
  }

  const zh = buildZhIndex(list)
  // ★ 中文反查按「首字码位 % 26」分桶，查词只加载 1/26（约 18KB）
  const zhBuckets = {}
  for (const k in zh.zh2ms) {
    const b = String(k.charCodeAt(0) % 26)
    if (!zhBuckets[b]) zhBuckets[b] = {}
    zhBuckets[b][k] = zh.zh2ms[k]
  }
  const zhBucketKeys = Object.keys(zhBuckets).sort()
  let zhBytes = 0
  for (let i = 0; i < zhBucketKeys.length; i++) {
    const b = zhBucketKeys[i]
    const j = JSON.stringify({ zh2ms: zhBuckets[b] })
    fs.writeFileSync(path.join(OUT_DIR, 'zh-' + b + '.txt'), j, 'utf8')
    zhBytes += Buffer.byteLength(j, 'utf8')
  }

  // ★ 拼音索引按首字母拆成 py-a.txt … py-z.txt，查询时只加载一个
  const pyBuckets = {}
  for (const k in zh.py) {
    const first = k.charAt(0)
    if (!pyBuckets[first]) pyBuckets[first] = {}
    pyBuckets[first][k] = zh.py[k]
  }
  const pyLetters = Object.keys(pyBuckets).sort()
  let pyBytes = 0
  for (let i = 0; i < pyLetters.length; i++) {
    const l = pyLetters[i]
    const j = JSON.stringify({ py: pyBuckets[l] })
    fs.writeFileSync(path.join(OUT_DIR, 'py-' + l + '.txt'), j, 'utf8')
    pyBytes += Buffer.byteLength(j, 'utf8')
  }

  // ★ 英文索引按首字母拆成 en-a.txt … en-z.txt
  const en2ms = buildEnIndex(list)
  const enBuckets = {}
  for (const k in en2ms) {
    const first = k.charAt(0)
    // 只保留 a-z 开头的键（loader 按首字母加载，其他键无法命中）
    if (first < 'a' || first > 'z') continue
    if (!enBuckets[first]) enBuckets[first] = {}
    enBuckets[first][k] = en2ms[k]
  }
  const enLetters = Object.keys(enBuckets).sort()
  let enBytes = 0
  for (let i = 0; i < enLetters.length; i++) {
    const l = enLetters[i]
    const j = JSON.stringify({ en2ms: enBuckets[l] })
    fs.writeFileSync(path.join(OUT_DIR, 'en-' + l + '.txt'), j, 'utf8')
    enBytes += Buffer.byteLength(j, 'utf8')
  }

  let withZh = 0
  let withEn = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i].zh) withZh++
    if (list[i].en) withEn++
  }

  const index = {
    version: 4,
    total: list.length,
    withZh: withZh,
    withEn: withEn,
    shardCount: letters.length,
    letters: letters,
    shards: shardInfo,
    pyLetters: pyLetters,
    zhBuckets: zhBucketKeys,
    enLetters: enLetters,
    zhMod: 26,
    source: 'seed + zhwiktionary + kaikki/ecdict',
    license: 'CC BY-SA 4.0 (Wiktionary/Kaikki) + MIT (ECDICT)',
    builtAt: new Date().toISOString()
  }
  const indexJson = JSON.stringify(index)
  fs.writeFileSync(path.join(OUT_DIR, 'index.txt'), indexJson, 'utf8')

  console.log('=== 词库构建完成 ===')
  console.log('各源解析条数 : ' + JSON.stringify(stat))
  console.log('词条总数     : ' + list.length + '（合并重复 ' + merged + '）')
  console.log('有中文释义   : ' + withZh + ' (' + (withZh * 100 / list.length).toFixed(1) + '%)')
  console.log('有英文释义   : ' + withEn + ' (' + (withEn * 100 / list.length).toFixed(1) + '%)')
  console.log('分片数       : ' + letters.length + ' → ' + letters.join(' '))
  console.log('分片总字节   : ' + totalBytes + ' B (' + (totalBytes / 1024).toFixed(1) + ' KB)')
  console.log('最大分片     : ' + maxLetter + ' = ' + (maxShard / 1024).toFixed(1) + ' KB')
  console.log('中文词数     : ' + Object.keys(zh.zh2ms).length)
  console.log('拼音键数     : ' + Object.keys(zh.py).length + '（无拼音 ' + zh.noPinyin + '）')
  console.log('英文键数     : ' + Object.keys(en2ms).length)
  console.log('zh-*.txt     : ' + zhBucketKeys.length + ' 个文件，共 ' + (zhBytes / 1024).toFixed(1) + ' KB')
  console.log('py-*.txt     : ' + pyLetters.length + ' 个文件，共 ' + (pyBytes / 1024).toFixed(1) + ' KB')
  console.log('en-*.txt     : ' + enLetters.length + ' 个文件，共 ' + (enBytes / 1024).toFixed(1) + ' KB')
  console.log('index.txt    : ' + Buffer.byteLength(indexJson, 'utf8') + ' B')
  console.log('输出目录     : ' + OUT_DIR)
}

main()