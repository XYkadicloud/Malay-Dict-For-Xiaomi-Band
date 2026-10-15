#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-v14.py — v0.14 最终数据构建（行式纯文本 + 词性内嵌 + 细切分）

依据《小米手环 9 真机实测数据》：
  · JSON 膨胀 5.7x，纯文本 0.74x        → 用纯文本
  · readText ≈ 0.4ms/KB（实测 72ms/178KB）→ 单文件必须切小
  · 原生 indexOf ≈ 0.1ms                 → 用 indexOf 定位，不做 JS 扫描
  · 对象属性查找 45.3us                  → 少建对象

★ 两个关键设计

 ① 词性内嵌（zh / en 桶带 |pos）
    原来 zh2ms：查桶得词 → 再逐词读 ms 分片取词性
    → 结果跨字母时要读 6~12 个分片（6×45ms = 270ms+）
    现在：零额外分片读取。

 ② 细切分（单文件 ≤ 40KB ≈ 16ms）
    ms    : (flatkey+'a')[:2]；超 40KB 的再下钻到 3 字符（记入 split2）
    zh    : 首字码位 % 128
    ze-zh : 首字码位 % 128
    ze-en : (word+'a')[:2]
    py    : (pinyin+'a')[:2]
    en    : 首字母

行格式：
  ms-xx.txt    : flatkey \t word \t pos \t zh \t en \t ms \t ex \t syn \t ant
  zh-n.txt     : 中文词 \t malay|pos,malay|pos,...
  ze-zh-n.txt  : 中文词 \t eng1,eng2,...
  ze-en-xx.txt : english \t zh1,zh2,...
  py-xx.txt    : pinyin  \t 字1,字2,...
  en-x.txt     : english \t malay|pos,...
"""
import json
import os
import re
import shutil

SRC = '/tmp/work/json-backup'
DST = '/root/repo/malay-dict/devices/xiaomi-band-9/source/chinese/src/assets/dict'
LIMIT = 64000           # 单文件字节上限（64KB ≈ 26ms readText）
FLAT = re.compile(r'[^a-z0-9]')
ZH_MOD = 128


def flatkey(s):
    return FLAT.sub('', str(s or '').lower())


def sanitize(s):
    if s is None:
        return ''
    return str(s).replace('\t', ' ').replace('\n', ' ').replace('\r', ' ').strip()


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


def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST)

    # ============ ① 读 ms 分片：建词性映射 + 词条行 ============
    pos_of = {}
    ms_rows = []           # (flatkey, line)
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^ms-[a-z0-9]\.txt$', f):
            continue
        for e in json.load(open(os.path.join(SRC, f), encoding='utf-8')):
            w = sanitize(e.get('w'))
            if not w:
                continue
            fk = flatkey(w)
            if not fk:
                continue
            p = sanitize(e.get('p'))
            if p:
                pos_of[w] = p
                pos_of[fk] = p
            cols = [fk, w, p, as_text(e.get('zh')), as_text(e.get('en')),
                    as_text(e.get('ms')), as_text(e.get('ex')),
                    as_text(e.get('syn')), as_text(e.get('ant'))]
            while len(cols) > 2 and cols[-1] == '':
                cols.pop()
            ms_rows.append((fk, '\t'.join(cols)))
    print('① ms 词条 %d 条，词性映射 %d 条' % (len(ms_rows), len(pos_of)))

    # ============ ② ms 切分（2 字符为主，超标下钻 3 字符）============
    raw2 = {}
    for fk, line in ms_rows:
        raw2.setdefault(((fk or '') + 'a')[:2], []).append((fk, line))

    split2 = []
    groups = {}
    for k2 in sorted(raw2):
        items = sorted(raw2[k2], key=lambda r: r[0])
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
    print('② ms 切成 %d 片（下钻: %s）最大 %d B'
          % (len(ms_keys), ','.join(split2) or '无', max(bsize(v) for v in groups.values())))

    # ============ ③ zh 桶（词性内嵌，首字码位 % 128）============
    zh_groups = {}
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^zh-\d+\.txt$', f):
            continue
        m = json.load(open(os.path.join(SRC, f), encoding='utf-8')).get('zh2ms', {})
        for k, v in m.items():
            kk = sanitize(k)
            if not kk:
                continue
            parts = []
            for w in (v if isinstance(v, list) else [v]):
                ww = sanitize(w)
                if not ww:
                    continue
                p = pos_of.get(ww) or pos_of.get(flatkey(ww)) or ''
                parts.append(ww + ('|' + p if p else ''))
            if parts:
                zh_groups.setdefault(str(ord(kk[0]) % ZH_MOD), []).append((kk, kk + '\t' + ','.join(parts)))
    for k in sorted(zh_groups, key=lambda x: int(x)):
        rows = sorted(zh_groups[k], key=lambda r: r[0])
        dump(os.path.join(DST, 'zh-%s.txt' % k), [r[1] for r in rows])
    print('③ zh 桶 %d 个，最大 %d B' % (len(zh_groups), max(bsize([r[1] for r in v]) for v in zh_groups.values())))

    # ============ ④ en 桶（词性内嵌，首字母）============
    en_groups = {}
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^en-[a-z]\.txt$', f):
            continue
        m = json.load(open(os.path.join(SRC, f), encoding='utf-8')).get('en2ms', {})
        for k, v in m.items():
            kk = sanitize(k).lower()
            if not kk:
                continue
            parts = []
            for w in (v if isinstance(v, list) else [v]):
                ww = sanitize(w)
                if not ww:
                    continue
                p = pos_of.get(ww) or pos_of.get(flatkey(ww)) or ''
                parts.append(ww + ('|' + p if p else ''))
            if parts:
                en_groups.setdefault(kk[0], []).append((kk, kk + '\t' + ','.join(parts)))
    for k in sorted(en_groups):
        rows = sorted(en_groups[k], key=lambda r: r[0])
        dump(os.path.join(DST, 'en-%s.txt' % k), [r[1] for r in rows])
    print('④ en 桶 %d 个，最大 %d B' % (len(en_groups), max(bsize([r[1] for r in v]) for v in en_groups.values())))

    # ============ ⑤ ze-zh（% 128）+ ze-en / py（首字母级，总量小不值得细分）============
    zz_groups = {}
    for f in sorted(os.listdir(SRC)):
        if not re.match(r'^ze-zh-\d+\.txt$', f):
            continue
        o = json.load(open(os.path.join(SRC, f), encoding='utf-8'))
        for k, v in o.items():
            kk = sanitize(k)
            val = as_text(v)
            if kk and val:
                zz_groups.setdefault(str(ord(kk[0]) % ZH_MOD), []).append((kk, kk + '\t' + val))
    for k in sorted(zz_groups, key=lambda x: int(x)):
        rows = sorted(zz_groups[k], key=lambda r: r[0])
        dump(os.path.join(DST, 'ze-zh-%s.txt' % k), [r[1] for r in rows])
    print('⑤ ze-zh 桶 %d 个，最大 %d B' % (len(zz_groups), max(bsize([r[1] for r in v]) for v in zz_groups.values())))

    # ze-en / py 总量小（&lt;0.5MB），按首字母一片即可（~20KB，读一次约 8ms）
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
        print('   %s 桶 %d 个，最大 %d B' % (pref, len(g), max(bsize([r[1] for r in v]) for v in g.values())))

    # ============ ⑥ index.txt ============
    withZh = sum(1 for k in ms_keys for ln in open(os.path.join(DST, 'ms-%s.txt' % k), encoding='utf-8').read().split('\n') if ln and len(ln.split('\t')) > 3 and ln.split('\t')[3])
    withEn = sum(1 for k in ms_keys for ln in open(os.path.join(DST, 'ms-%s.txt' % k), encoding='utf-8').read().split('\n') if ln and len(ln.split('\t')) > 4 and ln.split('\t')[4])
    dump(os.path.join(DST, 'index.txt'), [
        'letters\t' + ','.join(ms_keys),
        'split2\t' + ','.join(split2),
        'total\t%d' % len(ms_rows),
        'withZh\t%d' % withZh,
        'withEn\t%d' % withEn,
        'shardCount\t%d' % len(ms_keys)
    ])

    # ============ 报告 ============
    files = [(f, os.path.getsize(os.path.join(DST, f))) for f in os.listdir(DST) if f.endswith('.txt')]
    files.sort(key=lambda x: -x[1])
    print('')
    print('--- 结果 ---')
    print(' 文件数 %d   总体积 %d KB' % (len(files), sum(n for _, n in files) // 1024))
    print(' 最大 8 个（readText ≈ 0.4ms/KB）:')
    for f, n in files[:8]:
        print('   %-18s %7d B  ≈ %2d ms' % (f, n, n * 0.4 / 1024))
    print(' 最坏单次读取 ≈ %d ms' % (files[0][1] * 0.4 / 1024))


if __name__ == '__main__':
    main()