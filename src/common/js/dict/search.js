/******************************************************************************
 * @file        search.js
 * @description 搜索：马来语精确/前缀/模糊 + 中文拼音反查
 ******************************************************************************/

import * as loader from './loader.js'

const MAX_RESULT = 10        // 单页结果数（列表只显示词+词性，10 条够用）
const MAX_CANDIDATE = 12
const MAX_UNION = 30       // 拆字并集最多收集多少个候选词（防分片爆炸）
const MAX_COLLECT = 50     // 兜底上限（正常路径按 page×10 精确取，不会到 50）
export const PAGE_SIZE = 10 // ★ 每页条数（真分页：一次只取本页所需，不再一次收 50）

export const MODE_MS2ZH = 'ms2zh'
export const MODE_ZH2MS = 'zh2ms'
export const MODE_MS2EN = 'ms2en'

/* --------------------------- 规范化 --------------------------- */

export function normalize(text) {
  if (!text) return ''
  let s = String(text).toLowerCase()
  s = s.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  return s
}

/** 拼音专用：只保留 a-z（丢掉空格、声调符号、数字） */
export function normalizePy(text) {
  if (!text) return ''
  return String(text).toLowerCase().replace(/[^a-z]/g, '')
}

/** 仅保留 a-z0-9，用于匹配含空格/连字符的马来语词 */
function flat(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/* --------------------------- 马来语 → 中文 --------------------------- */
/**
 * 从单个分片收集匹配词条。
 * ★ 累加式取法：limit = page×PAGE_SIZE+1，第 2 页会把第 1 页的结果一起再收一遍
 *   （分片已在内存，重复扫描是纯 JS 循环，代价极低；这样每页都是幂等的完整前缀）
 */
function collectFromShard(shard, norm, limit, fuzzy) {
  const out = []
  if (!shard || !shard.entries) return out
  const seen = {}
  const cap = limit || MAX_COLLECT
  const push = function (e) {
    if (!e || !e.w || seen[e.w]) return
    seen[e.w] = true
    out.push(e)
  }
  const flatList = shard.flat || []
  // 1) 精确命中（含空格/连字符的词按去分隔符形式比较）
  push(shard.byWord[norm])
  for (let i = 0; i < flatList.length; i++) {
    if (flatList[i].f === norm) push(flatList[i].e)
  }
  // 2) 前缀命中
  for (let i = 0; i < flatList.length; i++) {
    const it = flatList[i]
    if (it.f === norm) continue
    if (it.f.indexOf(norm) === 0) {
      push(it.e)
      if (out.length >= cap) break
    }
  }
  // 3) 模糊命中（仅前缀无结果时）
  if (fuzzy && out.length === 0 && norm.length >= 3) {
    for (let i = 0; i < flatList.length; i++) {
      const it = flatList[i]
      if (Math.abs(it.f.length - norm.length) > 1) continue
      if (dameraLevenshtein(it.f, norm, 1) <= 1) {
        push(it.e)
        if (out.length >= cap) break
      }
    }
  }

  return out
}

/**
 * Damerau-Levenshtein 距离，带 early-exit 上限
 */
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

/**
 * 搜索马来语词条
 * @param {string} query 原始输入
 * @returns {Promise<Array>} 词条数组
 */
export function searchMalay(query, page, pageSize) {
  const norm = normalize(query)
  if (!norm) return Promise.resolve([])
  const ps = pageSize || PAGE_SIZE
  const p = page && page > 0 ? page : 1
  // ★ 只取到「本页 + 1 条」为止：+1 用于判断是否还有下一页，绝不一次收 50
  const want = p * ps + 1
  const first = norm.charAt(0)
  return loader.loadShard(first).then(function (shard) {
    let out = collectFromShard(shard, norm, want, false)
    if (out.length > 0) return out
    // 前缀无结果 → 尝试模糊
    return collectFromShard(shard, norm, want, true)
  })
}

/* --------------------------- 中文拼音反查 --------------------------- */

/**
 * 拼音 → 汉字候选
 *   1) 精确命中
 *   2) 前缀命中（pingguo → pingguo…）
 *   3) 模糊命中（pingguo 与 ping guo 等价；容忍 1 处增删改）
 * 输入会先去掉空格/声调，所以「ping guo」「pīngguǒ」都能匹配。
 */
export function searchPinyin(pinyin) {
  const norm = normalizePy(pinyin)
  if (!norm) return Promise.resolve([])

  // ★ 只加载该首字母的拼音小文件（约 20KB），不再解析整表
  return loader.loadPinyin(norm).then(function (data) {
    const py = (data && data.py) || {}
    const out = []
    const seen = {}

    const pushWord = function (w) {
      if (!w || seen[w]) return
      seen[w] = true
      out.push(w)
    }

    // 1) 精确
    const exact = py[norm]
    if (exact) {
      for (let i = 0; i < exact.length; i++) pushWord(exact[i])
    }
    if (out.length >= MAX_CANDIDATE) return out.slice(0, MAX_CANDIDATE)

    // 2) 前缀
    for (const key in py) {
      if (key === norm) continue
      if (key.indexOf(norm) === 0) {
        const arr = py[key] || []
        for (let i = 0; i < arr.length; i++) {
          pushWord(arr[i])
          if (out.length >= MAX_CANDIDATE) return out.slice(0, MAX_CANDIDATE)
        }
      }
    }

    // 3) 模糊（长度差 ≤1，编辑距离 ≤1）
    if (out.length === 0 && norm.length >= 3) {
      for (const key in py) {
        if (Math.abs(key.length - norm.length) > 1) continue
        if (dameraLevenshtein(key, norm, 1) <= 1) {
          const arr = py[key] || []
          for (let i = 0; i < arr.length; i++) {
            pushWord(arr[i])
            if (out.length >= MAX_CANDIDATE) return out.slice(0, MAX_CANDIDATE)
          }
        }
      }
    }

    return out.slice(0, MAX_CANDIDATE)
  })
}

/**
 * 英文 → 马来语词条
 * ★ 只加载该首字母的英文小文件（约 12KB），不再解析 251KB 整表
 */
export function searchEnglish(word, onProgress, limit) {
  const w = normalize(word)
  if (!w) return Promise.resolve([])
  const cap = (limit && limit > 0) ? limit : MAX_COLLECT
  return loader.loadEn(w).then(function (data) {
    const map = (data && data.en2ms) || {}
    let words = map[w] ? map[w].slice() : []
    // 无精确命中 → 前缀（只收集到本页所需为止）
    if (words.length === 0) {
      for (const key in map) {
        if (key.indexOf(w) === 0) {
          const arr = map[key] || []
          for (let i = 0; i < arr.length; i++) {
            if (words.indexOf(arr[i]) === -1) words.push(arr[i])
          }
          if (words.length >= cap) break
        }
      }
    }
    return fetchEntries(words.slice(0, cap), onProgress)
  })
}

/**
 * 按词表批量取词条（跨分片）
 * ★ 用串行加载，避免一次解析多个分片导致内存爆掉（v0.7 真机闪退修复）
 * @param {Array<string>} words
 * @param {function} onProgress 可选，回调 (done, total) 用于「加载中…」提示
 */
function fetchEntries(words, onProgress, limit) {
  if (!words.length) return Promise.resolve([])
  const cap = limit || MAX_COLLECT

  // 收集需要的分片，并限制数量上限（防极端情况）
  const letters = []
  for (let i = 0; i < words.length; i++) {
    const l = String(words[i]).charAt(0).toLowerCase()
    if (l && letters.indexOf(l) === -1) letters.push(l)
    if (letters.length >= 12) break
  }

  return loader.loadShardsSerial(letters, onProgress).then(function (shards) {
    const out = []
    const seen = {}
    for (let i = 0; i < words.length; i++) {
      const target = words[i]
      const key = flat(target)
      for (let s = 0; s < shards.length; s++) {
        const shard = shards[s]
        if (!shard) continue
        let hit = shard.byWord ? shard.byWord[target] : null
        if (!hit) {
          const list = shard.flat || []
          for (let k = 0; k < list.length; k++) {
            if (list[k].f === key) { hit = list[k].e; break }
          }
        }
        if (hit && !seen[hit.w]) {
          seen[hit.w] = true
          out.push(hit)
          break
        }
      }
      if (out.length >= cap) break
    }
    return out
  })
}

/**
 * 汉字 → 马来语词条
 * 支持三种输入：
 *   1) 完整词命中（如「学习」）—— ★ 结果强制置顶
 *   2) 多字无完整命中 → 逐字取并集（如「吃饭」→ 吃 ∪ 饭）
 *   3) 单字命中
 * ★ 走分桶加载：只读 1~N 个小桶（每桶约 18KB），不再解析 1MB 整表
 * ★ 并集数量封顶（MAX_UNION），防止触及过多分片
 */
export function searchChinese(word, onProgress, limit) {
  const w = String(word || '').trim()
  if (!w) return Promise.resolve([])
  // 人工修正表优先（覆盖来源里的错误条目）
  const fixed = getOverride(w)
  if (fixed) return fetchEntries(fixed, onProgress, limit)

  const chars = w.match(/[\u4e00-\u9fa5]/g) || []
  if (!chars.length) return Promise.resolve([])

  // 只加载涉及的桶（最多 4 个，避免拆长句时爆内存）
  const need = []
  for (let i = 0; i < chars.length && need.length < 4; i++) {
    const b = String(chars[i].charCodeAt(0) % 26)
    if (need.indexOf(b) === -1) need.push(b)
  }

  return loader.loadZhBuckets(need).then(function (buckets) {
    // 合并成临时表（只在本次查询内存活，函数返回后即可被 GC）
    const map = {}
    for (let i = 0; i < buckets.length; i++) {
      const m = (buckets[i] && buckets[i].zh2ms) || {}
      for (const k in m) {
        if (!map[k]) map[k] = m[k]
      }
    }

    // 1) 完整匹配 —— ★ 优先级最高，结果置顶
    const exact = map[w] ? map[w].slice() : []
    const seen = {}
    for (let i = 0; i < exact.length; i++) seen[exact[i]] = 1

    // 2) 无完整匹配 → 拆字取并集（去重、封顶）
    const union = []
    if (exact.length === 0) {
      for (let i = 0; i < chars.length; i++) {
        if (union.length >= MAX_UNION) break
        const list = map[chars[i]] || []
        for (let j = 0; j < list.length; j++) {
          const t = list[j]
          if (seen[t]) continue
          seen[t] = 1
          union.push(t)
          if (union.length >= MAX_UNION) break
        }
      }
    }

    // ★ 整词命中在前，拆字并集在后（避免「吃饭」的结果乱序）
    const words = exact.concat(union)
    if (!words.length) return []
    // ★ 分页：只取本页所需（+1 用于判断下一页），避免一次解析 30~50 条词条
    const cap = (limit && limit > 0) ? limit : words.length
    return fetchEntries(words.slice(0, cap), onProgress)
  })
}

/* --------------------------- 人工修正表 --------------------------- */

/**
 * 修正数据源里的错误/噪音条目。
 * 触发条件：用户查询的中文词命中此表，则直接用指定马来语词，
 * 不再走来源索引（用于覆盖维基词典的错条目）。
 */
const ZH_OVERRIDE = {
  '书': ['buku', 'kitab'],
  '书籍': ['buku', 'kitab'],
  '书本': ['buku'],
  // ↓ 用户发现的错译/缺译，直接在这里覆盖（修数据最快的方式）
  '蓝色': ['biru'],
  '蓝': ['biru'],
  '红': ['merah'],
  '红色': ['merah'],
  '黄': ['kuning'],
  '黄色': ['kuning'],
  '绿': ['hijau'],
  '绿色': ['hijau'],
  '黑': ['hitam'],
  '黑色': ['hitam'],
  '白': ['putih'],
  '白色': ['putih']
}

function getOverride(w) {
  const v = ZH_OVERRIDE[w]
  return v && v.length ? v.slice() : null
}

/* --------------------------- 自动识别 --------------------------- */

const HANZI_RE = /[\u4e00-\u9fa5]/

/** 是否包含汉字 */
export function hasHanzi(text) {
  return HANZI_RE.test(String(text || ''))
}

/**
 * 自动识别检索方向：
 *   含汉字  → 中文 → 马来语（直接查，不用先出候选）
 *   纯字母  → 马来语 → 中文（同时给出拼音候选，便于反查）
 * @returns {Promise<{type: string, rows: Array, cands: Array}>}
 */
export function autoSearch(query) {
  const q = String(query || '').trim()
  if (!q) return Promise.resolve({ type: 'none', rows: [], cands: [] })

  // 含汉字：直接中译马
  if (hasHanzi(q)) {
    return searchChinese(q).then(function (rows) {
      return { type: 'zh', rows: rows ? rows : [], cands: [] }
    }).catch(function () {
      return { type: 'zh', rows: [], cands: [] }
    })
  }

  // 纯字母：两边都试（马来语词条 + 拼音候选）
  return Promise.all([
    searchMalay(q).catch(function () { return [] }),
    searchPinyin(q).catch(function () { return [] })
  ]).then(function (res) {
    return {
      type: 'ms',
      rows: res[0] ? res[0] : [],
      cands: res[1] ? res[1] : []
    }
  })
}

/**
 * 按模式查询（统一入口，供搜索页调用）
 *   ms2zh  马来语 → 中文：输马来语，出词条
 *   zh2ms  中文 → 马来语：输汉字/拼音，出词条
 *   en2ms  英语 → 马来语：输英文，出词条
 * @param {string} q
 * @param {string} mode
 * @param {function} onProgress 可选，(done, total) 用于「加载中…」提示
 * @param {number} page 可选，从 1 开始（分页：只取到本页所需为止）
 * @returns {Promise<{rows: Array, cands: Array}>}
 */
export function queryByMode(q, mode, onProgress, page, pageSize) {
  const s = String(q || '').trim()
  if (!s) return Promise.resolve({ rows: [], cands: [] })
  const p = page && page > 0 ? page : 1
  const ps = (pageSize && pageSize > 0) ? pageSize : PAGE_SIZE
  const limit = p * ps + 1      // ★ 多取 1 条用于判断是否还有下一页
  if (mode === 'zh2ms') {
    // 纯字母视为拼音 → 出候选汉字（点候选再查马来语）
    if (!hasHanzi(s)) {
      return searchPinyin(s).then(function (cands) {
        return { rows: [], cands: cands ? cands : [] }
      }).catch(function () {
        return { rows: [], cands: [] }
      })
    }
    return searchChinese(s, onProgress, limit).then(function (rows) {
      return { rows: rows ? rows : [], cands: [] }
    }).catch(function () {
      return { rows: [], cands: [] }
    })
  }
  if (mode === 'en2ms') {
    return searchEnglish(s, onProgress, limit).then(function (rows) {
      return { rows: rows ? rows : [], cands: [] }
    }).catch(function () {
      return { rows: [], cands: [] }
    })
  }
  return searchMalay(s, p, ps).then(function (rows) {
    return { rows: rows ? rows : [], cands: [] }
  }).catch(function () {
    return { rows: [], cands: [] }
  })
}
/**
 * ★ 分页查询（真正按需取，不一次收 50）
 *
 * 关键认知：分片已在内存里，但**一次解析 50 条候选 + 逐条 fetchEntries 会撑爆内存**。
 * 所以做法是「按页取」：
 *   1) 第 p 页只收集 p×PAGE_SIZE+1 条候选（+1 用于判断是否还有下一页）
 *   2) 页面只渲染 p×PAGE_SIZE 条
 *   3) 点「下一页」时 page+1，重新按 (page×10+1) 取——分片已在内存，不会重复读文件
 *
 * @param {string} q
 * @param {string} mode
 * @param {number} page 从 1 开始
 * @param {function} onProgress
 * @returns {Promise<{rows, cands, total, hasMore}>}
 */
export function queryPaged(q, mode, page, onProgress, pageSize) {
  const p = page && page > 0 ? page : 1
  const ps = (pageSize && pageSize > 0) ? pageSize : PAGE_SIZE
  return queryByMode(q, mode, onProgress, p, ps).then(function (res) {
    const r = res || { rows: [], cands: [] }
    const all = r.rows || []
    const from = (p - 1) * ps
    return {
      // ★ 真分页：只返回「本页」的 ps 条（不累积），点下一页才是新的 10 条
      rows: all.slice(from, from + ps),
      cands: r.cands || [],
      total: all.length,
      hasMore: all.length > p * ps,
      hasPrev: p > 1
    }
  })
}

/**
 * 随机取词（每日学习用）
 * 从已加载的分片里随机抽；优先抽「有中文释义」的词条。
 * @param {number} n 取几个
 * @param {Array<string>} exclude 需要排除的词（避免和上次重复）
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
    // ★ 串行加载，逐个分片累计，凑够 count 就停（避免一次解析多个分片吃内存）
    const pool = letters.slice()
    const cand = []
    const seen = {}
    let tried = 0
    const MAX_TRY = 4
    function step() {
      if (cand.length >= count || tried >= MAX_TRY || pool.length === 0) {
        // 洗牌后取前 n 个
        for (let i = cand.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          const t = cand[i]; cand[i] = cand[j]; cand[j] = t
        }
        return Promise.resolve(cand.slice(0, count))
      }
      tried++
      const k = Math.floor(Math.random() * pool.length)
      const letter = pool[k]
      pool.splice(k, 1)
      return loader.loadShard(letter).then(function (shard) {
        if (shard && shard.entries) {
          const list = shard.entries
          for (let i = 0; i < list.length; i++) {
            const e = list[i]
            if (!e.zh || !e.w || skip[e.w] || seen[e.w]) continue
            seen[e.w] = 1
            cand.push(e)
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

/**
 * 按词取词条（详情页 / 收藏跳转用）
 */
export function getEntry(word) {
  const norm = normalize(word)
  if (!norm) return Promise.resolve(null)
  return loader.loadShard(norm.charAt(0)).then(function (shard) {
    if (!shard) return null
    if (shard.byWord && shard.byWord[norm]) return shard.byWord[norm]
    // 含空格/连字符的词：按去分隔符形式再查一次
    const list = shard.flat || []
    for (let i = 0; i < list.length; i++) {
      if (list[i].f === norm) return list[i].e
    }
    return null
  })
}

/**
 * 统一入口
 */
export function search(query, mode) {
  if (!query) return Promise.resolve([])
  if (mode === MODE_ZH2MS) return searchPinyin(query)
  return searchMalay(query)
}

/* --------------------------- 复习测验 --------------------------- */

/**
 * ★ 生成一道选择题（供 quiz 页调用）
 *
 * 关键设计：**干扰项从"正确答案所在分片"里取** —— 该分片已经加载在内存里，
 * 所以零额外 IO、零额外内存。避免为了凑选项去加载别的分片。
 *
 * @param {string} word 题干词（马来语）
 * @param {string} mode 'ms2zh'（题干马来语，选中文）| 'zh2ms'（题干中文，选马来语）
 * @returns {Promise<{stem, opts, answer, entry}|null>}
 */
export function makeQuestion(word, mode) {
  const w = String(word || '').trim()
  if (!w) return Promise.resolve(null)
  return loader.loadShard(w.charAt(0)).then(function (shard) {
    if (!shard || !shard.byWord) return null
    const correct = shard.byWord[w] || null
    if (!correct) return null
    // 题干/答案随模式变：ms2zh 看马来语选中文；zh2ms 看中文选马来语；en2ms 看英文选马来语
    const askMalay = (mode !== 'ms2zh')     // 答案是不是马来语
    const stem = (mode === 'zh2ms') ? (correct.zh || '')
      : (mode === 'en2ms') ? (correct.en || '')
      : correct.w
    if (!stem) return null
    // 干扰项：同分片 + 有释义 + 不是答案本身
    const pool = []
    const list = shard.entries || []
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e || e.w === correct.w) continue
      if (!e.zh) continue
      // ★ en2ms 模式下干扰项必须也有英文释义，否则选项里会出现空字符串
      if (mode === 'en2ms' && !e.en) continue
      // 词长接近，避免一眼看出
      if (Math.abs(e.w.length - correct.w.length) > 3) continue
      pool.push(e)
    }

    // 洗牌取 2 个干扰项
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t
    }
    const distract = pool.slice(0, 2)
    if (distract.length < 2) return null   // 选项不足 → 换下一题

    // 选项文本
    const text = function (e) {
      return askMalay ? e.w : (e.zh || '')
    }

    const opts = [correct].concat(distract).map(text)
    // 洗牌选项
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = opts[i]; opts[i] = opts[j]; opts[j] = t
    }

    return {
      stem: stem,
      opts: opts,
      answer: text(correct),
      entry: correct
    }
  }).catch(function (e) {
    console.log('[quiz] makeQuestion fail: ' + e)
    return null
  })
}

/**
 * 释放分片缓存（页面离开时调用，降低手环内存压力）
 * ★ v0.11：改为全量释放 —— 原来只清分片，中文桶/拼音/英文表会持续驻留，
 *   反复进出页面后常驻内存不断上涨，最终触发重启。
 */
export function releaseShards() {
  loader.releaseAll()
}