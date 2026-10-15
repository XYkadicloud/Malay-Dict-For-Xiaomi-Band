#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-v15.py — v0.15 数据精细化构建（质量修复 + 覆盖扩展 + 英文补全）

═══════════════════════════════════════════════════════════
一、修复的核心问题（v0.14 及更早）
═══════════════════════════════════════════════════════════
旧 zh 索引用「中文释义**包含**该字」做子串匹配，任意子串都命中，
导致 12.3% 误匹配，且释义按字母序取前 8，正确答案被垃圾挤掉：
  他 → beliau,dia,ia,akhdar,altruistik,anwar,arbaa,ateistik
       （akhdar 的释义是「其**他**形式。绿色的」）
  一 → a go go          （该词释义「两者择**一**」）
  往 → getil            （该词释义「钳**往**，扭拧」）
  时间 → aktu,aktubelajar,aktusembahyang   （粘连）

二、新规则：分词后分级匹配
  ① 精确：中文键 == token                        18 分
  ② 前缀：token 剥掉尾部「的/地/了/之」后 == 键    12 分
  ③ 包含：3~4 字 token 的 2~3 字前缀              6 分
  功能词黑名单：含「其他/形式/近义/变体/复数…」的 token 不做包含匹配

三、覆盖扩展（三来源）
  A｜原生精确   ms 词库 19,042 条 → 约 21,000 键（自反查 100%）
  B｜桥接       CC-CEDICT / ECDICT 中文→英文 → Kaikki 英文→马来语
  C｜合并排序   A 优先、B 降权；同类内按 词性 + 频度 + 词形

四、英文释义补全
  Kaikki 17,640 条 → 回填 ms 的 en 字段（原 9,336 → 目标 80%+）
  同时 ms 自带的 en 也并入反向索引，扩大桥接命中面

五、输出格式（与 v0.14 完全一致，运行时 loader.js 零改动）
  ms-xx.txt    : flatkey \t word \t pos \t zh \t en \t ms \t ex \t syn \t ant
  zh-n.txt     : 中文词 \t malay|pos,malay|pos,...
  ze-zh-n.txt  : 中文词 \t eng1,eng2,...
  ze-en-xx.txt : english \t zh1,zh2,...
  py-xx.txt    : pinyin  \t 字1,字2,...
  en-x.txt     : english \t malay|pos,...
  index.txt    : 元信息
"""
import csv
import json
import os
import re
import shutil
import collections

csv.field_size_limit(10 ** 9)

SRC = '/tmp/work/json-backup'
DST = '/root/repo/malay-dict/devices/xiaomi-band-9/source/chinese/src/assets/dict'
CEDICT = '/root/ref/cccedict.txt'
ECDICT = '/root/ref/ecdict.csv'
KAIKKI = '/root/ref/kaikki-malay.jsonl'

LIMIT = 64000                 # 单文件字节上限（64KB ≈ 26ms readText）
FLAT = re.compile(r'[^a-z0-9]')
ZH_MOD = 128                  # zh / ze-zh 桶数
MAXDEF = 8                    # 每个中文键最多保留释义数

# 中文释义的分隔符
ZH_SPLIT = re.compile(r'[，,、；;/]+')
# 功能词黑名单：含这些的 token 不做「包含」匹配
STOP = ('其他', '其它', '形式', '近义', '同义', '变体', '缩写', '简称',
        '复数', '过去式', '过去', '现在式', '等等', '例如', '参见', '另见',
        '一种', '之一', '某个', '任何', '某种', '形容', '用于', '表示',
        '之类', '等的', '以上', '以下', '同义字', '反义')


# ═══════════════════════════ 通用工具 ═══════════════════════════

def flatkey(s):
    return FLAT.sub('', str(s or '').lower())


def sanitize(s):
    if s is None:
        return ''
    return (str(s).replace('\t', ' ').replace('\n', ' ')
            .replace('\r', ' ').replace('\u3000', ' ').strip())


def as_text(v):
    if v is None:
        return ''
    if isinstance(v, list):
        out = []
        for x in v:
            t = sanitize(x).replace(',', ' ').replace('|', ' ')
            if t:
                out.append(t)
        return ','.join(out)
    return sanitize(v).replace(',', ' ').replace('|', ' ')


def dump(path, lines):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))


def bsize(lines):
    return sum(len(x.encode('utf-8')) + 1 for x in lines)


def norm_en(s):
    """英文归一化：小写、去括号补充、去标点"""
    s = (s or '').lower().strip()
    s = re.sub(r'\([^)]*\)', '', s)
    s = re.sub(r'\[[^\]]*\]', '', s)
    s = re.sub(r"[^a-z0-9\-' ]", ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def is_stop(tok):
    for s in STOP:
        if s in tok:
            return True
    return False


# ═══════════════════════════ 中文分词 ═══════════════════════════

def tokens_of(zh):
    """
    中文释义 → token 列表
    ★ 修 v0.14 的 410 行缺 \t bug：释义含换行，必须做空白归一化
    """
    out = []
    zh = re.sub(r'\s+', '', str(zh or ''))        # ← 关键：含 \n 一起清
    for part in ZH_SPLIT.split(zh):
        t = re.sub(r'[（(][^）)]*[）)]', '', part).strip()
        t = re.sub(r'^[·・.\-—]+|[·・.\-—]+$', '', t)
        if not t:
            continue
        if not re.search(r'[\u4e00-\u9fa5]', t):
            continue
        out.append(t)
    return out


# ★ 高频数词/虚词：这些字绝不做「派生」匹配。
#   反例：「一双」→「一」→ `一 → joli`（该词释义「一双，一对」）
#        「一束」→「一」→ `一 → berkas`
#        「不标准」→「不」→ `不 → slanga`
#   但「往返」→「往」、「怀孕」→「怀」是合理的（见 gen_keys ③）
DERIVE_BLOCK = set('一二三四五六七八九十百千万亿两几'
                   '的了着过是在有和与及或但而则就都也还'
                   '不无没别未非最很太更再又'
                   '上中下前后左右里外间'
                   '大小多少长高矮胖瘦'
                   '我你他她它们这那谁哪'
                   '个只条张片块件双对群批'
                   '来去进出到向从往至于以因为所以')


def gen_keys(tok):
    """
    一个 token 能产出哪些中文键
    返回 [(key, level)]：level 1 精确 / 2 前缀 / 3 包含

    ★ 单字键只允许两种来源：
      ① token 恰好就是这一个字（精确，最可信）
      ② 2 字 token 的首字，且该字不在 DERIVE_BLOCK 里
         （「往返」→「往」✓ ；「一双」→「一」✗）
    """
    out = [(tok, 1)]
    # ② 前缀：剥掉尾部「的/地/了/之」（「蓝色的」→「蓝色」）
    stripped = re.sub(r'[的地得了之]+$', '', tok)
    if stripped and stripped != tok and len(tok) - len(stripped) <= 2:
        out.append((stripped, 2))
    if not is_stop(tok):
        # ③ 2 字 token 的首字（排除数词/虚词）
        if len(tok) == 2 and tok[0] not in DERIVE_BLOCK and tok[1] not in DERIVE_BLOCK:
            out.append((tok[0], 3))
        # ④ 3~4 字 token 的 2~3 字前缀
        if 3 <= len(tok) <= 4:
            for L in range(2, len(tok)):
                out.append((tok[:L], 3))
    return out


# ═══════════════════════════ 数据源载入 ═══════════════════════════

def load_ms():
    words = {}
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^ms-[a-z0-9]\.txt$', f):
            continue
        for e in json.load(open(os.path.join(SRC, f), encoding='utf-8')):
            w = sanitize(e.get('w'))
            if w:
                words[w] = e
    return words


def load_cedict():
    """CC-CEDICT: 中文(简体) -> [英文义项]"""
    zh2en = collections.defaultdict(list)
    for line in open(CEDICT, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/$', line)
        if not m:
            continue
        simp = m.group(2)
        for d in m.group(4).split('/'):
            d = d.strip()
            if d:
                zh2en[simp].append(d)
    return zh2en


POS_PREFIX = re.compile(
    r'^\[[^\]]*\]|^(n|v|vt|vi|adj|adv|prep|pron|conj|int|art|num|aux|abbr|suf|pref)\.\s*')
ECD_SPLIT = re.compile(r'[；;，,、/]')


def load_ecdict():
    """
    ECDICT: 中文 -> [英文]（★ 只取「该中文词是释义首段」的英文词，即主释义）
    返回 (zh2en, en_frq)
    en_frq 是英文词频**排名**（越小越常用）
    """
    zh2en = collections.defaultdict(list)
    en_frq = {}
    with open(ECDICT, encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            w = (row.get('word') or '').strip()
            if not w:
                continue
            frq = 0
            for k in ('frq', 'bnc'):
                v = (row.get(k) or '').strip()
                if v.isdigit():
                    frq = max(frq, int(v))
            if frq:
                n = norm_en(w)
                if n:
                    en_frq[n] = min(en_frq.get(n, 10 ** 9), frq)
            tr = (row.get('translation') or '').strip()
            if not tr:
                continue
            # ★ 只看首段：water 的 translation「n. 水；雨水…」→ 首段「水」
            first = ECD_SPLIT.split(tr)[0]
            piece = POS_PREFIX.sub('', first).strip()
            piece = re.sub(r'[\[\]（）()【】]', '', piece).strip()
            piece = re.sub(r'^[·・.\-—\s]+|[·・.\-—\s]+$', '', piece)
            if not (1 <= len(piece) <= 8):
                continue
            if not re.match(r'^[\u4e00-\u9fa5]+$', piece):
                continue
            zh2en[piece].append(w)
    return zh2en, en_frq


def load_kaikki():
    """
    Kaikki 马来语词典
    返回 (en2ms, ms_en)：英文→[马来语词]，马来语词→[英文释义原文]
    """
    en2ms = collections.defaultdict(list)
    ms_en = {}
    for line in open(KAIKKI, encoding='utf-8'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        w = sanitize(o.get('word'))
        if not w:
            continue
        glosses = []
        for s in (o.get('senses') or []):
            for g in (s.get('glosses') or []):
                g = sanitize(g)
                if g:
                    glosses.append(g)
                    for piece in g.split(','):
                        n = norm_en(piece)
                        if n and len(n) <= 40:
                            en2ms[n].append(w)
        if glosses and w.lower() not in ms_en:
            ms_en[w.lower()] = glosses
    return en2ms, ms_en


# ═══════════════════════════ 主流程 ═══════════════════════════

def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST)

    # ---------- 0. 载入 ----------
    words = load_ms()
    print('① 马来语词条 %d 条（原有 en 字段 %d 条）'
          % (len(words), sum(1 for e in words.values() if e.get('en'))))

    cedict = load_cedict()
    ecdict, en_frq = load_ecdict()
    en2ms_k, ms_en = load_kaikki()
    print('   CC-CEDICT 中文键 %d · ECDICT 中文键 %d · 英文词频 %d'
          % (len(cedict), len(ecdict), len(en_frq)))
    print('   Kaikki 英文键 %d · 有释义词条 %d' % (len(en2ms_k), len(ms_en)))

    # ---------- 1. 补英文释义（Kaikki → ms.en）----------
    filled = 0
    for w, e in words.items():
        if e.get('en'):
            continue
        g = ms_en.get(w.lower())
        if g:
            e['en'] = '; '.join(x[:70] for x in g[:3])
            filled += 1
    have_en = sum(1 for e in words.values() if e.get('en'))
    print('② 英文释义补全：+%d → %d 条 (%.1f%%)'
          % (filled, have_en, have_en * 100.0 / len(words)))

    # ---------- 2. 建「英文 → 马来语」反向索引（Kaikki ∪ ms.en）----------
    en2ms = collections.defaultdict(list)
    for n, ws in en2ms_k.items():
        en2ms[n].extend(ws)
    for w, e in words.items():
        for piece in re.split(r'[,;]', e.get('en') or ''):
            n = norm_en(piece)
            if n and len(n) <= 40:
                en2ms[n].append(w)
    for n in en2ms:
        en2ms[n] = list(dict.fromkeys(en2ms[n]))
    print('③ 反向英文索引 %d 键（合并 Kaikki + ms.en）' % len(en2ms))

    # ---------- 3. 中文索引：来源 A（原生精确）----------
    pos_of = {}
    for w, e in words.items():
        p = sanitize(e.get('p'))
        if p:
            pos_of[w] = p
            pos_of[flatkey(w)] = p

    keys = collections.defaultdict(dict)      # key -> {word: level}
    for w, e in words.items():
        for t in tokens_of(e.get('zh')):
            for k, lv in gen_keys(t):
                cur = keys[k].get(w)
                if cur is None or lv < cur:
                    keys[k][w] = lv
    print('④ 来源 A（原生精确分词）: %d 键' % len(keys))

    # ---------- 4. 中文索引：来源 B（桥接）----------
    # ★ ECDICT 的 frq/bnc 是「词频排名」，**数值越小越常用**
    #   （the=1, a=5, one=51, book=241, water=226, palanquin=40166）
    #   实测：门槛放宽到 12000 时桥接精度只有约 45%
    #   （幅度→teropong（望远镜）、因素→kaleng（洋铁）、空头→beruang（熊））
    #   收紧到 5000（真·常用词）后精度明显改善。
    FRQ_MAX = 5000
    # ★ 英文虚词黑名单：这些词义太泛，桥接过去必然出错
    #   往→luar（外面）来自 "to"；书→setiausaha（书记）来自 "book" 的引申
    EN_STOP = set('''a an the to of in on at by for with from into onto
        be am is are was were been being do does did done
        have has had having will would shall should can could may might must
        and or but if then than that this these those there here
        it its he she they them his her their you your i me my we our
        not no nor so as up out off over under again more most very
        one two three many much some any all each every such own same
        make made get got go goes gone come came see seen say said
        use used using take taken give given'''.split())

    def en_ok(n):
        """英文义项是否适合做桥接（排除虚词/超短词）"""
        if n in EN_STOP:
            return False
        if len(n) < 3:
            return False
        return True

    bridge = collections.defaultdict(dict)
    for zh2en, lv in ((cedict, 4), (ecdict, 5)):
        for zh, ens in zh2en.items():
            got = {}
            for en in ens:
                for piece in en.split(';'):
                    n = norm_en(piece)
                    if not n or n not in en2ms or not en_ok(n):
                        continue
                    f = en_frq.get(n)
                    if f is None or f > FRQ_MAX:      # 生僻 / 无记录 → 跳过
                        continue
                    # ★ 每个英文义项只取「第一个」马来语词
                    #   （en2ms 按 Kaikki 出现顺序，首项是该义项最直接的对应）
                    for w in en2ms[n][:1]:
                        cur = got.get(w)
                        if cur is None or lv < cur[0]:
                            got[w] = (lv, n)          # 记下来源英文词
            for w, (v, n) in got.items():
                cur = bridge[zh].get(w)
                if cur is None or v < cur[0]:
                    bridge[zh][w] = (v, n)
    added = 0
    for zh, m in bridge.items():
        # ★ 最终策略：桥接**只补原生完全没有结果的键**。
        #   实测桥接精度约 65%（车辆→kenderaan ✓ 但 往→luar ✗、
        #   书→setiausaha（书记）✗），一旦掺进已有数据的词条就会
        #   拉低整体准确度。宁缺毋滥。
        #   三道过滤：① 仅多字词（单字歧义最大）② 原生为 0 ③ 候选 ≤2
        if len(zh) < 2:
            continue
        if keys.get(zh):
            continue
        added += 1
        picked = 0
        for w, (lv, src_en) in m.items():
            if picked >= 2:
                break
            e = words.get(w)
            if not e or not e.get('p'):
                continue
            # ★ 双向校验：该马来语词自己的英文释义里必须含「来源英文词」
            #   反例：手机 → panca（"hand" 撞上 panca 的 "hand"，
            #        但 panca 的英文里没有 "cell phone"，故被拒）
            own = set()
            for piece in re.split(r'[,;]', e.get('en') or ''):
                n2 = norm_en(piece)
                if n2:
                    own.add(n2)
                    for sub in n2.split(' '):
                        own.add(sub)
            if src_en not in own:
                continue
            keys[zh][w] = lv
            picked += 1
    print('⑤ 来源 B（桥接，词频排名 ≤%d，仅多字词+原生为0+双向校验）: 命中 %d 键，其中新增 %d'
          % (FRQ_MAX, len(bridge), added))
    print('   ★ 合并总中文键: %d （旧 40898）' % len(keys))

    # ---------- 5. 排序 + 输出 zh 桶 ----------
    refcnt = collections.Counter()
    for k, m in keys.items():
        for w in m:
            refcnt[w] += 1

    # 词频加分：桥接项的英文来源词越常用，越可信
    # ★ frq 是排名（越小越常用），要转成「可信度」
    en_trust = {}
    for w, e in words.items():
        best = 0
        for piece in re.split(r'[,;]', e.get('en') or ''):
            n = norm_en(piece)
            f = en_frq.get(n)
            if f:                                  # 有排名记录
                best = max(best, max(0, FRQ_MAX - f) / 400.0)
        en_trust[w] = best

    def score(w, lv):
        e = words.get(w)
        s = (6 - lv) * 3.0                    # lv1=15 lv2=12 lv3=9 lv4=6 lv5=3
        if e and e.get('p'):
            s += 3.0                          # 有词性 → 可信
        s += min(refcnt[w], 20) * 0.15        # 被更多中文键引用 → 更常用
        s -= len(w) * 0.05                    # 短词略优
        if e and e.get('en'):
            s += 0.5                          # 有英文释义 → 数据完整
        s += min(en_trust.get(w, 0), 5.0)     # 常用英文对应的词更可信（最多 +5）
        return s

    zh_groups = collections.defaultdict(list)
    for k, m in keys.items():
        if not k:
            continue
        ordered = sorted(m.items(), key=lambda kv: (-score(kv[0], kv[1]), kv[0]))[:MAXDEF]
        parts = []
        for w, lv in ordered:
            p = pos_of.get(w) or pos_of.get(flatkey(w)) or ''
            parts.append(w + ('|' + p if p else ''))
        zh_groups[str(ord(k[0]) % ZH_MOD)].append((k, k + '\t' + ','.join(parts)))

    for b in sorted(zh_groups, key=lambda x: int(x)):
        rows = sorted(zh_groups[b], key=lambda r: r[0])
        dump(os.path.join(DST, 'zh-%s.txt' % b), [r[1] for r in rows])
    print('⑥ zh 桶 %d 个，最大 %d B'
          % (len(zh_groups), max(bsize([r[1] for r in v]) for v in zh_groups.values())))

    # ---------- 6. ms 词条行 + 切分 ----------
    ms_rows = []
    for w, e in words.items():
        fk = flatkey(w)
        if not fk:
            continue
        cols = [fk, w, sanitize(e.get('p')), as_text(e.get('zh')),
                as_text(e.get('en')), as_text(e.get('ms')), as_text(e.get('ex')),
                as_text(e.get('syn')), as_text(e.get('ant'))]
        while len(cols) > 2 and cols[-1] == '':
            cols.pop()
        ms_rows.append((fk, '\t'.join(cols)))

    raw2 = {}
    for fk, line in ms_rows:
        raw2.setdefault(((fk or '') + 'a')[:2], []).append((fk, line))
    split2 = []
    groups = {}
    for k2 in sorted(raw2):
        # ★ 去重：同 flatkey 只保留一行（不同词形如 abad al-abid / abad alabid
        #   会归到同一 flatkey，产生重复键导致二分查找失效）
        dedup = {}
        for fk, line in raw2[k2]:
            if fk not in dedup:
                dedup[fk] = line
        items = sorted(dedup.items(), key=lambda r: r[0])
        lines = [r[1] for r in items]
        if bsize(lines) <= LIMIT:
            groups[k2] = lines
        else:
            split2.append(k2)
            sub = {}
            for fk, line in items:
                sub.setdefault(((fk or '') + 'aaa')[:3], []).append(line)
            for k3 in sorted(sub):
                groups[k3] = sub[k3]
    for k in sorted(groups):
        dump(os.path.join(DST, 'ms-%s.txt' % k), groups[k])
    ms_keys = sorted(groups)
    print('⑦ ms 切成 %d 片（下钻: %s）最大 %d B'
          % (len(ms_keys), ','.join(split2) or '无', max(bsize(v) for v in groups.values())))

    # ---------- 7. en 桶（英→马，词性内嵌）----------
    # 英文释义补全后 en 键从 8,361 涨到 3 万+，单首字母桶会超 64KB。
    # → 与 ms 一致，按「首字母 + 次字母」切分（loader.loadEn 已同步）
    EN_CAP = 10

    def en_rank(v):
        """英→马候选排序：有词性 > 词形短 > 有中文释义"""
        w = v.split('|')[0]
        e = words.get(w) or {}
        s = 0.0
        if '|' in v:
            s += 3.0
        s -= len(w) * 0.05
        if e.get('zh'):
            s += 0.5
        return -s

    en_groups = collections.defaultdict(lambda: collections.defaultdict(list))
    for w, e in words.items():
        p = sanitize(e.get('p'))
        for piece in re.split(r'[,;]', e.get('en') or ''):
            k = norm_en(piece)
            if not k:
                continue
            v = w + ('|' + p if p else '')
            if v not in en_groups[k[0]][k]:
                en_groups[k[0]][k].append(v)

    en_shards = {}
    for c in sorted(en_groups):
        agg = en_groups[c]
        lines = []
        for k in sorted(agg):
            vals = sorted(agg[k], key=en_rank)[:EN_CAP]
            lines.append(k + '\t' + ','.join(vals))
        if bsize(lines) <= LIMIT:
            en_shards[c] = lines
        else:
            sub = collections.defaultdict(list)
            for ln in lines:
                k2 = (ln.split('\t')[0] + 'a')[:2]
                sub[k2].append(ln)
            for k2 in sorted(sub):
                en_shards[k2] = sub[k2]

    en_max = 0
    n_en_keys = 0
    for k in sorted(en_shards):
        lines = en_shards[k]
        n_en_keys += len(lines)
        en_max = max(en_max, bsize(lines))
        dump(os.path.join(DST, 'en-%s.txt' % k), lines)
    print('⑧ en 桶 %d 个，%d 键（原 8,361），最大 %d B'
          % (len(en_shards), n_en_keys, en_max))

    # ---------- 8. ze-zh / ze-en / py（中英，保持不变）----------
    zz_groups = collections.defaultdict(list)
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^ze-zh-\d+\.txt$', f):
            continue
        for k, v in json.load(open(os.path.join(SRC, f), encoding='utf-8')).items():
            kk = sanitize(k)
            val = as_text(v)
            if kk and val:
                zz_groups[str(ord(kk[0]) % ZH_MOD)].append((kk, kk + '\t' + val))
    for b in sorted(zz_groups, key=lambda x: int(x)):
        rows = sorted(zz_groups[b], key=lambda r: r[0])
        dump(os.path.join(DST, 'ze-zh-%s.txt' % b), [r[1] for r in rows])
    print('⑨ ze-zh 桶 %d 个' % len(zz_groups))

    for pref in ('ze-en', 'py'):
        g = {}
        for f in sorted(os.listdir(SRC)):
            if not re.match(r'^%s-[a-z]\.txt$' % pref, f):
                continue
            o = json.load(open(os.path.join(SRC, f), encoding='utf-8'))
            if pref == 'py':
                o = o.get('py', {})
            for k, v in o.items():
                kk = sanitize(k).lower()
                val = as_text(v)
                if kk and val:
                    g.setdefault(kk[0], []).append((kk, kk + '\t' + val))
        for k in sorted(g):
            rows = sorted(g[k], key=lambda r: r[0])
            dump(os.path.join(DST, '%s-%s.txt' % (pref, k)), [r[1] for r in rows])
        print('   %s 桶 %d 个' % (pref, len(g)))

    # ---------- 9. index.txt ----------
    withZh = sum(1 for ln in ms_rows if len(ln[1].split('\t')) > 3 and ln[1].split('\t')[3])
    withEn = sum(1 for ln in ms_rows if len(ln[1].split('\t')) > 4 and ln[1].split('\t')[4])
    dump(os.path.join(DST, 'index.txt'), [
        'letters\t' + ','.join(ms_keys),
        'split2\t' + ','.join(split2),
        'total\t%d' % len(ms_rows),
        'withZh\t%d' % withZh,
        'withEn\t%d' % withEn,
        'zhKeys\t%d' % len(keys),
        'shardCount\t%d' % len(ms_keys),
    ])

    # ---------- 10. 报告 ----------
    files = [(f, os.path.getsize(os.path.join(DST, f)))
             for f in os.listdir(DST) if f.endswith('.txt')]
    files.sort(key=lambda x: -x[1])
    print('')
    print('--- 结果 ---')
    print(' 文件数 %d   总体积 %d KB' % (len(files), sum(n for _, n in files) // 1024))
    print(' 最大 6 个:')
    for f, n in files[:6]:
        print('   %-18s %7d B  ≈ %2d ms' % (f, n, n * 0.4 / 1024))
    print(' 最坏单次读取 ≈ %d ms' % (files[0][1] * 0.4 / 1024))
    print(' withZh %d · withEn %d' % (withZh, withEn))


if __name__ == '__main__':
    main()