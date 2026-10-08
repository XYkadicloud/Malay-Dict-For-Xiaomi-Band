/******************************************************************************
 * @file        fetch-zhwiktionary.js
 * @description 从中文维基词典抓取马来语词条的中文释义
 *
 *   来源：zh.wiktionary.org（CC BY-SA 4.0）
 *   原理：中文维基词典的马来语章节格式统一为
 *           ==马来语==
 *           中文释义
 *         直接取该章节正文，无需英中桥接。
 *
 *   用法：
 *     node tools/fetch-zhwiktionary.js              # 全量（自动跳过已抓到的）
 *     node tools/fetch-zhwiktionary.js --limit 500
 *     node tools/fetch-zhwiktionary.js --retry      # 只重试之前失败的词
 *
 *   输入：data/raw/malay-wordlist.txt   每行一个马来语词
 *   输出：tools/zhwiktionary-words.js
 *   缓存：data/cache/zhwiki-done.json   已完成结果（支持断点续传）
 *        data/cache/zhwiki-fail.txt    失败词（下次可 --retry）
 *
 *   可靠性设计：
 *     - 每批 20 词（批越小越不容易整体失败）
 *     - 失败重试 4 次，指数退避
 *     - 每批成功后立即写缓存，中断不丢进度
 *     - 请求间隔 250ms，带 UA，遵守 API 礼仪
 ******************************************************************************/

const fs = require('fs')
const path = require('path')
const https = require('https')

const ROOT = path.resolve(__dirname, '..')
const RAW = path.join(ROOT, 'data', 'raw')
const CACHE = path.join(ROOT, 'data', 'cache')
const WORDLIST = path.join(RAW, 'malay-wordlist.txt')
const DONE = path.join(CACHE, 'zhwiki-done.json')
const FAIL = path.join(CACHE, 'zhwiki-fail.txt')
const OUT = path.join(__dirname, 'zhwiktionary-words.js')

const BATCH = 20
const DELAY = 250
const MAX_TRY = 4
const UA = 'MalayDictBuilder/1.0 (offline dictionary; educational)'

const args = process.argv.slice(2)
let LIMIT = 0
let RETRY = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) LIMIT = parseInt(args[i + 1], 10) || 0
  if (args[i] === '--retry') RETRY = true
}

/* ------------------------- HTTP ------------------------- */

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    }, function (res) {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', function (c) { d += c })
      res.on('end', function () {
        if (!d || d.charAt(0) !== '{') { reject(new Error('bad body')); return }
        try { resolve(JSON.parse(d)) } catch (e) { reject(new Error('parse fail')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(25000, function () { req.destroy(new Error('timeout')) })
  })
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

/* ------------------------- 解析 wikitext ------------------------- */

const ZH_RE = /==+\s*马来语\s*==+/

function parseMalaySection(wikitext) {
  if (!wikitext) return ''
  const parts = String(wikitext).split(ZH_RE)
  if (parts.length < 2) return ''
  let seg = parts[1]

  const cut = seg.search(/\n==[^=]/)
  if (cut >= 0) seg = seg.substring(0, cut)

  seg = seg.replace(/\{\{[^{}]*\}\}/g, ' ')
  seg = seg.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
  seg = seg.replace(/\[\[([^\]]*)\]\]/g, '$1')
  seg = seg.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, ' ')
  seg = seg.replace(/<[^>]*>/g, ' ')
  seg = seg.replace(/\[\[Category:[^\]]*\]\]/gi, ' ')
  seg = seg.replace(/Category:[^\s|=\]]*/gi, ' ')
  seg = seg.replace(/分类:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/分類:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/缩略图\|[^\s=]*/g, ' ')
  seg = seg.replace(/文件:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/File:[^\s|=\]]*/gi, ' ')
  seg = seg.replace(/'{2,}/g, '')
  seg = seg.replace(/^[\s#*:;]+/gm, ' ')
  seg = seg.replace(/\s+/g, ' ')

  // 元信息噪音
  seg = seg.replace(/詞源[^\s，。;；]*/g, ' ')
  seg = seg.replace(/词源[^\s，。;；]*/g, ' ')
  seg = seg.replace(/讀音|读音|發音|发音|拼音|注音/g, ' ')
  seg = seg.replace(/名詞|名词|動詞|动词|形容詞|形容词|副詞|副词|代詞|代词|助詞|助词/g, ' ')
  seg = seg.replace(/參見|参见|另見|另见|派生|相關|相关|同義|同义|反義|反义/g, ' ')
  seg = seg.replace(/來自|来自|源自|借自|繼承|继承/g, ' ')
  seg = seg.replace(/印尼語|印尼语|馬來語|马来语|瑞典語|瑞典语|英語|英语|跨語言|跨语言/g, ' ')
  seg = seg.replace(/拉丁文字|拉丁字母/g, ' ')
  seg = seg.replace(/^[\s、，。;；:：\-]+/g, ' ')
  seg = seg.replace(/[\s、，。;；:：\-]+$/g, ' ')
  seg = seg.replace(/\s+/g, ' ').trim()

  seg = seg.replace(/[a-zA-Z]{6,}/g, ' ')
  seg = seg.replace(/[\[\]{}<>|=]/g, ' ')
  seg = seg.replace(/\s+/g, ' ').trim()

  if (!/[\u4e00-\u9fa5]/.test(seg)) return ''
  if (seg.length > 60) seg = seg.substring(0, 60)
  return seg.trim()
}

/* ------------------------- 抓取一批 ------------------------- */

async function fetchBatch(words) {
  const url = 'https://zh.wiktionary.org/w/api.php?action=query&prop=revisions'
    + '&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles='
    + encodeURIComponent(words.join('|'))

  for (let attempt = 0; attempt < MAX_TRY; attempt++) {
    try {
      const data = await fetchJson(url)
      const pages = (data && data.query && data.query.pages) || []
      const got = {}
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        if (p.missing) continue
        const slot = p.revisions && p.revisions[0] && p.revisions[0].slots
          && p.revisions[0].slots.main
        const wt = slot ? slot.content : ''
        const zh = parseMalaySection(wt)
        if (zh) got[String(p.title || '').toLowerCase()] = zh
      }
      return { ok: true, got: got }
    } catch (e) {
      if (attempt < MAX_TRY - 1) await sleep(600 * (attempt + 1))
    }
  }
  return { ok: false, got: {} }
}

/* ------------------------- 主流程 ------------------------- */

async function main() {
  if (!fs.existsSync(WORDLIST)) {
    console.error('缺少词表 ' + WORDLIST)
    process.exit(1)
  }
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

  // 载入已有缓存
  let done = {}
  if (fs.existsSync(DONE)) {
    try { done = JSON.parse(fs.readFileSync(DONE, 'utf8')) || {} } catch (e) { done = {} }
  }
  const doneCount = Object.keys(done).length

  let words = fs.readFileSync(WORDLIST, 'utf8')
    .split(/\r?\n/)
    .map(function (s) { return s.trim().toLowerCase() })
    .filter(function (s) { return s && /^[a-z]+(?:[ -][a-z]+)*$/.test(s) })

  // 去重
  const seen = {}
  const uniq = []
  for (let i = 0; i < words.length; i++) {
    if (seen[words[i]]) continue
    seen[words[i]] = 1
    uniq.push(words[i])
  }

  let todo
  if (RETRY && fs.existsSync(FAIL)) {
    todo = fs.readFileSync(FAIL, 'utf8').split(/\r?\n/)
      .map(function (s) { return s.trim().toLowerCase() })
      .filter(function (s) { return s })
    console.log('重试模式：' + todo.length + ' 个失败词')
  } else {
    // 跳过已抓到的
    todo = uniq.filter(function (w) { return !done[w] })
    console.log('总词表 ' + uniq.length + '，已有 ' + doneCount + '，待抓 ' + todo.length)
  }

  if (LIMIT > 0) todo = todo.slice(0, LIMIT)

  const failed = []
  let n = 0
  let hit = 0

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const r = await fetchBatch(batch)
    n += batch.length

    if (r.ok) {
      for (const k in r.got) {
        if (!done[k]) { done[k] = r.got[k]; hit++ }
      }
    } else {
      for (let j = 0; j < batch.length; j++) failed.push(batch[j])
    }

    // 每批落盘
    fs.writeFileSync(DONE, JSON.stringify(done), 'utf8')
    if (failed.length) fs.writeFileSync(FAIL, failed.join('\n') + '\n', 'utf8')

    const pct = (n * 100 / Math.max(1, todo.length)).toFixed(0)
    console.log('进度 ' + n + '/' + todo.length + ' (' + pct + '%)  累计命中 ' + Object.keys(done).length
      + (r.ok ? '' : '  [本批失败]'))
    await sleep(DELAY)
  }

  /* ---------- 输出 ---------- */

  const keys = Object.keys(done).sort()
  const lines = keys.map(function (w) {
    const zh = String(done[w]).replace(/[|\r\n\t]/g, ' ').trim()
    return w + '||' + zh + '||||'
  })

  const head = '/******************************************************************************\n'
    + ' * @file        zhwiktionary-words.js\n'
    + ' * @description 由 tools/fetch-zhwiktionary.js 从中文维基词典抓取，请勿手工编辑。\n'
    + ' *\n'
    + ' *   来源：zh.wiktionary.org（CC BY-SA 4.0）\n'
    + ' *   说明：取各词条「马来语」章节的中文释义。\n'
    + ' *   抓取时间：' + new Date().toISOString() + '\n'
    + ' *   命中词条：' + keys.length + ' / 词表 ' + uniq.length + '\n'
    + ' ******************************************************************************/\n\n'
    + 'module.exports = [\n'

  const body = lines.map(function (l) {
    return "  '" + l.replace(/'/g, "\\'") + "'"
  }).join(',\n')

  fs.writeFileSync(OUT, head + body + '\n]\n', 'utf8')

  console.log('=== 完成 ===')
  console.log('累计命中 : ' + keys.length)
  console.log('失败批次词: ' + failed.length + (failed.length ? '（可 --retry 重试）' : ''))
  console.log('输出     : ' + OUT)
}

main().catch(function (e) {
  console.error('抓取失败: ' + e)
  process.exit(1)
})