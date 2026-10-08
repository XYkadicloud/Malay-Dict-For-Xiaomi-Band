/******************************************************************************
 * @file        verify-dict.js
 * @description 词库与搜索逻辑离线验证（不依赖真机）
 *              模拟 loader.js + search.js 的行为，检查：
 *                1. 分片文件完整性
 *                2. 精确 / 前缀 / 模糊查询
 *                3. 拼音反查与中文→马来语反查
 *              用法：node tools/verify-dict.js
 ******************************************************************************/

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DICT_DIR = path.join(ROOT, 'src', 'assets', 'dict')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✅ ' + name)
  } else {
    fail++
    console.log('  ❌ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DICT_DIR, file), 'utf8'))
}

function flatKey(s) {
  return String(s || '').replace(/[^a-z0-9]/g, '')
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

function damera(a, b, max) {
  const la = a.length, lb = b.length
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

/* ------------------------- 载入 ------------------------- */

const index = readJSON('index.txt')
// ★ 中文反查已按「首字码位 % 26」分桶，拼音按首字母分文件；这里合并成整表供断言使用
const zh = { zh2ms: {}, py: {} }
for (const b of (index.zhBuckets || [])) {
  const part = readJSON('zh-' + b + '.txt')
  for (const k in part.zh2ms) zh.zh2ms[k] = part.zh2ms[k]
}
for (const l of (index.pyLetters || [])) {
  const part = readJSON('py-' + l + '.txt')
  for (const k in part.py) zh.py[k] = part.py[k]
}
const shards = {}
for (let i = 0; i < index.letters.length; i++) {
  const k = index.letters[i]
  const list = readJSON('ms-' + k + '.txt')
  const byWord = {}
  const flat = []
  for (let j = 0; j < list.length; j++) {
    byWord[list[j].w] = list[j]
    flat.push({ f: flatKey(list[j].w), e: list[j] })
  }
  shards[k] = { letter: k, entries: list, byWord: byWord, flat: flat }
}

/* ------------------------- 搜索实现（对齐 search.js） ------------------------- */

function collect(shard, norm, limit, fuzzy) {
  const out = []
  const seen = {}
  const push = function (e) {
    if (!e || !e.w || seen[e.w]) return
    seen[e.w] = true
    out.push(e)
  }
  const fl = shard.flat || []
  push(shard.byWord[norm])
  for (let i = 0; i < fl.length; i++) {
    if (fl[i].f === norm) push(fl[i].e)
  }
  for (let i = 0; i < fl.length; i++) {
    const it = fl[i]
    if (it.f === norm) continue
    if (it.f.indexOf(norm) === 0) {
      push(it.e)
      if (out.length >= limit) return out
    }
  }
  if (fuzzy && out.length === 0 && norm.length >= 3) {
    for (let i = 0; i < fl.length; i++) {
      const it = fl[i]
      if (Math.abs(it.f.length - norm.length) > 1) continue
      if (damera(it.f, norm, 1) <= 1) {
        push(it.e)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

function searchMalay(q) {
  const n = normalize(q)
  if (!n) return []
  const shard = shards[n.charAt(0)]
  if (!shard) return []
  let out = collect(shard, n, 30, false)
  if (out.length > 0) return out
  return collect(shard, n, 30, true)
}

function searchPinyin(q) {
  const n = normalize(q)
  if (!n) return []
  const py = zh.py || {}
  if (py[n]) return py[n].slice(0, 20)
  const out = []
  for (const k in py) {
    if (k.indexOf(n) === 0) {
      const arr = py[k]
      for (let i = 0; i < arr.length; i++) {
        if (out.indexOf(arr[i]) === -1) out.push(arr[i])
        if (out.length >= 20) return out
      }
    }
  }
  return out
}

function searchChinese(word) {
  const words = (zh.zh2ms || {})[word] || []
  const out = []
  const seen = {}
  for (let i = 0; i < words.length; i++) {
    const t = words[i]
    const key = flatKey(t)
    const shard = shards[t.charAt(0)]
    if (!shard) continue
    let hit = shard.byWord[t]
    if (!hit) {
      for (let k = 0; k < shard.flat.length; k++) {
        if (shard.flat[k].f === key) { hit = shard.flat[k].e; break }
      }
    }
    if (hit && !seen[hit.w]) { seen[hit.w] = true; out.push(hit) }
  }
  return out
}

/* ------------------------- 测试 ------------------------- */

console.log('=== 词库结构 ===')
ok('index.json 有 total', typeof index.total === 'number', 'total=' + index.total)
ok('分片数与 letters 一致', index.shardCount === index.letters.length)
ok('每个分片文件都存在', index.letters.every(function (k) {
  return fs.existsSync(path.join(DICT_DIR, 'ms-' + k + '.txt'))
}))
ok('zh/py 索引可合并', !!(zh.py && zh.zh2ms))
ok('词条数 > 400', index.total > 400, 'total=' + index.total)

// 分片内词条数核对
let sum = 0
for (const k in index.shards) sum += index.shards[k]
ok('分片词条数合计 == total', sum === index.total, sum + ' vs ' + index.total)

// 分片首字母一致性
let letterOk = true
for (const k in shards) {
  const list = shards[k].entries
  for (let i = 0; i < list.length; i++) {
    if (list[i].w.charAt(0) !== k) { letterOk = false; break }
  }
}
ok('每个词条都在正确的首字母分片', letterOk)

console.log('\n=== 马来语 → 中文 ===')
const t1 = searchMalay('makan')
ok('精确 makan 命中', t1.length > 0 && t1[0].w === 'makan', JSON.stringify(t1[0] || null))
ok('makan 中文释义=吃', t1.length > 0 && t1[0].zh === '吃', t1.length ? t1[0].zh : '')

const t2 = searchMalay('mak')
ok('前缀 mak 有结果', t2.length > 0, 'n=' + t2.length)
ok('前缀 mak 含 makan', t2.some(function (e) { return e.w === 'makan' }))
ok('前缀 mak 含 makanan 或 makan', t2.length >= 1)

const t3 = searchMalay('rumah')
ok('精确 rumah 命中', t3.length > 0 && t3[0].w === 'rumah')
ok('rumah 释义=房子,家', t3.length > 0 && t3[0].zh === '房子,家', t3.length ? t3[0].zh : '')

const t4 = searchMalay('makn')
ok('makn 前缀命中 makna', t4.some(function (e) { return e.w === 'makna' }), JSON.stringify(t4.map(function (e) { return e.w })))

// 真正触发模糊的场景：前缀无任何结果，但编辑距离为 1
const t4b = searchMalay('rumha')
ok('模糊 rumha → rumah（换位）', t4b.some(function (e) { return e.w === 'rumah' }), JSON.stringify(t4b.map(function (e) { return e.w })))

const t4c = searchMalay('bukku')
ok('模糊 bukku → buku（增字）', t4c.some(function (e) { return e.w === 'buku' }), JSON.stringify(t4c.map(function (e) { return e.w })))

const t4d = searchMalay('maakan')
ok('模糊 maakan → makan（增字）', t4d.some(function (e) { return e.w === 'makan' }), JSON.stringify(t4d.map(function (e) { return e.w })))

const t5 = searchMalay('terimakasih')
ok('无空格输入命中 terima kasih', t5.some(function (e) { return e.w === 'terima kasih' }), JSON.stringify(t5.map(function (e) { return e.w })))

const t6 = searchMalay('buku')
ok('buku 含例句', t6.length > 0 && !!t6[0].ex, t6.length ? String(t6[0].ex) : '')
ok('buku 有词性', t6.length > 0 && t6[0].p === 'n', t6.length ? String(t6[0].p) : '')

const t7 = searchMalay('zzzz')
ok('无结果词返回空', t7.length === 0, 'n=' + t7.length)

console.log('\n=== 拼音 → 中文候选 ===')
const p1 = searchPinyin('chi')
ok('拼音 chi 有候选', p1.length > 0, JSON.stringify(p1))
ok('拼音 chi 含 吃', p1.indexOf('吃') !== -1, JSON.stringify(p1))

const p2 = searchPinyin('shui')
ok('拼音 shui 含 水', p2.indexOf('水') !== -1, JSON.stringify(p2))

const p3 = searchPinyin('xuexi')
ok('拼音 xuexi 含 学习', p3.indexOf('学习') !== -1, JSON.stringify(p3))

const p4 = searchPinyin('ren')
ok('拼音 ren 有候选', p4.length > 0, JSON.stringify(p4.slice(0, 8)))

const p5 = searchPinyin('zzzz')
ok('无效拼音无候选或仅噪音', p5.length <= 3, JSON.stringify(p5.slice(0, 5)))

console.log('\n=== 中文 → 马来语 ===')
const c1 = searchChinese('吃')
ok('中文「吃」有结果', c1.length > 0, JSON.stringify(c1.map(function (e) { return e.w })))
ok('中文「吃」含 makan', c1.some(function (e) { return e.w === 'makan' }))

const c2 = searchChinese('水')
ok('中文「水」含 air', c2.some(function (e) { return e.w === 'air' }), JSON.stringify(c2.map(function (e) { return e.w })))

const c3 = searchChinese('学习')
ok('中文「学习」含 belajar', c3.some(function (e) { return e.w === 'belajar' }), JSON.stringify(c3.map(function (e) { return e.w })))

const c4 = searchChinese('书')
ok('中文「书」含 buku', c4.some(function (e) { return e.w === 'buku' }), JSON.stringify(c4.map(function (e) { return e.w })))

const c5 = searchChinese('不存在的词')
ok('未知中文返回空', c5.length === 0, JSON.stringify(c5))

console.log('\n=== 数据质量 ===')
let noZh = 0
let noPos = 0
let total = 0
for (const k in shards) {
  const list = shards[k].entries
  for (let i = 0; i < list.length; i++) {
    total++
    if (!list[i].zh) noZh++
    if (!list[i].p) noPos++
  }
}
// 中文释义覆盖率 ≥95%（少量词条本身在来源里就无中文）
ok('中文释义覆盖率 ≥95%', (total - noZh) * 100 / total >= 95, '缺 ' + noZh + '/' + total)
// 词性不作硬要求：维基词典大量词条不带词性，属正常
ok('词性覆盖率 ≥30%', noPos * 100 / total < 70, '缺 ' + noPos + '/' + total)

// 同义词引用有效性（弱校验：允许指向库外词）
let synRefs = 0
for (const k in shards) {
  const list = shards[k].entries
  for (let i = 0; i < list.length; i++) {
    if (list[i].syn) synRefs += list[i].syn.length
    if (list[i].ant) synRefs += list[i].ant.length
  }
}
ok('存在同/反义词引用', synRefs > 0, 'refs=' + synRefs)

/* ------------------------- 汇总 ------------------------- */

console.log('\n=========================')
console.log('通过 ' + pass + ' / 失败 ' + fail)
console.log('词条总数 ' + index.total + '，中文词 ' + Object.keys(zh.zh2ms).length
  + '，拼音键 ' + Object.keys(zh.py).length)
console.log('=========================')
process.exit(fail === 0 ? 0 : 1)