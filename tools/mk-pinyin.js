/******************************************************************************
 * @file        mk-pinyin.js
 * @description 用 pinyin-pro 生成全量「汉字 → 拼音(无声调)」映射
 *              覆盖所有出现在中文释义里的汉字，解决中译马查不全的问题。
 *              输出：tools/pinyin-map.js
 ******************************************************************************/
const fs = require('fs')
const path = require('path')
const { pinyin } = require('/root/ref/pylib/node_modules/pinyin-pro')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'pinyin-map.js')
const HANZI = /[\u4e00-\u9fa5]/
// 1) 收集所有汉字
const chars = {}
function scan(file) {
  const p = path.join(__dirname, file)
  if (!fs.existsSync(p)) { console.log('跳过 ' + file); return 0 }
  const arr = require(p)
  let n = 0
  for (const line of arr) {
    const parts = String(line).split('|')
    const zh = parts[2] || ''
    for (const ch of zh) {
      if (HANZI.test(ch) && !chars[ch]) { chars[ch] = 1; n++ }
    }
  }
  return n
}
scan('seed-words.js')
scan('seed-words-2.js')
scan('zhwiktionary-words.js')
scan('generated-words.js')
const keys = Object.keys(chars)
console.log('收集汉字：' + keys.length)
// 2) 生成拼音
const map = {}
let fail = 0
for (const ch of keys) {
  let py = ''
  try { py = pinyin(ch, { toneType: 'none', type: 'array' })[0] || '' } catch (e) { py = '' }
  py = String(py).toLowerCase().replace(/[^a-z]/g, '')
  if (py) map[ch] = py
  else fail++
}
// 3) 输出
const sorted = Object.keys(map).sort()
const body = sorted.map(function (k) {
  return '  ' + JSON.stringify(k) + ': ' + JSON.stringify(map[k])
}).join(',\n')
const head = '/******************************************************************************\n'
  + ' * @file        pinyin-map.js\n'
  + ' * @description 汉字 → 拼音（无声调）映射表\n'
  + ' *              由 tools/mk-pinyin.js 用 pinyin-pro 生成。\n'
  + ' *              共 ' + sorted.length + ' 字。拼音数据来源 pinyin-pro (MIT)。\n'
  + ' ******************************************************************************/\n\n'
  + 'module.exports = {\n'
fs.writeFileSync(OUT, head + body + '\n}\n', 'utf8')
console.log('生成拼音：' + sorted.length + '（失败 ' + fail + '）')
console.log('输出：' + OUT)
