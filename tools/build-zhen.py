#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 CC-CEDICT 构建 中英互译索引 (ze-*.txt)
格式: {"zh2en": {...}, "en2zh": {...}}
CE-DICT 行格式:
  繁体 简体 [pin1 yin1] /eng1/eng2/
只收简体；英文取 /../ 内的内容；中文键取简体词
"""
import json, os, re, glob, sys

DICT = '/root/repo/malay-dict/devices/xiaomi-band-9/source/chinese/src/assets/dict'
SRC = '/root/ref/cccedict.txt'

LINE = re.compile(r'^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s*/(.+)/$')
STRIP = re.compile(r'[\s,;.，。；、！？!?\(\)（）\[\]【】"\']+')

def norm_zh(s):
    return STRIP.sub('', s or '')

def norm_en(s):
    return STRIP.sub(' ', (s or '').lower()).strip()

print('解析 CC-CEDICT ...')
zh2en = {}
en2zh = {}
freq = {}          # 中文词被引用次数（越高越常用）
n_line = 0
ok = 0
with open(SRC, encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        n_line += 1
        m = LINE.match(line)
        if not m:
            continue
        simp = m.group(2).strip()
        py = m.group(3).strip()
        gloss = m.group(4).strip()
        if not simp:
            continue
        # ★ 跳过姓氏/专名条（拼音首字母大写，如 書 书 [Shu1] /abbr. for.../）
        #   否则 水 会拿到 surname、书 会拿到经书缩写
        if py[:1].isupper():
            continue
        # ★ 跳过缩写/变体条
        if re.search(r'^(abbr\.|old variant|variant of|see also|see )', gloss):
            continue
        # 英文候选（按 / 拆分，去掉变体标记如 "old variant of X"）
        parts = [p.strip() for p in gloss.split('/') if p.strip()]
        engs = []
        for p in parts:
            # 保留主体；去掉 "(Tw)" "(Tw)" 等地区标记
            q = re.sub(r'\((Tw|HK| mainland China|dialect|surname|given name|male|female|polite)\)', '', p)
            q = q.split(',')[0].split(';')[0].strip()
            q = re.sub(r'^to ', '', q).strip()
            if q.lower() in ('surname', 'surname.', 'given name', 'variant of', 'old variant'):
                q = ''
            if not q:
                continue
            # 只取前两个词作为键候选
            w = q.split()[0].lower() if q.split() else ''
            w = re.sub(r'[^a-z-]', '', w)
            if len(w) < 2 or len(w) > 20:
                continue
            # 过滤拼音残留 / 非英文噪声
            if not re.match(r'^[a-z][a-z-]*$', w):
                continue
            if w in ('cl', 'er', 'surname', 'variant', 'old', 'see', 'also', 'tw', 'hk'):
                continue
            engs.append(w)
            break   # 只取主释义，避免 "book -> 以斯帖记" 这类污染
        if not engs:
            continue
        if not re.search(r'[\u4e00-\u9fa5]', simp):
            continue
        if len(simp) > 8:
            continue
        ok += 1
        # zh2en: 简体中文 -> 英文词（最多 4 个）
        if simp not in zh2en:
            zh2en[simp] = []
        for e in engs:
            if e not in zh2en[simp] and len(zh2en[simp]) < 4:
                zh2en[simp].append(e)
        # en2zh: 反向收集候选（先全收，最后按词频排序取前 3）
        for e in engs:
            if e not in en2zh:
                en2zh[e] = []
            cur = en2zh[e]
            if simp in cur:
                continue
            if not re.match(r'^[\u4e00-\u9fa5]+$', simp):
                continue
            if len(simp) > 4:
                continue
            if len(cur) < 8:          # 先多收，后面按词频裁
                cur.append(simp)
        # ★ 词频加权：单字/双字词被更多英文词条引用 → 更常用（吃 > 乱吃）
        if len(simp) <= 2:
            freq[simp] = freq.get(simp, 0) + 1

print('CEDICT 行数   : %d' % n_line)
print('有效词条      : %d' % ok)
print('中文键(zh2en) : %d' % len(zh2en))
print('英文键(en2zh) : %d' % len(en2zh))

# ★ 按「词频 + 长度」重排 en2zh 的值，取前 3（吃 > 乱吃 > 上馆子）
for e in list(en2zh.keys()):
    cand = en2zh[e]
    if len(cand) <= 1:
        continue
    cand.sort(key=lambda z: (-freq.get(z, 0), len(z)))
    en2zh[e] = cand[:3]

# ===== 分片写入（按中文键首字 / 英文键首字母）=====
# 与现有方案一致：中文用 26 桶（码位%26），英文按首字母
ZH_MOD = 26
zh_shards = {}
for i in range(ZH_MOD):
    zh_shards[str(i)] = {}
for k, v in zh2en.items():
    b = ord(k[0]) % ZH_MOD
    zh_shards[str(b)][k] = v

en_shards = {}
letters = 'abcdefghijklmnopqrstuvwxyz'
for l in letters:
    en_shards[l] = {}
for k, v in en2zh.items():
    b = k[0] if ('a' <= k[0] <= 'z') else 'x'
    en_shards[b][k] = v

# 加一个 shardIndex 方便前端知道有多少桶
idx = {
    'zhBuckets': ZH_MOD,
    'zhKeys': len(zh2en),
    'enKeys': len(en2zh),
    'enBuckets': len(letters),
    'lang': 'zh<->en (CC-CEDICT, CC BY-SA 3.0)',
    'src': 'https://cc-cedict.org/'
}
with open(os.path.join(DICT, 'ze-index.txt'), 'w', encoding='utf-8') as f:
    json.dump(idx, f, ensure_ascii=False, separators=(',', ':'))

for b, m in zh_shards.items():
    fp = os.path.join(DICT, 'ze-zh-%s.txt' % b)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, separators=(',', ':'))

for l, m in en_shards.items():
    fp = os.path.join(DICT, 'ze-en-%s.txt' % l)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, separators=(',', ':'))

tot = os.path.getsize(os.path.join(DICT, 'ze-index.txt'))
for b in zh_shards: tot += os.path.getsize(os.path.join(DICT, 'ze-zh-%s.txt' % b))
for l in en_shards: tot += os.path.getsize(os.path.join(DICT, 'ze-en-%s.txt' % l))
print('新增分片总大小 : %.1f KB' % (tot / 1024.0))
print('  zh 桶: %d 个, en 桶: %d 个' % (len(zh_shards), len(en_shards)))
print()
print('--- 样本 zh2en ---')
for k in list(zh2en.keys())[:3] + ['吃','猫','狗','水','朋友']:
    if k in zh2en: print('  %s -> %s' % (k, ','.join(zh2en[k])))
print('--- 样本 en2zh ---')
for k in ['eat','cat','dog','water','friend','hello','book']:
    if k in en2zh: print('  %s -> %s' % (k, ','.join(en2zh[k])))
