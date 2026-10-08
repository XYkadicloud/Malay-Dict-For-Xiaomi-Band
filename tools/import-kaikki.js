/******************************************************************************
 * @file        import-kaikki.js
 * @description 数据管线：Kaikki(马来语→英文) + ECDICT(英文→中文) → 中译马词库
 *
 *   输入：data/raw/kaikki-malay.jsonl   （Kaikki.org，CC BY-SA 4.0）
 *        data/raw/ecdict.csv           （ECDICT，MIT）
 *   输出：tools/generated-words.js
 *
 *   用法：node tools/import-kaikki.js
 *
 *   中文释义策略（按优先级）：
 *     1) 释义短语整体命中 ECDICT
 *     2) 释义首词命中
 *     3) 释义其余核心词命中
 *     4) 兜底：试词条自身的同义词
 *   全部失败则中文留空（仍保留马来语↔英文释义）。
 ******************************************************************************/

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const ROOT = path.resolve(__dirname, '..')
const RAW = path.join(ROOT, 'data', 'raw')
const OUT = path.join(__dirname, 'generated-words.js')

const KAIKKI = path.join(RAW, 'kaikki-malay.jsonl')
const ECDICT = path.join(RAW, 'ecdict.csv')

const MAX_ZH = 20
const MAX_MS = 80
const MAX_WORDS = 12000

/* ------------------------- 停用词 ------------------------- */

const STOP = {}
;('a an the to of in on at for with by from as is are was were be been being ' +
 'this that these those it its his her their our your my ' +
 'and or but not no nor so if then than which who whom whose what ' +
 'one person people thing things kind sort type form state ' +
 'usually especially often sometimes typically generally ' +
 'used using use make makes made making').split(' ').forEach(function (w) {
  if (w) STOP[w] = 1
})

/* ------------------------- ECDICT ------------------------- */

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i)
    if (inQuote) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++ }
        else inQuote = false
      } else cur += c
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
  }
  out.push(cur)
  return out
}

function cleanZh(s) {
  let t = String(s || '')
  t = t.replace(/\[[^\]]*\]/g, '')
  t = t.replace(/\([^)]*\)/g, '')
  t = t.replace(/（[^）]*）/g, '')
  t = t.replace(/\b[a-zA-Z]{1,6}\./g, '')
  t = t.replace(/[\r\n\t]+/g, ' ')
  t = t.replace(/\s+/g, ' ')
  t = t.split(/[;；,，\/|]/)[0]
  t = t.trim()
  if (t.length > MAX_ZH) t = t.substring(0, MAX_ZH)
  return t
}

function loadEcdict() {
  return new Promise(function (resolve) {
    const map = {}
    if (!fs.existsSync(ECDICT)) {
      console.warn('缺少 ' + ECDICT)
      resolve(map)
      return
    }
    const rl = readline.createInterface({
      input: fs.createReadStream(ECDICT, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })
    let header = true
    let n = 0
    rl.on('line', function (line) {
      if (header) { header = false; return }
      if (!line) return
      const f = parseCsvLine(line)
      if (f.length < 4) return
      const w = String(f[0] || '').toLowerCase().trim()
      if (!w || STOP[w]) return
      const zh = cleanZh(f[3])
      if (!zh) return
      if (!map[w]) { map[w] = zh; n++ }
    })
    rl.on('close', function () {
      console.log('ECDICT：' + n + ' 条英中映射')
      resolve(map)
    })
  })
}

/* ------------------------- Kaikki ------------------------- */

const POS_MAP = {
  noun: 'n', verb: 'v', adj: 'a', adjective: 'a', adv: 'adv', adverb: 'adv',
  num: 'num', numeral: 'num', pron: 'pron', pronoun: 'pron',
  prep: 'prep', preposition: 'prep', conj: 'conj', conjunction: 'conj',
  interj: 'int', interjection: 'int', classifier: 'cls',
  particle: 'part', article: 'art', det: 'det'
}

const SKIP_POS = {
  'proper noun': 1, 'proper-name': 1, phrase: 1, 'prepositional phrase': 1,
  prefix: 1, suffix: 1, infix: 1, circumfix: 1, root: 1, proverb: 1,
  character: 1, symbol: 1, punctuation: 1
}

function loadKaikki() {
  return new Promise(function (resolve) {
    const entries = []
    if (!fs.existsSync(KAIKKI)) { resolve(entries); return }
    const rl = readline.createInterface({
      input: fs.createReadStream(KAIKKI, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })
    let n = 0
    rl.on('line', function (line) {
      if (!line) return
      let obj
      try { obj = JSON.parse(line) } catch (e) { return }
      n++

      const word = String(obj.word || '').toLowerCase().trim()
      if (!/^[a-z]+(?:[ -][a-z]+)*$/.test(word)) return
      if (word.length < 2 || word.length > 24) return

      const pos = String(obj.pos || '').toLowerCase()
      if (SKIP_POS[pos]) return

      const senses = obj.senses || []
      const gloss = []
      for (let i = 0; i < senses.length && gloss.length < 4; i++) {
        const g = senses[i].glosses || []
        for (let j = 0; j < g.length && gloss.length < 4; j++) {
          const t = String(g[j] || '').trim()
          if (t && t.length < MAX_MS) gloss.push(t)
        }
      }
      if (!gloss.length) return

      const syn = []
      const ant = []
      const ss = obj.synonyms || []
      for (let i = 0; i < ss.length && syn.length < 6; i++) {
        const w = String(ss[i].word || '').toLowerCase()
        if (/^[a-z]+(?:[ -][a-z]+)*$/.test(w) && w !== word) syn.push(w)
      }
      const as = obj.antonyms || []
      for (let i = 0; i < as.length && ant.length < 4; i++) {
        const w = String(as[i].word || '').toLowerCase()
        if (/^[a-z]+(?:[ -][a-z]+)*$/.test(w) && w !== word) ant.push(w)
      }

      entries.push({ w: word, pos: POS_MAP[pos] || '', gloss: gloss, syn: syn, ant: ant })
    })
    rl.on('close', function () {
      console.log('Kaikki：' + n + ' 行，可用 ' + entries.length)
      resolve(entries)
    })
  })
}

/* ------------------------- 英→中 匹配 ------------------------- */

function candidates(gloss) {
  const out = []
  const add = function (s) {
    s = String(s || '').toLowerCase().trim()
    if (!s || s.length < 2) return
    if (STOP[s]) return
    if (out.indexOf(s) === -1) out.push(s)
  }

  for (let i = 0; i < gloss.length; i++) {
    let g = String(gloss[i]).toLowerCase()
    g = g.replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s-]/g, ' ')
    g = g.replace(/\s+/g, ' ').trim()
    if (!g) continue

    const words = g.split(' ').filter(function (w) { return w && !STOP[w] })
    if (words.length >= 2) {
      add(words[0] + ' ' + words[1])
      add(words[1] + ' ' + words[0])
    }
    if (words.length) add(words[0])
    for (let j = 1; j < words.length && j < 5; j++) add(words[j])
  }
  return out
}

function matchZh(gloss, ecdict) {
  const cands = candidates(gloss)
  for (let i = 0; i < cands.length; i++) {
    const zh = ecdict[cands[i]]
    if (zh) return zh
  }
  return ''
}

/* ------------------------- 主流程 ------------------------- */

async function main() {
  if (!fs.existsSync(RAW)) {
    console.error('缺少目录 ' + RAW)
    process.exit(1)
  }

  const ecdict = await loadEcdict()
  const kaikki = await loadKaikki()

  const byWord = {}
  const order = []
  for (let i = 0; i < kaikki.length; i++) {
    const e = kaikki[i]
    if (byWord[e.w]) {
      const t = byWord[e.w]
      if (e.pos && t.pos.indexOf(e.pos) === -1) t.pos += ',' + e.pos
      for (let j = 0; j < e.gloss.length; j++) {
        if (t.gloss.indexOf(e.gloss[j]) === -1 && t.gloss.length < 6) t.gloss.push(e.gloss[j])
      }
      for (let j = 0; j < e.syn.length; j++) {
        if (t.syn.indexOf(e.syn[j]) === -1 && t.syn.length < 8) t.syn.push(e.syn[j])
      }
      for (let j = 0; j < e.ant.length; j++) {
        if (t.ant.indexOf(e.ant[j]) === -1 && t.ant.length < 6) t.ant.push(e.ant[j])
      }
    } else {
      byWord[e.w] = {
        w: e.w, pos: e.pos, gloss: e.gloss.slice(),
        syn: e.syn.slice(), ant: e.ant.slice()
      }
      order.push(e.w)
    }
  }

  console.log('去重后：' + order.length)

  const lines = []
  let withZh = 0
  let noZh = 0

  for (let i = 0; i < order.length && lines.length < MAX_WORDS; i++) {
    const e = byWord[order[i]]
    let zh = matchZh(e.gloss, ecdict)

    if (!zh) {
      for (let j = 0; j < e.syn.length; j++) {
        const v = ecdict[e.syn[j]]
        if (v) { zh = v; break }
      }
    }
    if (zh) withZh++; else noZh++

    const pos = (e.pos || '').split(',')[0]
    const ms = String(e.gloss[0] || '').replace(/[|\r\n\t]/g, ' ').substring(0, MAX_MS)
    const syn = e.syn.slice(0, 5).join(',')
    const ant = e.ant.slice(0, 3).join(',')
    lines.push(e.w + '|' + pos + '|' + zh + '|' + ms + '||' + syn + '|' + ant)
  }

  const head = '/******************************************************************************\n'
    + ' * @file        generated-words.js\n'
    + ' * @description 由 tools/import-kaikki.js 自动生成，请勿手工编辑。\n'
    + ' *\n'
    + ' *   数据来源：\n'
    + ' *     Kaikki.org（Wiktionary 抽取，CC BY-SA 4.0）—— 马来语词条 / 英文释义 / 同反义词\n'
    + ' *     ECDICT（MIT）—— 英中映射\n'
    + ' *   生成时间：' + new Date().toISOString() + '\n'
    + ' *   词条数：' + lines.length + '（有中文释义 ' + withZh + '，无 ' + noZh + '）\n'
    + ' *   中文释义为机器辅助匹配，仅供参考。\n'
    + ' ******************************************************************************/\n\n'
    + 'module.exports = [\n'

  const body = lines.map(function (l) {
    return "  '" + l.replace(/'/g, "\\'") + "'"
  }).join(',\n')

  fs.writeFileSync(OUT, head + body + '\n]\n', 'utf8')

  console.log('=== 导入完成 ===')
  console.log('词条数    : ' + lines.length)
  console.log('有中文释义: ' + withZh + ' (' + (withZh * 100 / Math.max(1, lines.length)).toFixed(1) + '%)')
  console.log('无中文释义: ' + noZh)
  console.log('输出      : ' + OUT)
}

main().catch(function (e) {
  console.error('导入失败: ' + e)
  process.exit(1)
})