#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe-bridge.py — 测量「中→英→马」桥接能补多少覆盖（只测量，不写数据）"""
import json
import os
import re
import collections

CEDICT = '/root/ref/cccedict.txt'
KAIKKI = '/root/ref/kaikki-malay.jsonl'
SRC = '/tmp/work/json-backup'


# ---------------- CC-CEDICT: 中文 -> [英文] ----------------
def load_cedict():
    zh2en = {}
    for line in open(CEDICT, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/$', line)
        if not m:
            continue
        simp, defs = m.group(2), m.group(4)
        en = [d.strip() for d in defs.split('/') if d.strip()]
        if simp and en:
            zh2en.setdefault(simp, []).extend(en)
    return zh2en


# ---------------- Kaikki: 英文 -> [马来语词] ----------------
def norm_en(s):
    s = s.lower().strip()
    s = re.sub(r'\([^)]*\)', '', s)          # 去括号补充
    s = re.sub(r'\[[^\]]*\]', '', s)
    s = re.sub(r'[^a-z0-9\-\' ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


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
                # 主义：取第一个逗号前的片段
                for piece in g.split(','):
                    n = norm_en(piece)
                    if n and len(n) <= 40:
                        en2ms[n].append(w)
    return en2ms


# ---------------- ms 词库 ----------------
def load_ms():
    words = {}
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^ms-[a-z0-9]\.txt$', f):
            continue
        for e in json.load(open(os.path.join(SRC, f), encoding='utf-8')):
            w = e.get('w')
            if w:
                words[w] = e
    return words


def main():
    zh2en = load_cedict()
    print('CC-CEDICT 中文词条: %d' % len(zh2en))
    en2ms = load_kaikki()
    print('Kaikki 英文键: %d' % len(en2ms))
    words = load_ms()
    print('马来语词条: %d' % len(words))

    # 现有精确索引（来源 A）
    A = set()
    for f in os.listdir('/tmp/work/zh-new'):
        for ln in open(os.path.join('/tmp/work/zh-new', f), encoding='utf-8'):
            t = ln.find('\t')
            if t > 0:
                A.add(ln[:t])
    print('来源 A（精确分词）: %d 键' % len(A))

    # 桥接：中文 -> 英文 -> 马来语
    bridge = {}
    hit_terms = 0
    for zh, ens in zh2en.items():
        got = []
        for en in ens:
            for piece in en.split(';'):
                n = norm_en(piece)
                if n and n in en2ms:
                    hit_terms += 1
                    got.extend(en2ms[n])
        if got:
            bridge[zh] = list(dict.fromkeys(got))

    print('桥接命中中文键: %d （累计英文命中 %d 次）' % (len(bridge), hit_terms))

    new_keys = set(bridge) - A
    print()
    print('=== 桥接能新增的键: %d ===' % len(new_keys))
    for k in list(new_keys)[:20]:
        print('  %-8s -> %s' % (k, ','.join(bridge[k])[:70]))

    # 质量抽查：桥接的键里，那些是「常用词」
    common = ['害', '炬', '榄球', '用出租', '怀', '往', '爱', '恨', '城市', '医生',
              '电脑', '手机', '苹果', '火车', '飞机', '银行', '警察', '律师']
    print()
    print('=== 常用词桥接结果 ===')
    for c in common:
        src = 'A' if c in A else ('桥接' if c in bridge else '缺')
        v = bridge.get(c, [])
        print('  %-6s [%s] -> %s' % (c, src, ','.join(v)[:60]))


if __name__ == '__main__':
    main()