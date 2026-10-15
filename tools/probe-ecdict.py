#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe-ecdict.py — 测 ECDICT 反向桥接：中文词白名单 + 覆盖率（只测量）"""
import json
import os
import re
import csv
import collections

csv.field_size_limit(10 ** 9)

CEDICT = '/root/ref/cccedict.txt'
ECDICT = '/root/ref/ecdict.csv'
KAIKKI = '/root/ref/kaikki-malay.jsonl'

POS_PREFIX = re.compile(r'^\[[^\]]*\]|^(n|v|vt|vi|adj|adv|prep|pron|conj|int|art|num|aux|abbr|suf|pref)\.\s*')
SPLIT_ZH = re.compile(r'[；;，,、/]')


def norm_en(s):
    s = (s or '').lower().strip()
    s = re.sub(r'\([^)]*\)', '', s)
    s = re.sub(r'\[[^\]]*\]', '', s)
    s = re.sub(r'[^a-z0-9\-\' ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def load_cedict():
    zh2en = collections.defaultdict(list)
    for line in open(CEDICT, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/$', line)
        if not m:
            continue
        for d in m.group(4).split('/'):
            d = d.strip()
            if d:
                zh2en[m.group(2)].append(d)
    return zh2en


def load_ecdict():
    """返回 (zh2en, zh_freq)：中文词 -> [英文]，中文词 -> 频度"""
    zh2en = collections.defaultdict(list)
    zh_freq = {}
    n = 0
    with open(ECDICT, encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            n += 1
            w = (row.get('word') or '').strip()
            tr = (row.get('translation') or '').strip()
            if not w or not tr:
                continue
            frq = 0
            for k in ('frq', 'bnc'):
                v = (row.get(k) or '').strip()
                if v.isdigit():
                    frq = max(frq, int(v))
            # 从中文翻译里抽中文词
            for raw in SPLIT_ZH.split(tr):
                piece = POS_PREFIX.sub('', raw).strip()
                piece = re.sub(r'[\[\]（）()【】]', '', piece).strip()
                piece = re.sub(r'^[·・.\-—\s]+|[·・.\-—\s]+$', '', piece)
                if not (1 <= len(piece) <= 8):
                    continue
                if not re.match(r'^[\u4e00-\u9fa5]+$', piece):
                    continue
                zh2en[piece].append(w)
                if frq > zh_freq.get(piece, 0):
                    zh_freq[piece] = frq
    print('ECDICT 总行 %d' % n)
    return zh2en, zh_freq


def load_kaikki():
    en2ms = collections.defaultdict(list)
    for line in open(KAIKKI, encoding='utf-8'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        w = (o.get('word') or '').strip()
        if not w:
            continue
        for s in (o.get('senses') or []):
            for g in (s.get('glosses') or []):
                for piece in g.split(','):
                    nn = norm_en(piece)
                    if nn and len(nn) <= 40:
                        en2ms[nn].append(w)
    return en2ms


def main():
    ced = load_cedict()
    print('CEDICT 中文键: %d' % len(ced))
    ecd, ecd_freq = load_ecdict()
    print('ECDICT 中文键: %d' % len(ecd))
    en2ms = load_kaikki()
    print('Kaikki 英文键: %d' % len(en2ms))

    whitelist = set(ced) | set(ecd)
    print()
    print('中文词白名单（CEDICT ∪ ECDICT）: %d' % len(whitelist))

    # 桥接
    def bridge(zh2en):
        out = {}
        for zh, ens in zh2en.items():
            got = []
            for en in ens:
                for piece in en.split(';'):
                    nn = norm_en(piece)
                    if nn and nn in en2ms:
                        got.extend(en2ms[nn])
            if got:
                out[zh] = list(dict.fromkeys(got))
        return out

    b1 = bridge(ced)
    b2 = bridge(ecd)
    print('CEDICT 桥接命中: %d' % len(b1))
    print('ECDICT 桥接命中: %d' % len(b2))
    allb = set(b1) | set(b2)
    print('合并桥接命中: %d' % len(allb))

    # 来源 A
    A = set()
    for f in os.listdir('/tmp/work/zh-new'):
        for ln in open(os.path.join('/tmp/work/zh-new', f), encoding='utf-8'):
            t = ln.find('\t')
            if t > 0:
                A.add(ln[:t])
    print('来源 A（精确分词）: %d' % len(A))

    total = len(A | allb)
    print()
    print('★ 合并总键数: %d （目标 60000+）' % total)

    # 覆盖率检查：白名单里的「常用中文词」（ECDICT frq>0）有多少能出结果
    common = {k for k, f in ecd_freq.items() if f > 0}
    have = (A | allb) & common
    print('常用中文词（ECDICT 有词频）: %d，其中可出结果: %d (%.1f%%)'
          % (len(common), len(have), len(have) * 100.0 / max(1, len(common))))

    # 抽查常用词
    print()
    print('=== 常用词覆盖抽查 ===')
    chk = ['害', '炬', '怀', '往', '爱', '城市', '医生', '电脑', '手机', '苹果',
           '火车', '飞机', '银行', '警察', '律师', '图书馆', '医院', '音乐',
           '研究', '政府', '经济', '文化', '教育', '环境', '技术', '新闻']
    for c in chk:
        srcs = []
        if c in A:
            srcs.append('A')
        if c in b1:
            srcs.append('C')
        if c in b2:
            srcs.append('E')
        v = (b1.get(c) or b2.get(c) or [])[:5]
        print('  %-6s [%-5s] %s' % (c, '+'.join(srcs) or '缺', ','.join(v)[:58]))


if __name__ == '__main__':
    main()