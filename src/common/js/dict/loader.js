/******************************************************************************
 * @file        loader.js
 * @description 词典分片加载器：按首字母分片 + 严格串行 + LRU 缓存
 *
 *   ★ 手环内存约束（v0.7 重写原因）
 *     真机反馈：切到「中→马」「英→马」后搜索会重启。
 *     根因有二：
 *       1) 分片曾用 Promise.all 并发加载，一次可能同时解析 9 个分片
 *          （最大分片 140KB，解析后内存膨胀数倍）→ 内存爆掉。
 *       2) zh.txt 解析后占约 5.7MB 堆，与分片叠加超限。
 *     对策：
 *       - 分片加载改为**严格串行队列**，同一时刻只解析一个分片
 *       - LRU 从 3 降到 2，降低常驻内存
 *       - 所有大对象解析后立即释放原始文本引用
 *       - 内存吃紧时主动释放缓存（releaseShards）
 *
 *   分片文件位于包内 /assets/dict/，通过 @system.file.readText 读取
 ******************************************************************************/

import file from '@system.file'

const DICT_ROOT = '/assets/dict/'
const MAX_SHARDS = 2          // 同时驻留的分片数（越小越省内存）

let indexData = null
let shardCache = {}           // { a: {entries, byWord, flat} }
let shardOrder = []           // LRU 顺序，末尾最新
/** 正在加载中的文件，避免同一文件重复排队 */
const pending = {}

/* --------------------------- 串行队列 --------------------------- */

/**
 * 全局串行队列：保证同一时刻只有一个 readText 在跑，
 * 避免多个大文件同时解析导致内存峰值叠加。
 */
let chain = Promise.resolve()

function enqueue(task) {
  const next = chain.then(function () {
    return task()
  }, function () {
    return task()
  })
  // 队列本身永不 reject，避免中断后续任务
  chain = next.then(function () {}, function () {})
  return next
}

/* --------------------------- 底层读取 --------------------------- */

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

function parseJSON(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    console.log('[dict] JSON parse fail: ' + e)
    return null
  }
}

/** 读 + 解析，走串行队列 */
function readJSON(uri) {
  return enqueue(function () {
    return readText(uri).then(function (text) {
      const data = parseJSON(text)
      // 显式断开引用，帮助 GC 尽快回收原始文本
      text = null
      return data
    })
  })
}

/* --------------------------- 索引 --------------------------- */

export function loadIndex() {
  if (indexData) return Promise.resolve(indexData)
  return readJSON(DICT_ROOT + 'index.txt').then(function (data) {
    if (!data) throw new Error('index.txt invalid')
    indexData = data
    console.log('[dict] index total=' + data.total + ' shards=' + data.shardCount)
    return indexData
  })
}

export function getIndexSync() {
  return indexData
}

/* --------------------------- 分片 --------------------------- */

function touchShard(letter) {
  const idx = shardOrder.indexOf(letter)
  if (idx >= 0) shardOrder.splice(idx, 1)
  shardOrder.push(letter)
  while (shardOrder.length > MAX_SHARDS) {
    const drop = shardOrder.shift()
    if (drop !== letter) {
      delete shardCache[drop]
      console.log('[dict] LRU evict ' + drop)
    }
  }
}

function flatKey(s) {
  return String(s || '').replace(/[^a-z0-9]/g, '')
}

function buildShard(letter, list) {
  const byWord = {}
  const flat = []
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (!e || !e.w) continue
    byWord[e.w] = e
    flat.push({ f: flatKey(e.w), e: e })
  }
  return { letter: letter, entries: list, byWord: byWord, flat: flat }
}

/** 正在加载中的分片，避免同一分片重复排队 */
export function loadShard(letter) {
  const key = String(letter || '').toLowerCase()
  if (!key) return Promise.resolve(null)
  if (shardCache[key]) {
    touchShard(key)
    return Promise.resolve(shardCache[key])
  }
  if (pending[key]) return pending[key]

  const p = readJSON(DICT_ROOT + 'ms-' + key + '.txt').then(function (list) {
    const shard = buildShard(key, Array.isArray(list) ? list : [])
    shardCache[key] = shard
    touchShard(key)
    delete pending[key]
    return shard
  }).catch(function (e) {
    console.log('[dict] loadShard ' + key + ' fail: ' + e)
    const empty = buildShard(key, [])
    shardCache[key] = empty
    touchShard(key)
    delete pending[key]
    return empty
  })

  pending[key] = p
  return p
}

/**
 * 批量取多个分片 —— ★ 严格串行，一次只解析一个
 * 取代原先的 Promise.all(letters.map(loadShard))，那是内存爆点。
 * @param {Array<string>} letters 首字母数组
 * @param {function} onEach 每加载完一个分片回调（用于进度提示）
 */
export function loadShardsSerial(letters, onEach) {
  const out = []
  const list = letters.slice()
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
  return shardCache[String(letter || '').toLowerCase()] || null
}

export function normalizeKey(s) {
  return flatKey(s)
}

export function clearShards() {
  shardCache = {}
  shardOrder = []
}

/* --------------------------- 中文反查索引 --------------------------- */

const ZH_MOD = 26           // 分桶模数，与 build-dict.js 保持一致
const zhCache = {}          // { '12': { zh2ms: {...} } } 按桶缓存
const zhOrder = []

/**
 * 中文反查（zh2ms）—— ★ 按「首字码位 % 26」只加载一个小桶（约 18KB）
 * 取代原先 1MB 的整表（解析后 3.5MB 堆），这是切方向搜索重启的主因之一。
 * @param {string} word 中文词（取首字决定桶）
 */
export function loadZhBucket(word) {
  const ch = String(word || '').charAt(0)
  if (!ch) return Promise.resolve({ zh2ms: {} })
  const code = ch.charCodeAt(0)
  if (!(code >= 0x4e00 && code <= 0x9fa5)) return Promise.resolve({ zh2ms: {} })

  const b = String(code % ZH_MOD)
  if (zhCache[b]) return Promise.resolve(zhCache[b])
  const pk = 'zh-' + b
  if (pending[pk]) return pending[pk]

  const p = readJSON(DICT_ROOT + pk + '.txt').then(function (data) {
    const v = data && typeof data === 'object' ? data : { zh2ms: {} }
    if (!v.zh2ms) v.zh2ms = {}
    zhCache[b] = v
    const idx = zhOrder.indexOf(b)
    if (idx >= 0) zhOrder.splice(idx, 1)
    zhOrder.push(b)
    while (zhOrder.length > 3) {
      const drop = zhOrder.shift()
      if (drop !== b) delete zhCache[drop]
    }
    delete pending[pk]
    return v
  }).catch(function (e) {
    console.log('[dict] loadZhBucket ' + b + ' fail: ' + e)
    const empty = { zh2ms: {} }
    zhCache[b] = empty
    delete pending[pk]
    return empty
  })

  pending[pk] = p
  return p
}

/**
 * 串行加载多个中文桶（拆字取并集时需要多个字）
 * @param {Array<string>} buckets 桶号数组（如 ['12','7']），由调用方算好
 */
export function loadZhBuckets(buckets) {
  const list = (buckets || []).slice()
  const out = []
  let i = 0
  function step() {
    if (i >= list.length) return Promise.resolve(out)
    const b = list[i]
    i++
    return loadZhBucketByBucket(b).then(function (v) {
      out.push(v)
      return step()
    })
  }
  return step()
}

/** 按桶号直接加载（内部用） */
export function loadZhBucketByBucket(b) {
  const key = String(b)
  if (zhCache[key]) return Promise.resolve(zhCache[key])
  const pk = 'zh-' + key
  if (pending[pk]) return pending[pk]
  const p = readJSON(DICT_ROOT + pk + '.txt').then(function (data) {
    const v = data && typeof data === 'object' ? data : { zh2ms: {} }
    if (!v.zh2ms) v.zh2ms = {}
    zhCache[key] = v
    const idx = zhOrder.indexOf(key)
    if (idx >= 0) zhOrder.splice(idx, 1)
    zhOrder.push(key)
    while (zhOrder.length > 3) {
      const drop = zhOrder.shift()
      if (drop !== key) delete zhCache[drop]
    }
    delete pending[pk]
    return v
  }).catch(function () {
    const empty = { zh2ms: {} }
    zhCache[key] = empty
    delete pending[pk]
    return empty
  })
  pending[pk] = p
  return p
}

/* --------------------------- 拼音索引 --------------------------- */

const pyCache = {}          // { c: { py: {...} } } 按首字母缓存
const pyOrder = []

/**
 * 拼音索引 —— ★ 按首字母只加载一个小文件
 * 查 `chi` 只读 py-c.txt（约 20KB），不再解析 1MB 的整表。
 * @param {string} pinyin 已规范化的拼音（纯 a-z）
 */
export function loadPinyin(pinyin) {
  const key = String(pinyin || '').charAt(0).toLowerCase()
  if (!key || key < 'a' || key > 'z') return Promise.resolve({ py: {} })
  if (pyCache[key]) return Promise.resolve(pyCache[key])
  if (pending['py-' + key]) return pending['py-' + key]

  const p = readJSON(DICT_ROOT + 'py-' + key + '.txt').then(function (data) {
    const v = data && typeof data === 'object' ? data : { py: {} }
    if (!v.py) v.py = {}
    // 只缓存最近 2 个字母的拼音表
    pyCache[key] = v
    const idx = pyOrder.indexOf(key)
    if (idx >= 0) pyOrder.splice(idx, 1)
    pyOrder.push(key)
    while (pyOrder.length > 2) {
      const drop = pyOrder.shift()
      if (drop !== key) delete pyCache[drop]
    }
    delete pending['py-' + key]
    return v
  }).catch(function (e) {
    console.log('[dict] loadPinyin ' + key + ' fail: ' + e)
    const empty = { py: {} }
    pyCache[key] = empty
    delete pending['py-' + key]
    return empty
  })

  pending['py-' + key] = p
  return p
}

/* --------------------------- 英文索引 --------------------------- */

const enCache = {}          // { e: { en2ms: {...} } } 按首字母缓存
const enOrder = []

/**
 * 英文索引 —— ★ 按首字母只加载一个小文件（约 12KB）
 * 取代原先 251KB 的 en.txt 整表。
 * @param {string} word 英文词
 */
export function loadEn(word) {
  const key = String(word || '').charAt(0).toLowerCase()
  if (!key || key < 'a' || key > 'z') return Promise.resolve({ en2ms: {} })
  if (enCache[key]) return Promise.resolve(enCache[key])
  const pk = 'en-' + key
  if (pending[pk]) return pending[pk]

  const p = readJSON(DICT_ROOT + pk + '.txt').then(function (data) {
    const v = data && typeof data === 'object' ? data : { en2ms: {} }
    if (!v.en2ms) v.en2ms = {}
    enCache[key] = v
    const idx = enOrder.indexOf(key)
    if (idx >= 0) enOrder.splice(idx, 1)
    enOrder.push(key)
    while (enOrder.length > 2) {
      const drop = enOrder.shift()
      if (drop !== key) delete enCache[drop]
    }
    delete pending[pk]
    return v
  }).catch(function (e) {
    console.log('[dict] loadEn ' + key + ' fail: ' + e)
    const empty = { en2ms: {} }
    enCache[key] = empty
    delete pending[pk]
    return empty
  })

  pending[pk] = p
  return p
}

/** 兼容旧接口（一次性加载多个首字母，串行） */
export function loadEnBuckets(letters) {
  const out = []
  const list = letters.slice()
  let i = 0
  function step() {
    if (i >= list.length) return Promise.resolve(out)
    const l = list[i]
    i++
    return loadEn(l + 'a').then(function (v) {
      out.push(v)
      return step()
    })
  }
  return step()
}

/* --------------------------- 内存管理 --------------------------- */

/**
 * 释放分片缓存（保留索引）
 * 手环内存吃紧时调用，代价是下次查词要重新读分片。
 */
export function releaseShards() {
  clearShards()
  console.log('[dict] shards released')
}
/**
 * ★ 全量释放（页面离开时调用）
 * v0.11 修复：原来只清分片缓存，中文桶/拼音/英文表会一直驻留，
 * 反复进出页面后常驻内存持续上涨 —— 这是「用久了变卡/重启」的隐性原因。
 */
export function releaseAll() {
  shardCache = {}
  shardOrder = []
  for (const k in zhCache) delete zhCache[k]
  for (const k in pyCache) delete pyCache[k]
  for (const k in enCache) delete enCache[k]
  for (const k in pending) delete pending[k]
  zhOrder.length = 0
  pyOrder.length = 0
  enOrder.length = 0
  console.log('[dict] all caches released')
}
/**
 * 完全释放（切页/退出时调用）
 */
export function release() {
  releaseAll()
}