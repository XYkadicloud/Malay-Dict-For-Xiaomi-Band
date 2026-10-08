/******************************************************************************
 * @file        parse-zhdump.js
 * @description 从中文维基词典官方 dump 离线提取马来语词条的中文释义
 *
 *   为什么用 dump 而不用 API：
 *     Wikimedia API 有严格限流（HTTP 429），批量抓 1 万词会被掐断；
 *     官方 dump 一次下载，本地无限次解析，且覆盖更全（1.3 万条）。
 *
 *   用法：
 *     node tools/parse-zhdump.js < /root/ref/zhwiki-dump.xml
 *
 *   输入：data/raw/malay-wordlist.txt（可选过滤；不存在则全收）
 *   输出：tools/zhwiktionary-words.js
 *        data/cache/zhwiki-done.json
 *
 *   解析要点：
 *     - dump 是缩进格式，判断标签要用「包含」而非「行首」
 *     - <page>…</page> 分块，<ns>0</ns> 才是正文
 *     - 马来语章节有 3 种写法：==马来语== / ==[[马来语]]== / == 马来语 ==
 *     - 部分词条（如 saya）没有二级标题，只有 [[Category:马来语xxx]]，
 *       需要额外兜底：取首个 # 释义行
 *     - 释义后可能跟其他语言段（---- 分隔、{{-xxx-}} 模板），必须截断
 ******************************************************************************/
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const ROOT = path.resolve(__dirname, '..')
const RAW = path.join(ROOT, 'data', 'raw')
const CACHE = path.join(ROOT, 'data', 'cache')
const WORDLIST = path.join(RAW, 'malay-wordlist.txt')
const DONE = path.join(CACHE, 'zhwiki-done.json')
const OUT = path.join(__dirname, 'zhwiktionary-words.js')

const WORD_RE = /^[a-z]+(?:[ -][a-z]+)*$/

/* ------------------------- 词表（可选过滤） ------------------------- */

let allow = null
if (fs.existsSync(WORDLIST)) {
  allow = {}
  const ws = fs.readFileSync(WORDLIST, 'utf8').split(/\r?\n/)
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i].trim().toLowerCase()
    if (w) allow[w] = 1
  }
  console.log('词表过滤：' + Object.keys(allow).length + ' 词')
} else {
  console.log('无词表，全收')
}

/* ------------------------- wikitext 解析 ------------------------- */

/** 马来语章节标题的 3 种写法 */
const ZH_RE = /==+\s*\[*\s*马来语\s*\]*\s*==+/
/** 其他语言段模板，如 {{-mnc-}} {{-sv-}}，遇到就停 */
const OTHER_LANG_RE = /\{\{\s*-\s*[a-z]{2,}\s*-\s*\}\}/

/** 通用清洗 */
function cleanSeg(seg) {
  seg = seg.replace(/\{\{[^{}]*\}\}/g, ' ')
  seg = seg.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
  seg = seg.replace(/\[\[([^\]]*)\]\]/g, '$1')
  seg = seg.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, ' ')
  seg = seg.replace(/<[^>]*>/g, ' ')
  seg = seg.replace(/&lt;[^&]*?&gt;/g, ' ')   // XML 转义标签残留
  seg = seg.replace(/&nbsp;/g, ' ')
  seg = seg.replace(/&amp;/g, '&')
  seg = seg.replace(/\[\[Category:[^\]]*\]\]/gi, ' ')
  seg = seg.replace(/Category:[^\s|=\]]*/gi, ' ')
  seg = seg.replace(/分类:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/分類:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/缩略图\|[^\s=]*/g, ' ')
  seg = seg.replace(/文件:[^\s|=\]]*/g, ' ')
  seg = seg.replace(/File:[^\s|=\]]*/gi, ' ')
  seg = seg.replace(/^[-=]{2,}\s*$/gm, ' ')   // ---- 分隔线
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
  return seg
}

function finalize(seg) {
  if (!/[\u4e00-\u9fa5]/.test(seg)) return ''
  if (seg.length > 60) seg = seg.substring(0, 60)
  return seg.trim()
}

/**
 * 主路径：有 ==马来语== 章节
 */
function parseMalaySection(wikitext) {
  if (!wikitext) return ''
  const parts = String(wikitext).split(ZH_RE)
  if (parts.length < 2) return ''
  let seg = parts[1]

  // 1) 到下一个二级标题为止
  const cut = seg.search(/\n==[^=]/)
  if (cut >= 0) seg = seg.substring(0, cut)

  // 2) 到其他语言模板 / ---- 分隔线为止（避免混入满语、瑞典语等）
  const cut2 = seg.search(OTHER_LANG_RE)
  if (cut2 >= 0) seg = seg.substring(0, cut2)
  const cut3 = seg.search(/\n\s*-{4,}/)
  if (cut3 >= 0) seg = seg.substring(0, cut3)

  return finalize(cleanSeg(seg))
}

/**
 * 兜底路径：无 ==马来语== 标题，但有 [[Category:马来语...]]
 * 结构形如：\n#[[我]]\n\n[[Category:马来语代词]]
 * 取所有 # 开头的释义行，抽出其中的中文
 */
function parseByCategory(wikitext) {
  if (!wikitext) return ''
  const s = String(wikitext)
  if (!/\[\[Category:\s*马来语/.test(s) && !/\[\[分类:\s*马来语/.test(s)) return ''

  const out = []
  const lines = s.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.charAt(0) !== '#') continue
    let t = line.replace(/^#+\s*/, '')
    t = cleanSeg(t)
    if (!t || !/[\u4e00-\u9fa5]/.test(t)) continue
    if (out.indexOf(t) === -1) out.push(t)
    if (out.length >= 4) break
  }
  return finalize(out.join('，'))
}

/* ------------------------- 主流程 ------------------------- */

function main() {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

  let done = {}
  if (fs.existsSync(DONE)) {
    try { done = JSON.parse(fs.readFileSync(DONE, 'utf8')) || {} } catch (e) { done = {} }
  }
  console.log('基线（已有）: ' + Object.keys(done).length)

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  let inPage = false
  let inText = false
  let title = ''
  let ns = ''
  let text = []
  let pages = 0
  let malayPages = 0
  let added = 0

  rl.on('line', function (line) {
    if (!inPage && line.indexOf('<page>') >= 0) {
      inPage = true; inText = false; title = ''; ns = ''; text = []
      return
    }
    if (inPage && line.indexOf('</page>') >= 0) {
      inPage = false
      pages++
      if (ns === '0' && text.length) {
        const wt = text.join('\n')
        const w = title.trim().toLowerCase()
        if (WORD_RE.test(w) && (!allow || allow[w]) && !done[w]) {
          let zh = ''
          if (ZH_RE.test(wt)) {
            malayPages++
            zh = parseMalaySection(wt)
          }
          if (!zh) zh = parseByCategory(wt)   // 兜底
          if (zh) { done[w] = zh; added++ }
        }
      }
      text = []
      return
    }
    if (!inPage) return

    if (inText) {
      const end = line.indexOf('</text>')
      if (end >= 0) {
        text.push(line.substring(0, end))
        inText = false
      } else {
        text.push(line)
      }
      return
    }

    if (line.indexOf('<title>') >= 0) {
      const s = line.indexOf('<title>') + 7
      const e = line.indexOf('</title>')
      title = e > s ? line.substring(s, e) : line.substring(s)
      return
    }
    if (line.indexOf('<ns>') >= 0) {
      const s = line.indexOf('<ns>') + 4
      const e = line.indexOf('</ns>')
      ns = e > s ? line.substring(s, e) : ''
      return
    }
    if (line.indexOf('<text') >= 0) {
      if (line.indexOf('/>') >= 0 && line.indexOf('/>') < line.indexOf('>')) return
      const gt = line.indexOf('>')
      const rest = gt >= 0 ? line.substring(gt + 1) : ''
      const end = rest.indexOf('</text>')
      if (end >= 0) {
        text.push(rest.substring(0, end))
      } else {
        inText = true
        text.push(rest)
      }
      return
    }
  })

  rl.on('close', function () {
    fs.writeFileSync(DONE, JSON.stringify(done), 'utf8')

    const keys = Object.keys(done).sort()
    const lines = keys.map(function (w) {
      const zh = String(done[w]).replace(/[|\r\n\t]/g, ' ').trim()
      return w + '||' + zh + '||||'
    })
    const head = '/******************************************************************************\n'
      + ' * @file        zhwiktionary-words.js\n'
      + ' * @description 由 tools/parse-zhdump.js 从中文维基词典官方 dump 解析，请勿手工编辑。\n'
      + ' *\n'
      + ' *   来源：zh.wiktionary.org dump（CC BY-SA 4.0）\n'
      + ' *   说明：取各词条「马来语」章节的中文释义（含 Category 兜底）。\n'
      + ' *   生成时间：' + new Date().toISOString() + '\n'
      + ' *   命中词条：' + keys.length + '\n'
      + ' ******************************************************************************/\n\n'
      + 'module.exports = [\n'
    const body = lines.map(function (l) {
      return "  '" + l.replace(/'/g, "\\'") + "'"
    }).join(',\n')
    fs.writeFileSync(OUT, head + body + '\n]\n', 'utf8')

    console.log('=== 解析完成 ===')
    console.log('页面总数   : ' + pages)
    console.log('含马来语节 : ' + malayPages)
    console.log('新增命中   : ' + added)
    console.log('累计命中   : ' + keys.length)
    console.log('输出       : ' + OUT)
  })
}

main()