/******************************************************************************
 * @file        loader.js
 * @description 词典加载器 v0.14 —— 行式纯文本 + 原生 indexOf
 *
 * ── 依据《小米手环 9 真机实测数据》 ──
 *   · JSON 解析后内存膨胀 5.7x；纯文本仅 0.74x
 *   · 原生字符串搜索 ≈ 0.1ms；JS 循环每步 ≈ 8μs；对象属性查找 45.3μs
 *   · 单块分配上限 1024KB；JS 堆上限 10~13MB（空载基线 3.46MB）
 *
 * ── v0.13 的致命错误（本轮修正）──
 *   加载分片时对每一条做 flatKey 正则，再 Array.sort（带 JS 回调）。
 *     ms-m  2700 条 → 约 3.1 万次比较 ≈ 250ms
 *     ze-zh-13 4827 条 → 约 5.9 万次比较 ≈ 470ms
 *   → 「越优化越慢」。真正的瓶颈从来不是查找，而是**加载时的解析与排序**。
 *
 * ── v0.14 方案：数据侧预排序，运行时只做原生调用 ──
 *   ① readText 整块读文件（1 次原生调用，不 split）
 *   ② indexOf 直接定位目标行（1 次原生调用，不遍历、不二分）
 *   ③ slice 取行 + split('\t') 解析（仅对命中的 1~N 行）
 *   全程无 JSON.parse、无 sort、无正则、无 JS 循环扫描。
 *
 * ── 行格式（\t 分隔，按第一列升序）──
 *   ms-*.txt    : flatkey \t word \t pos \t zh \t en \t ms \t ex \t syn \t ant
 *   zh-*.txt    : 中文词 \t 马来语1,马来语2,...
 *   ze-zh-*.txt : 中文词 \t 英文1,英文2,...
 *   ze-en-*.txt : english \t 中文1,中文2,...
 *   py-*.txt    : pinyin  \t 字1,字2,...
 *   en-*.txt    : english \t 马来语1,...
 ******************************************************************************/

import file from '@system.file'

const DICT_ROOT = '/assets/dict/'

/** 缓存总预算（估算字节）。超预算自动逐出最久未用项 */
const BUDGET = 3.0 * 1024 * 1024

const NL = 10           // '\n'
const TAB = 9           // '\t'

/* ============================ 串行队列 ============================ */

let chain = Promise.resolve()

/**
 * 全局串行队列：同一时刻只有一个 readText 在跑，
 * 避免多个大文件同时驻留导致内存峰值叠加。
 */
function enqueue(task) {
  const next = chain.then(function () {
    return task()
  }, function () {
    return task()
  })
  chain = next.then(function () {}, function () {})
  return next
}

/* ============================ 底层读取 ============================ */

function readText(uri) {
  return new Promise(function (resolve, reject) {
    try {
      file.readText({
        uri: uri,
        success: function (data) {
          resolve(data && data.text != null ? data.text : '')
        },
        fail: function (data, code) {
          reject(new Error('readText fail ' + code))
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}

/** 整块读文本，返回 { text, bytes }；bytes 为 JS 字符串内存估算（UTF-16） */
function readWhole(uri) {
  return enqueue(function () {
    return readText(uri).then(function (t) {
      const s = t || ''
      return { text: s, bytes: s.length * 2 }
    })
  })
}

/* ============================ 缓存记账 ============================ */

const stores = {
  ms: { map: {}, order: [], max: 3 },
  zh: { map: {}, order: [], max: 4 },
  py: { map: {}, order: [], max: 3 },
  en: { map: {}, order: [], max: 3 },
  zezh: { map: {}, order: [], max: 3 },
  zeen: { map: {}, order: [], max: 3 }
}

let budgetUsed = 0
let lru = []

function dropEntry(s, k) {
  const st = stores[s]
  const rec = st.map[k]
  if (!rec) return
  budgetUsed -= rec.bytes || 0
  if (budgetUsed < 0) budgetUsed = 0
  delete st.map[k]
  const i = st.order.indexOf(k)
  if (i >= 0) st.order.splice(i, 1)
  for (let j = 0; j < lru.length; j++) {
    if (lru[j].s === s && lru[j].k === k) { lru.splice(j, 1); break }
  }
}

function touchStore(s, k) {
  const st = stores[s]
  const i = st.order.indexOf(k)
  if (i >= 0) st.order.splice(i, 1)
  st.order.push(k)
  for (let j = 0; j < lru.length; j++) {
    if (lru[j].s === s && lru[j].k === k) { lru.splice(j, 1); break }
  }
  lru.push({ s: s, k: k })
}

function put(s, k, rec) {
  const st = stores[s]
  if (st.map[k]) { touchStore(s, k); return st.map[k] }
  st.map[k] = rec
  st.order.push(k)
  lru.push({ s: s, k: k })
  budgetUsed += rec.bytes || 0

  while (st.order.length > st.max) dropEntry(s, st.order[0])
  let guard = 0
  while (budgetUsed > BUDGET && lru.length > 0 && guard < 64) {
    guard++
    dropEntry(lru[0].s, lru[0].k)
  }
}

/* ============================ 文本查找原语 ============================ */

/** 扁平键：小写 + 只留 a-z0-9（仅用于用户输入，短字符串） */
export function flatKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 定位「以 key + \t 开头」的那一行，返回行首下标。
 * ★ 只用原生 indexOf；`\n` 前置判定保证是行首而非行中出现。
 */
function findLinePos(text, key) {
  const pat = key + '\t'
  let from = 0
  for (let guard = 0; guard < 8; guard++) {
    const p = text.indexOf(pat, from)
    if (p < 0) return -1
    if (p === 0 || text.charCodeAt(p - 1) === NL) return p
    from = p + 1
  }
  return -1
}

/** 从行首下标读出一整行（不含换行符） */
function readLineAt(text, pos) {
  const e = text.indexOf('\n', pos)
  return e < 0 ? text.slice(pos) : text.slice(pos, e)
}

/** 下一行的行首下标，没有则 -1 */
function nextLinePos(text, pos) {
  const e = text.indexOf('\n', pos)
  return e < 0 ? -1 : e + 1
}

/**
 * 取某键对应的值（第二列）。返回字符串或 null。
 * ★ 1 次 indexOf + 1 次 slice + 1 次 indexOf
 */
export function lookupValue(rec, key) {
  if (!rec || !rec.text || !key) return null
  const p = findLinePos(rec.text, key)
  if (p < 0) return null
  const line = readLineAt(rec.text, p)
  const t = line.indexOf('\t')
  return t < 0 ? '' : line.slice(t + 1)
}

/**
 * 取以 key 开头的若干行（值列表），最多 cap 条。
 * ★ 前缀在有序文件里是连续的：定位首行后逐行前进。
 * @returns {Array<Array<string>>} [[key, value], ...]
 */
export function prefixPairs(rec, key, cap) {
  const out = []
  if (!rec || !rec.text || !key) return out
  const text = rec.text
  let p = -1
  // 第一行（无前导 \n）单独判定
  if (text.indexOf(key) === 0) p = 0
  else {
    const q = text.indexOf('\n' + key)
    if (q >= 0) p = q + 1
  }
  if (p < 0) return out
  while (p >= 0 && out.length < cap) {
    const line = readLineAt(text, p)
    if (line.indexOf(key) !== 0) break
    const t = line.indexOf('\t')
    out.push(t < 0 ? [line, ''] : [line.slice(0, t), line.slice(t + 1)])
    p = nextLinePos(text, p)
  }
  return out
}

/** 解析一条 ms 行 → 词条对象 */
function parseMsLine(line) {
  const c = line.split('\t')
  const e = { w: c[1] || c[0] }
  if (c[2]) e.p = c[2]
  if (c[3]) e.zh = c[3]
  if (c[4]) e.en = c[4]
  if (c[5]) e.ms = c[5]
  if (c[6]) e.ex = c[6]
  if (c[7]) e.syn = c[7].split(',')
  if (c[8]) e.ant = c[8].split(',')
  return e
}

/* ============================ 索引 ============================ */

let indexData = null

/**
 * 读 index.txt（行式：key \t value）。
 * 字段：letters / split2 / total / withZh / withEn / shardCount
 *   letters = ms 分片键列表（randomWords 随机取片用）
 *   split2  = 已下钻到 3 字符的 2 字符前缀（查短输入时要合并）
 */
export function loadIndex() {
  if (indexData) return Promise.resolve(indexData)
  return readWhole(DICT_ROOT + 'index.txt').then(function (r) {
    const text = (r && r.text) || ''
    const lines = text.split('\n')
    const o = { letters: [], split2: [] }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const t = line.indexOf('\t')
      if (t < 0) continue
      const k = line.slice(0, t)
      const v = line.slice(t + 1)
      if (k === 'letters') o.letters = v ? v.split(',') : []
      else if (k === 'split2') o.split2 = v ? v.split(',') : []
      else if (k === 'total') o.total = parseInt(v, 10) || 0
      else if (k === 'withZh') o.withZh = parseInt(v, 10) || 0
      else if (k === 'withEn') o.withEn = parseInt(v, 10) || 0
      else if (k === 'shardCount') o.shardCount = parseInt(v, 10) || 0
    }
    indexData = o
    return indexData
  })
}

export function getIndexSync() {
  return indexData
}

/** 已下钻的 2 字符前缀（同步可查，避免每次等 index） */
let split2Set = null
function isSplit2(k2) {
  if (!split2Set) {
    split2Set = {}
    if (indexData && indexData.split2) {
      for (let i = 0; i < indexData.split2.length; i++) split2Set[indexData.split2[i]] = 1
    }
  }
  return !!split2Set[k2]
}

/* ============================ 马来语分片 ============================ */

const pending = {}

/** 加载指定的 ms 分片文件 */
function loadShardFile(key) {
  const st = stores.ms
  if (st.map[key]) {
    touchStore('ms', key)
    return Promise.resolve(st.map[key])
  }
  const pk = 'ms-' + key
  if (pending[pk]) return pending[pk]

  const p = readWhole(DICT_ROOT + pk + '.txt').then(function (r) {
    const rec = { letter: key, text: (r && r.text) || '', bytes: (r && r.bytes) || 0 }
    delete pending[pk]
    put('ms', key, rec)
    return rec
  }).catch(function (e) {
    console.log('[dict] loadShard ' + key + ' fail: ' + e)
    delete pending[pk]
    const rec = { letter: key, text: '', bytes: 0 }
    put('ms', key, rec)
    return rec
  })

  pending[pk] = p
  return p
}

/**
 * ★ 按「扁平键」定位分片（自动处理 2 字符 / 3 字符两级切分）
 * @param {string} fk 扁平键（小写 a-z0-9）
 * @returns {Promise<{letter,text,bytes}|null>}
 */
export function loadShardByFlat(fk) {
  const k = String(fk || '')
  if (!k) return Promise.resolve(null)
  const k2 = (k + 'a').slice(0, 2)
  if (indexData && isSplit2(k2)) {
    return loadShardFile((k + 'aaa').slice(0, 3))
  }
  // index 未加载时先加载（首次查询的一次性成本）
  if (!indexData) {
    return loadIndex().then(function () {
      return isSplit2(k2) ? loadShardFile((k + 'aaa').slice(0, 3)) : loadShardFile(k2)
    })
  }
  return loadShardFile(k2)
}

/** 兼容旧接口：按「首字母」加载（会做一次 index 查询以确定正确分片） */
export function loadShard(letter) {
  const key = String(letter || '').toLowerCase()
  if (!key) return Promise.resolve(null)
  return loadShardByFlat(key)
}

/** ★ 按「分片键」直接加载（randomWords 用，不推导前缀） */
export function loadShardByKey(key) {
  const k = String(key || '')
  if (!k) return Promise.resolve(null)
  return loadShardFile(k)
}

/**
 * 分片内精确查找。
 * ★ 优先返回原词完全一致的条目（同 flatkey 可能有多条，如 maaf / ma-af）
 */
export function lookupShard(shard, word) {
  if (!shard || !shard.text) return null
  const key = flatKey(word)
  if (!key) return null
  const text = shard.text
  let p = findLinePos(text, key)
  if (p < 0) return null
  let first = null
  for (let guard = 0; guard < 4 && p >= 0; guard++) {
    const line = readLineAt(text, p)
    if (line.indexOf(key + '\t') !== 0) break
    const e = parseMsLine(line)
    if (!first) first = e
    if (e.w === word) return e
    p = nextLinePos(text, p)
  }
  return first
}

/**
 * 分片内前缀收集（有序文件中前缀连续）
 * @param {string} norm 已规范化的前缀（纯 a-z0-9）
 * @param {number} cap 最多收集多少条
 */
export function collectShardPrefix(shard, norm, cap) {
  const out = []
  if (!shard || !shard.text || !norm) return out
  const text = shard.text
  let p = -1
  if (text.indexOf(norm) === 0) p = 0
  else {
    const q = text.indexOf('\n' + norm)
    if (q >= 0) p = q + 1
  }
  if (p < 0) return out
  while (p >= 0 && out.length < cap) {
    const line = readLineAt(text, p)
    if (line.indexOf(norm) !== 0) break
    out.push(parseMsLine(line))
    p = nextLinePos(text, p)
  }
  return out
}

/** 兼容旧接口：串行加载多个分片 */
export function loadShardsSerial(letters, onEach) {
  const out = []
  const list = (letters || []).slice()
  let i = 0
  function step() {
    if (i >= list.length) return Promise.resolve(out)
    const l = list[i]
    i++
    return loadShard(l).then(function (shard) {
      out.push(shard)
      if (onEach) {
        try { onEach(i, list.length) } catch (e) {}
      }
      return step()
    })
  }
  return step()
}

export function getShardSync(letter) {
  return stores.ms.map[String(letter || '').toLowerCase()] || null
}

export function normalizeKey(s) {
  return flatKey(s)
}

export function clearShards() {
  const st = stores.ms
  const ks = st.order.slice()
  for (let i = 0; i < ks.length; i++) dropEntry('ms', ks[i])
}

/* ============================ 通用「文本桶」加载 ============================ */

/**
 * 加载一个行式文本桶（zh / py / en / ze-zh / ze-en 共用）
 * @param {string} store 缓存类别
 * @param {string} file  文件名（不含路径）
 * @param {string} key   缓存键
 */
function loadTextBucket(store, fileName, key) {
  const st = stores[store]
  if (st.map[key]) {
    touchStore(store, key)
    return Promise.resolve(st.map[key])
  }
  const pk = fileName
  if (pending[pk]) return pending[pk]

  const p = readWhole(DICT_ROOT + fileName).then(function (r) {
    const rec = { key: key, text: (r && r.text) || '', bytes: (r && r.bytes) || 0 }
    delete pending[pk]
    put(store, key, rec)
    return rec
  }).catch(function (e) {
    console.log('[dict] load ' + fileName + ' fail: ' + e)
    delete pending[pk]
    const rec = { key: key, text: '', bytes: 0 }
    put(store, key, rec)
    return rec
  })

  pending[pk] = p
  return p
}

/* ============================ 中文反查（zh2ms） ============================ */

const ZH_MOD = 128          // 与 build-v14.py 保持一致

/** 按桶号直接加载 */
export function loadZhBucketByBucket(b) {
  const key = String(b)
  return loadTextBucket('zh', 'zh-' + key + '.txt', key)
}

/** 中文反查（按首字码位 % 128 定位桶） */
export function loadZhBucket(word) {
  const ch = String(word || '').charAt(0)
  if (!ch) return Promise.resolve({ key: '', text: '', bytes: 0 })
  const code = ch.charCodeAt(0)
  if (!(code >= 0x4e00 && code <= 0x9fa5)) return Promise.resolve({ key: '', text: '', bytes: 0 })
  return loadZhBucketByBucket(String(code % ZH_MOD))
}

/** 串行加载多个中文桶 */
export function loadZhBuckets(buckets) {
  const list = (buckets || []).slice()
  const out = []
  let i = 0
  function step() {
    if (i >= list.length) return Promise.resolve(out)
    const b = list[i]
    i++
    return loadZhBucketByBucket(b).then(function (rec) {
      out.push(rec)
      return step()
    })
  }
  return step()
}

/* ============================ 拼音索引 ============================ */

/** 拼音索引（按首字母分片，约 20KB ≈ 8ms） */
export function loadPinyin(pinyin) {
  const key = String(pinyin || '').charAt(0).toLowerCase()
  if (!key) return Promise.resolve({ key: '', text: '', bytes: 0 })
  return loadTextBucket('py', 'py-' + key + '.txt', key)
}

/* ============================ 英文索引（en2ms） ============================ */

/**
 * 英文索引（v0.15：按 1~2 字符分片）
 * 先用 2 字符（en-ab.txt），没有则退回 1 字符（en-a.txt）。
 * 这样分片大小可控，且不需要运行时维护分片清单。
 */
export function loadEn(word) {
  const w = String(word || '').toLowerCase()
  const k1 = w.charAt(0)
  if (!k1 || k1 < 'a' || k1 > 'z') return Promise.resolve({ key: '', text: '', bytes: 0 })
  const k2 = w.charAt(1)
  if (k2 && k2 >= 'a' && k2 <= 'z') {
    const two = k1 + k2
    return loadTextBucket('en', 'en-' + two + '.txt', two).then(function (r) {
      if (r && r.text) return r
      return loadTextBucket('en', 'en-' + k1 + '.txt', k1)
    })
  }
  return loadTextBucket('en', 'en-' + k1 + '.txt', k1)
}

/* ============================ 中英互译（CC-CEDICT） ============================ */

const ZE_MOD = 128          // 与 build-v14.py 保持一致

/** 中文 → 英文 */
export function loadZeZh(text) {
  const ch = String(text || '').charAt(0)
  if (!ch) return Promise.resolve({ key: '', text: '', bytes: 0 })
  const code = ch.charCodeAt(0)
  if (!(code >= 0x4e00 && code <= 0x9fa5)) return Promise.resolve({ key: '', text: '', bytes: 0 })
  return loadZeZhByBucket(String(code % ZE_MOD))
}

/** 中文 → 英文（按桶号直接加载，抽词/出题用） */
export function loadZeZhByBucket(b) {
  const key = String(b)
  return loadTextBucket('zezh', 'ze-zh-' + key + '.txt', key)
}

/** 英文 → 中文（按首字母分片，约 20KB ≈ 8ms） */
export function loadZeEn(text) {
  const key = String(text || '').charAt(0).toLowerCase()
  if (!key) return Promise.resolve({ key: '', text: '', bytes: 0 })
  return loadTextBucket('zeen', 'ze-en-' + key + '.txt', key)
}

/* ============================ 内存管理 ============================ */

/**
 * ★ 轻度释放：丢掉「大件」（中英互译桶 + 中文桶），保留 ms / py / en。
 * 页面 onHide 调用：代价小，且最常用的马来语分片保持温热 → 再次进入更快。
 */
export function trim() {
  const kill = ['zezh', 'zeen', 'zh']
  for (let i = 0; i < kill.length; i++) {
    const s = kill[i]
    const st = stores[s]
    const ks = st.order.slice()
    for (let j = 0; j < ks.length; j++) dropEntry(s, ks[j])
  }
}

/** 释放分片缓存（保留其它索引） */
export function releaseShards() {
  clearShards()
}

/** ★ 全量释放（页面销毁时调用） */
export function releaseAll() {
  for (const s in stores) {
    const st = stores[s]
    const ks = st.order.slice()
    for (let j = 0; j < ks.length; j++) dropEntry(s, ks[j])
  }
  lru = []
  budgetUsed = 0
  for (const k in pending) delete pending[k]
}

export function release() {
  releaseAll()
}

/** 调试用：当前缓存占用 */
export function cacheStats() {
  const out = { budgetKB: Math.round(budgetUsed / 1024) }
  for (const s in stores) out[s] = stores[s].order.length
  return out
}