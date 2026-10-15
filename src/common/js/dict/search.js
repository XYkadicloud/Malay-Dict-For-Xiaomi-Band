/******************************************************************************
 * @file        search.js
 * @description 搜索 v0.14 —— 全部走 loader 的原生文本原语
 *
 * ── 设计原则（依据真机实测）──
 *   · 原生字符串搜索 ≈ 0.1ms；JS 循环 8μs/步；对象属性查找 45.3μs
 *   → 热路径只允许「原生调用」，禁止 JS 循环扫描 / JSON.parse / sort
 *
 * ── 与 v0.13 的差别 ──
 *   v0.13：加载时 JSON.parse + flatKey 正则 + Array.sort（每个分片 3~6 万次比较）
 *          → 加载一个分片要几百毫秒，查找再快也没用
 *   v0.14：加载 = 1 次 readText（整块字符串）
 *          查找 = 1 次 indexOf（原生）+ 少量 slice
 *
 * ── 各方向实现 ──
 *   ms2zh / zh2ms / en2ms : 文本 indexOf + 行解析
 *   zh2en / en2zh         : 文本 indexOf + 行解析
 ******************************************************************************/

import * as loader from './loader.js'

const MAX_CANDIDATE = 12
const MAX_UNION = 30       // 拆字并集上限
const MAX_COLLECT = 50
export const PAGE_SIZE = 10

export const MODE_MS2ZH = 'ms2zh'
export const MODE_ZH2MS = 'zh2ms'
export const MODE_EN2MS = 'en2ms'
export const MODE_ZH2EN = 'zh2en'
export const MODE_EN2ZH = 'en2zh'

const ZH_MOD = 128

/** 中文首字 → zh 桶号 */
function zhBucketOf(ch) {
  return String(ch.charCodeAt(0) % ZH_MOD)
}

/* --------------------------- 规范化 --------------------------- */

export function normalize(text) {
  if (!text) return ''
  return String(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

/** 拼音专用：只保留 a-z */
export function normalizePy(text) {
  if (!text) return ''
  return String(text).toLowerCase().replace(/[^a-z]/g, '')
}

/* --------------------------- 模糊匹配（仅兜底） --------------------------- */

export function dameraLevenshtein(a, b, max) {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  if (a === b) return 0

  let prev2 = null
  let prev = []
  for (let j = 0; j <= lb; j++) prev[j] = j

  for (let i = 1; i <= la; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= lb; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
        const d = prev2[j - 2] + 1
        if (d < v) v = d
      }
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[lb]
}

/* --------------------------- 行解析助手 --------------------------- */

/** 拆值列表 "a,b,c" → ['a','b','c'] */
function splitList(v) {
  if (!v) return []
  return String(v).indexOf(',') < 0 ? [v] : v.split(',')
}

/**
 * ★ 把 "makan|v" 形式的列表转成显示行
 * 词性内嵌在桶里，所以列表查询**不需要再读 ms 分片**
 * （这是 zh2ms / en2ms 从 200ms+ 降到 ~10ms 的关键）
 */
function toRows(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (!s) continue
    const bar = s.indexOf('|')
    if (bar < 0) out.push({ w: s, p: '' })
    else out.push({ w: s.slice(0, bar), p: s.slice(bar + 1) })
  }
  return out
}

/**
 * 把 ms 行转成「显示词条」
 * 行格式：flatkey \t word \t pos \t zh \t en \t ms \t ex \t syn \t ant
 */
function msRow(line) {
  const c = line.split('\t')
  return { w: c[1] || c[0], p: c[2] || '' }
}

/* --------------------------- 马来语 → 中文 --------------------------- */

/**
 * 搜索马来语词条
 * 顺序：精确（原生 indexOf）→ 前缀（定位后顺行）→ 模糊（仅前两者皆空）
 */
export function searchMalay(query, page, pageSize) {
  const norm = normalize(query)
  if (!norm) return Promise.resolve([])
  const ps = pageSize || PAGE_SIZE
  const p = page && page > 0 ? page : 1
  const want = p * ps + 1

  return loader.loadShardByFlat(norm).then(function (shard) {
    const out = []
    const seen = {}
    const push = function (e) {
      if (!e || !e.w || seen[e.w]) return
      seen[e.w] = 1
      out.push(e)
    }

    // ① 精确命中（原生 indexOf，O(1) 级）
    push(loader.lookupShard(shard, norm))

    // ② 前缀命中（有序文件前缀连续，定位后顺行）
    if (out.length < want) {
      const more = loader.collectShardPrefix(shard, norm, want - out.length + 8)
      for (let i = 0; i < more.length && out.length < want; i++) push(more[i])
    }

    // ③ 模糊命中（仅当前两者皆空；扫全片但只在无结果时发生）
    if (out.length === 0 && norm.length >= 3 && shard && shard.text) {
      const lines = shard.text.split('\n')
      for (let i = 0; i < lines.length && out.length < want; i++) {
        const line = lines[i]
        if (!line) continue
        const t = line.indexOf('\t')
        const f = t < 0 ? line : line.slice(0, t)
        if (Math.abs(f.length - norm.length) > 1) continue
        if (dameraLevenshtein(f, norm, 1) <= 1) push(msRow(line))
      }
    }
    return out
  })
}

/* --------------------------- 拼音反查 --------------------------- */

/**
 * 拼音 → 汉字候选
 * 行格式：pinyin \t 字1,字2,...
 */
export function searchPinyin(pinyin) {
  const norm = normalizePy(pinyin)
  if (!norm) return Promise.resolve([])

  return loader.loadPinyin(norm).then(function (rec) {
    const out = []
    const seen = {}
    const push = function (w) {
      if (!w || seen[w]) return
      seen[w] = 1
      out.push(w)
    }
    const pushList = function (v) {
      const arr = splitList(v)
      for (let i = 0; i < arr.length; i++) {
        push(arr[i])
        if (out.length >= MAX_CANDIDATE) return
      }
    }

    // ① 精确（原生 indexOf）
    const ex = loader.lookupValue(rec, norm)
    if (ex != null) pushList(ex)
    if (out.length >= MAX_CANDIDATE) return out.slice(0, MAX_CANDIDATE)

    // ② 前缀（有序文件，定位后顺行）
    const pairs = loader.prefixPairs(rec, norm, 24)
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i][0] === norm) continue
      pushList(pairs[i][1])
      if (out.length >= MAX_CANDIDATE) return out.slice(0, MAX_CANDIDATE)
    }

    // ③ 模糊（仅前两者皆空）
    if (out.length === 0 && norm.length >= 3 && rec && rec.text) {
      const lines = rec.text.split('\n')
      for (let i = 0; i < lines.length && out.length < MAX_CANDIDATE; i++) {
        const line = lines[i]
        if (!line) continue
        const t = line.indexOf('\t')
        const k = t < 0 ? line : line.slice(0, t)
        if (Math.abs(k.length - norm.length) > 1) continue
        if (dameraLevenshtein(k, norm, 1) <= 1) pushList(t < 0 ? '' : line.slice(t + 1))
      }
    }
    return out.slice(0, MAX_CANDIDATE)
  })
}

/* --------------------------- 英文 → 马来语 --------------------------- */

/**
 * 英文 → 马来语（★ 词性内嵌，零额外分片读取）
 * 行格式：english \t 马来语|词性,...
 */
export function searchEnglish(word, onProgress, limit) {
  const w = normalize(word)
  if (!w) return Promise.resolve([])
  const cap = (limit && limit > 0) ? limit : MAX_COLLECT

  return loader.loadEn(w).then(function (rec) {
    const list = []
    const seen = {}
    const push = function (v) {
      if (!v || seen[v]) return
      seen[v] = 1
      list.push(v)
    }
    const pushList = function (v) {
      const arr = splitList(v)
      for (let i = 0; i < arr.length && list.length < cap; i++) push(arr[i])
    }

    // ① 精确
    const ex = loader.lookupValue(rec, w)
    if (ex != null) pushList(ex)

    // ② 前缀（有序文件，定位后顺行）
    if (list.length === 0) {
      const pairs = loader.prefixPairs(rec, w, 16)
      for (let i = 0; i < pairs.length && list.length < cap; i++) pushList(pairs[i][1])
    }
    // ★ 词性已内嵌 → 直接转行
    return toRows(list)
  })
}

/* --------------------------- 中文 → 马来语 --------------------------- */

/**
 * 汉字 → 马来语词条（★ 词性内嵌，零额外分片读取）
 * 行格式：中文词 \t 马来语|词性,马来语|词性,...
 *   1) 完整词命中（只查「首字所属桶」，1 次原生 indexOf）
 *   2) 无完整命中 → 逐字取并集（每字查自己的桶）
 */
export function searchChinese(word, onProgress, limit) {
  const w = String(word || '').trim()
  if (!w) return Promise.resolve([])

  // 人工修正表（带词性，避免再读分片）
  const fixed = ZH_OVERRIDE[w]
  if (fixed) {
    const cap0 = (limit && limit > 0) ? limit : fixed.length
    return Promise.resolve(fixed.slice(0, cap0).map(function (s) {
      const bar = s.indexOf('|')
      return bar < 0 ? { w: s, p: '' } : { w: s.slice(0, bar), p: s.slice(bar + 1) }
    }))
  }

  const chars = w.match(/[\u4e00-\u9fa5]/g) || []
  if (!chars.length) return Promise.resolve([])

  const need = []
  for (let i = 0; i < chars.length && need.length < 4; i++) {
    const b = zhBucketOf(chars[i])
    if (need.indexOf(b) === -1) need.push(b)
  }

  return loader.loadZhBuckets(need).then(function (recs) {
    const bucketRec = function (b) {
      const i = need.indexOf(b)
      return i >= 0 ? recs[i] : null
    }

    // ① 完整匹配（只查整词首字所属桶，1 次原生 indexOf）
    const firstRec = bucketRec(zhBucketOf(chars[0]))
    const exactVal = loader.lookupValue(firstRec, w)
    const exact = exactVal != null ? splitList(exactVal) : []

    const seen = {}
    for (let i = 0; i < exact.length; i++) seen[exact[i]] = 1

    // ② 无完整匹配 → 逐字并集（每字 1 次 indexOf）
    const union = []
    if (exact.length === 0) {
      for (let ci = 0; ci < chars.length && union.length < MAX_UNION; ci++) {
        const rec = bucketRec(zhBucketOf(chars[ci]))
        const v = loader.lookupValue(rec, chars[ci])
        if (v == null) continue
        const list = splitList(v)
        for (let j = 0; j < list.length && union.length < MAX_UNION; j++) {
          const t = list[j]
          if (seen[t]) continue
          seen[t] = 1
          union.push(t)
        }
      }
    }

    const all = exact.concat(union)
    if (!all.length) return []
    const cap = (limit && limit > 0) ? limit : all.length
    // ★ 词性已内嵌 → 直接转行，不再读 ms 分片
    return toRows(all.slice(0, cap))
  })
}

/* --------------------------- 人工修正表 --------------------------- */

const ZH_OVERRIDE = {
  '书': ['buku|n', 'kitab|n'],
  '书籍': ['buku|n', 'kitab|n'],
  '书本': ['buku|n'],
  '蓝色': ['biru|adj'],
  '蓝': ['biru|adj'],
  '红': ['merah|adj'],
  '红色': ['merah|adj'],
  '黄': ['kuning|adj'],
  '黄色': ['kuning|adj'],
  '绿': ['hijau|adj'],
  '绿色': ['hijau|adj'],
  '黑': ['hitam|adj'],
  '黑色': ['hitam|adj'],
  '白': ['putih|adj'],
  '白色': ['putih|adj']
}

/* --------------------------- 中文 ⇄ 英文（CC-CEDICT） --------------------------- */

/**
 * 中文 → 英文（行格式：中文词 \t 英文1,英文2,...）
 */
export function searchZh2En(text) {
  const q = String(text || '').trim()
  if (!q) return Promise.resolve([])

  return loader.loadZeZh(q).then(function (rec) {
    const list = []
    const seen = {}
    const push = function (v) {
      if (!v || seen[v]) return
      seen[v] = 1
      list.push(v)
    }
    const pushVal = function (v) {
      const arr = splitList(v)
      for (let i = 0; i < arr.length && list.length < 10; i++) push(arr[i])
    }

    // ① 整词精确
    const ex = loader.lookupValue(rec, q)
    if (ex != null) pushVal(ex)

    // ② 前缀（有序文件，定位后顺行）
    if (list.length === 0) {
      const pairs = loader.prefixPairs(rec, q, 12)
      for (let i = 0; i < pairs.length && list.length < 10; i++) {
        if (pairs[i][0] === q) continue
        pushVal(pairs[i][1])
      }
    }

    const out = []
    for (let i = 0; i < list.length && out.length < 10; i++) {
      out.push({ w: list[i], zh: q, en: '', p: '' })
    }
    return out
  })
}

/**
 * 英文 → 中文（行格式：english \t 中文1,中文2,...）
 */
export function searchEn2Zh(text) {
  const q = normalize(text)
  if (!q) return Promise.resolve([])

  return loader.loadZeEn(q).then(function (rec) {
    const list = []
    const seen = {}
    const push = function (v) {
      if (!v || seen[v]) return
      seen[v] = 1
      list.push(v)
    }
    const pushVal = function (v) {
      const arr = splitList(v)
      for (let i = 0; i < arr.length && list.length < 10; i++) push(arr[i])
    }

    const ex = loader.lookupValue(rec, q)
    if (ex != null) pushVal(ex)

    if (list.length === 0) {
      const pairs = loader.prefixPairs(rec, q, 12)
      for (let i = 0; i < pairs.length && list.length < 10; i++) {
        if (pairs[i][0] === q) continue
        pushVal(pairs[i][1])
      }
    }

    const out = []
    for (let i = 0; i < list.length && out.length < 10; i++) {
      out.push({ w: list[i], zh: list[i], en: q, p: '' })
    }
    return out
  })
}

/* --------------------------- 统一入口 --------------------------- */

const HANZI_RE = /[\u4e00-\u9fa5]/

export function hasHanzi(text) {
  return HANZI_RE.test(String(text || ''))
}

/** 自动识别检索方向 */
export function autoSearch(query) {
  const q = String(query || '').trim()
  if (!q) return Promise.resolve({ type: 'none', rows: [], cands: [] })

  if (hasHanzi(q)) {
    return searchChinese(q).then(function (rows) {
      return { type: 'zh', rows: rows || [], cands: [] }
    }).catch(function () {
      return { type: 'zh', rows: [], cands: [] }
    })
  }

  // ★ 串行替代 Promise.all：避免两个分片同时驻留
  return searchMalay(q).catch(function () { return [] }).then(function (rows) {
    return searchPinyin(q).catch(function () { return [] }).then(function (cands) {
      return { type: 'ms', rows: rows || [], cands: cands || [] }
    })
  })
}

/** 按模式查询（统一入口） */
export function queryByMode(q, mode, onProgress, page, pageSize) {
  const s = String(q || '').trim()
  if (!s) return Promise.resolve({ rows: [], cands: [] })
  const p = page && page > 0 ? page : 1
  const ps = (pageSize && pageSize > 0) ? pageSize : PAGE_SIZE
  const limit = p * ps + 1

  const wrapRows = function (pr) {
    return pr.then(function (rows) {
      return { rows: rows || [], cands: [] }
    }).catch(function () {
      return { rows: [], cands: [] }
    })
  }

  if (mode === MODE_ZH2MS) {
    if (!hasHanzi(s)) {
      return searchPinyin(s).then(function (cands) {
        return { rows: [], cands: cands || [] }
      }).catch(function () {
        return { rows: [], cands: [] }
      })
    }
    return wrapRows(searchChinese(s, onProgress, limit))
  }
  if (mode === MODE_EN2MS) return wrapRows(searchEnglish(s, onProgress, limit))
  if (mode === MODE_ZH2EN) return wrapRows(searchZh2En(s))
  if (mode === MODE_EN2ZH) return wrapRows(searchEn2Zh(s))
  return wrapRows(searchMalay(s, p, ps))
}

/** ★ 分页查询（真分页） */
export function queryPaged(q, mode, page, onProgress, pageSize) {
  const p = page && page > 0 ? page : 1
  const ps = (pageSize && pageSize > 0) ? pageSize : PAGE_SIZE
  return queryByMode(q, mode, onProgress, p, ps).then(function (res) {
    const r = res || { rows: [], cands: [] }
    const all = r.rows || []
    const from = (p - 1) * ps
    return {
      rows: all.slice(from, from + ps),
      cands: r.cands || [],
      total: all.length,
      hasMore: all.length > p * ps,
      hasPrev: p > 1
    }
  })
}

/* --------------------------- 多方向抽词（每日学习） --------------------------- */

/**
 * ★ 按方向随机抽词（每日学习用）
 *   zh2ms : 从 zh 桶抽中文词，带马来语释义 + 词性
 *   zh2en : 从 ze-zh 桶抽中文词，带英文释义
 *   ms2zh : 从 ms 分片抽马来语词（旧行为，保留）
 *
 * 设计：候选桶只随机取 3~4 个，命中即停 —— 不做全表扫描（手环算力约束）。
 * @returns {Promise<Array<{w, zh, en, p, mode}>>}
 *   w = 题干（该方向要看的词）；ans = 答案（该方向要学的词）
 */
export function randomWordsByMode(mode, count, exclude) {
  const n = (count && count > 0) ? count : 10
  const skip = {}
  if (exclude) {
    for (let i = 0; i < exclude.length; i++) skip[String(exclude[i])] = 1
  }

  if (mode === MODE_ZH2MS) return randomZh(n, 'loadedMs', skip)
  if (mode === MODE_ZH2EN) return randomZh(n, 'loadedEn', skip)
  // 默认：旧行为（马→中）
  return randomWords(n, exclude)
}

/**
 * 抽中文词。
 * @param {string} which 'loadedMs' → 答案取马来语；'loadedEn' → 答案取英文
 */
function randomZh(n, which, skip) {
  return loader.loadIndex().then(function () {
    const bucketCount = which === 'loadedEn' ? 128 : 128
    // 随机取桶，最多试 6 个；命中够就停
    const tried = {}
    const out = []
    const seen = {}
    let attempts = 0
    const MAX_TRIES = 6

    function step() {
      if (out.length >= n || attempts >= MAX_TRIES) {
        return Promise.resolve(shuffle(out).slice(0, n))
      }
      attempts++
      let b = -1
      for (let i = 0; i < 8; i++) {
        const c = Math.floor(Math.random() * bucketCount)
        if (!tried[c]) { tried[c] = 1; b = c; break }
      }
      if (b < 0) return Promise.resolve(shuffle(out).slice(0, n))

      const loaderFn = which === 'loadedEn' ? loader.loadZeZhByBucket : loader.loadZhBucketByBucket
      return loaderFn(b).then(function (rec) {
        if (rec && rec.text) {
          collectZhFromText(rec.text, which, n, skip, seen, out)
        }
        return step()
      }).catch(function () {
        return step()
      })
    }
    return step()
  }).catch(function (e) {
    console.log('[search] randomZh fail: ' + e)
    return []
  })
}

/** 从桶文本里随机起跳取样中文词 */
function collectZhFromText(text, which, n, skip, seen, out) {
  const lines = text.split('\n')
  if (!lines.length) return
  const start = Math.floor(Math.random() * lines.length)
  for (let off = 0; off < lines.length && out.length < n; off++) {
    const line = lines[(start + off) % lines.length]
    if (!line) continue
    const t = line.indexOf('\t')
    if (t < 0) continue
    const zh = line.slice(0, t)
    const val = line.slice(t + 1)
    if (!zh || !val) continue
    if (skip[zh] || seen[zh]) continue
    seen[zh] = 1

    if (which === 'loadedEn') {
      // ze-zh 桶：第二列是英文列表，取第一个
      const first = val.split(',')[0]
      if (!first) continue
      out.push({ w: zh, zh: zh, en: first, p: '', mode: 'zh2en', ans: first })
    } else {
      // zh 桶：第二列是 "马来语|词性" 列表，取第一个
      const first = val.split(',')[0]
      const bar = first.indexOf('|')
      const ms = bar < 0 ? first : first.slice(0, bar)
      const p = bar < 0 ? '' : first.slice(bar + 1)
      if (!ms) continue
      out.push({ w: zh, zh: zh, en: '', p: p, mode: 'zh2ms', ans: ms })
    }
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

/* --------------------------- 多方向出题（复习测验） --------------------------- */

/**
 * ★ 按方向出选择题
 *   ms2zh : 题干马来语 → 选中文
 *   zh2ms : 题干中文   → 选马来语
 *   zh2en : 题干中文   → 选英文        ← 新增
 *   en2ms : 题干英文   → 选马来语
 *
 * @returns {Promise<{stem, opts, answer, entry}|null>}
 */
export function makeQuestionByMode(word, mode) {
  const w = String(word || '').trim()
  if (!w) return Promise.resolve(null)

  if (mode === MODE_ZH2EN) return makeZhQuestion(w, 'en')
  if (mode === MODE_ZH2MS) return makeZhQuestion(w, 'ms')
  return makeQuestion(w, mode)
}

/**
 * 中文题干出题：干扰项从「同一个中文桶」取，零额外 IO。
 * @param {string} which 'en' → 答案英文；'ms' → 答案马来语
 */
function makeZhQuestion(zh, which) {
  const bucket = which === 'en'
    ? loader.loadZeZhByBucket(zhBucketOf(zh.charAt(0)))
    : loader.loadZhBucket(zh)

  return bucket.then(function (rec) {
    if (!rec || !rec.text) return null
    const myVal = loader.lookupValue(rec, zh)
    if (myVal == null) return null

    // 自己的答案
    let myAnswer = ''
    if (which === 'en') {
      myAnswer = myVal.split(',')[0] || ''
    } else {
      const first = myVal.split(',')[0]
      const bar = first.indexOf('|')
      myAnswer = bar < 0 ? first : first.slice(0, bar)
    }
    if (!myAnswer) return null

    // 干扰项：同桶内其它中文词的答案
    const lines = rec.text.split('\n')
    const start = Math.floor(Math.random() * lines.length)
    const pool = []
    for (let off = 0; off < lines.length && pool.length < 40; off++) {
      const line = lines[(start + off) % lines.length]
      if (!line) continue
      const t = line.indexOf('\t')
      if (t < 0) continue
      const k = line.slice(0, t)
      const v = line.slice(t + 1)
      if (!k || k === zh || !v) continue
      let a = ''
      if (which === 'en') {
        a = v.split(',')[0] || ''
      } else {
        const f = v.split(',')[0]
        const bar = f.indexOf('|')
        a = bar < 0 ? f : f.slice(0, bar)
      }
      if (!a || a === myAnswer) continue
      if (pool.indexOf(a) === -1) pool.push(a)
    }
    if (pool.length < 2) return null

    shuffle(pool)
    const opts = [myAnswer].concat(pool.slice(0, 2))
    shuffle(opts)
    return {
      stem: zh,
      opts: opts,
      answer: myAnswer,
      entry: { w: which === 'en' ? myAnswer : zh, zh: zh, en: which === 'en' ? myAnswer : '', p: '' }
    }
  }).catch(function (e) {
    console.log('[quiz] makeZhQuestion fail: ' + e)
    return null
  })
}

/**
 * 随机取词（每日学习用）
 * ★ 读分片文本后按行取样，只解析命中的行
 */
export function randomWords(n, exclude) {
  const count = n || 5
  const skip = {}
  if (exclude) {
    for (let i = 0; i < exclude.length; i++) skip[exclude[i]] = 1
  }
  return loader.loadIndex().then(function (idx) {
    const letters = (idx && idx.letters) ? idx.letters.slice() : []
    if (!letters.length) return []
    const pool = letters.slice()
    const cand = []
    const seen = {}
    let tried = 0
    const MAX_TRY = 4

    function step() {
      if (cand.length >= count || tried >= MAX_TRY || pool.length === 0) {
        for (let i = cand.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          const t = cand[i]; cand[i] = cand[j]; cand[j] = t
        }
        return Promise.resolve(cand.slice(0, count))
      }
      tried++
      const k = Math.floor(Math.random() * pool.length)
      const key = pool[k]
      pool.splice(k, 1)
      return loader.loadShardByKey(key).then(function (shard) {
        if (shard && shard.text) {
          // ★ 随机起跳取样，避免每次都从头解析（也更随机）
          const lines = shard.text.split('\n')
          const total = lines.length
          if (total > 0) {
            const start = Math.floor(Math.random() * total)
            for (let off = 0; off < total && cand.length < count * 3; off++) {
              const line = lines[(start + off) % total]
              if (!line) continue
              const c = line.split('\t')
              const w = c[1] || c[0]
              const zh = c[3]
              if (!w || !zh || skip[w] || seen[w]) continue
              seen[w] = 1
              cand.push({ w: w, p: c[2] || '', zh: zh, en: c[4] || '', ms: c[5] || '' })
            }
          }
        }
        return step()
      })
    }
    return step()
  }).catch(function (e) {
    console.log('[search] randomWords fail: ' + e)
    return []
  })
}

/** 按词取词条（详情页用） */
export function getEntry(word) {
  const norm = normalize(word)
  if (!norm) return Promise.resolve(null)
  return loader.loadShardByFlat(norm).then(function (shard) {
    return loader.lookupShard(shard, norm)
  })
}

/** 统一入口（旧接口保留） */
export function search(query, mode) {
  if (!query) return Promise.resolve([])
  if (mode === MODE_ZH2MS) return searchPinyin(query)
  return searchMalay(query)
}

/**
 * ★ 生成一道选择题（quiz 页用）
 * 干扰项从「答案所在分片」取 —— 该分片已在内存，零额外 IO。
 */
export function makeQuestion(word, mode) {
  const w = String(word || '').trim()
  if (!w) return Promise.resolve(null)
  return loader.loadShardByFlat(loader.flatKey(w)).then(function (shard) {
    if (!shard || !shard.text) return null
    const correct = loader.lookupShard(shard, w)
    if (!correct) return null

    const askMalay = (mode !== 'ms2zh')
    const stem = (mode === 'zh2ms') ? (correct.zh || '')
      : (mode === 'en2ms') ? (correct.en || '')
      : correct.w
    if (!stem) return null

    // ★ 干扰项：随机起跳取样（避免每次都从片头扫）
    const lines = shard.text.split('\n')
    const total = lines.length
    const pool = []
    const start = total > 0 ? Math.floor(Math.random() * total) : 0
    for (let off = 0; off < total && pool.length < 40; off++) {
      const line = lines[(start + off) % total]
      if (!line) continue
      const c = line.split('\t')
      const ew = c[1] || c[0]
      if (!ew || ew === correct.w) continue
      if (!c[3]) continue
      if (mode === 'en2ms' && !c[4]) continue
      if (Math.abs(ew.length - correct.w.length) > 3) continue
      pool.push({ w: ew, zh: c[3], en: c[4] || '', p: c[2] || '' })
    }

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t
    }
    const distract = pool.slice(0, 2)
    if (distract.length < 2) return null

    const text = function (e) {
      return askMalay ? e.w : (e.zh || '')
    }
    const opts = [correct].concat(distract).map(text)
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = opts[i]; opts[i] = opts[j]; opts[j] = t
    }
    return { stem: stem, opts: opts, answer: text(correct), entry: correct }
  }).catch(function (e) {
    console.log('[quiz] makeQuestion fail: ' + e)
    return null
  })
}

/* --------------------------- 内存释放 --------------------------- */

/** ★ 轻度释放（onHide）：只丢大件，保留常用马来语分片 */
export function releaseShards() {
  loader.trim()
}

/** ★ 全量释放（onDestroy） */
export function releaseAll() {
  loader.releaseAll()
}

/** 调试用：当前缓存占用 */
export function cacheStats() {
  return loader.cacheStats()
}