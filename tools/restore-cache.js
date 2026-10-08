// 把已有 zhwiktionary-words.js 转成断点缓存，避免重复抓取
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(__dirname, 'zhwiktionary-words.js')
const DONE = path.join(ROOT, 'data', 'cache', 'zhwiki-done.json')
if (!fs.existsSync(SRC)) { console.log('无已有结果'); process.exit(0) }
const arr = require(SRC)
const done = {}
for (const line of arr) {
  const p = String(line).split('|')
  const w = (p[0] || '').trim().toLowerCase()
  const zh = (p[2] || '').trim()
  if (w && zh) done[w] = zh
}
fs.writeFileSync(DONE, JSON.stringify(done), 'utf8')
console.log('恢复缓存：' + Object.keys(done).length + ' 条 → ' + DONE)
