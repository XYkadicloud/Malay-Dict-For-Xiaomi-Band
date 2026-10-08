/******************************************************************************
 * @file        mk-wordlist.js
 * @description 生成抓取用优先级词表：手写常用词优先，Kaikki 全量兜底
 *              输出：data/raw/malay-wordlist.txt
 ******************************************************************************/
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const ROOT = path.resolve(__dirname, '..')
const RAW = path.join(ROOT, 'data', 'raw')
const KAIKKI = path.join(RAW, 'kaikki-malay.jsonl')
const OUT = path.join(RAW, 'malay-wordlist.txt')
const RE = /^[a-z]+(?:[ -][a-z]+)*$/
const seen = {}
const out = []
function add(w) {
  w = String(w || '').toLowerCase().trim()
  if (!w || w.length < 2 || w.length > 24) return
  if (!RE.test(w)) return
  if (seen[w]) return
  seen[w] = 1
  out.push(w)
}
// 1) 手写常用词（人工校对，最可靠，排最前）
const seeds = ['seed-words.js', 'seed-words-2.js']
for (const f of seeds) {
  const p = path.join(__dirname, f)
  if (!fs.existsSync(p)) continue
  const arr = require(p)
  for (const line of arr) {
    const w = String(line).split('|')[0]
    add(w)
  }
}
const seedCount = out.length
console.log('手写常用词：' + seedCount)
// 2) Kaikki 全量
const rl = readline.createInterface({
  input: fs.createReadStream(KAIKKI, { encoding: 'utf8' }),
  crlfDelay: Infinity
})
let n = 0
rl.on('line', function (line) {
  if (!line) return
  let o
  try { o = JSON.parse(line) } catch (e) { return }
  n++
  add(o.word)
})
rl.on('close', function () {
  fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8')
  console.log('Kaikki 行数：' + n)
  console.log('词表总数  ：' + out.length + '（手写 ' + seedCount + ' + Kaikki ' + (out.length - seedCount) + '）')
  console.log('输出      ：' + OUT)
})
