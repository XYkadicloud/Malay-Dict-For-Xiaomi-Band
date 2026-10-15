#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理马来语分片的元数据污染 + Kaikki 补英文"""
import json, os, re, glob

DICT = '/root/repo/malay-dict/devices/xiaomi-band-9/source/chinese/src/assets/dict'

EN_META = re.compile(
    r'^(third-person|second-person|first-person|first-person and|plural of|singular of|'
    r'alternative form|nonstandard|non-standard|obsolete|dated form|archaic|active of|passive of|'
    r'superlative|comparative of|comparison of|syllabic abbreviation|inflection of|form of|'
    r'gerund of|participle of|synonym of|antonym of|hyponym of|hypernym of|ablaut|'
    r'initialism of|acronym of|abbreviation of|determiner form|feminine of|masculine of|'
    r'neuter of|diminutive of|augmentative of|verbal noun|adjectival form|adverbial form|'
    r'plural form|genitive of|nominative of|accusative of|present participle|past participle|to be )',
    re.I)

ZH_TAG = re.compile(
    r'^(复数|单数|过时的|废弃的|不标准的|非标准的|人名|姓名|姓氏|首字母缩拼词|首字母缩写|'
    r'缩写词|缩略形式|变体|异体|被动|主动|最高级|比较级|所有格|复数形式|单数形式|'
    r'形容词形式|副词形式|动词形式|名词形式)[；;，,、\s]*')

ZH_META_ONLY = re.compile(
    r'^(复数|单数|过时的|废弃的|不标准的|非标准的|人名|姓名|姓氏|首字母缩拼词|首字母缩写|'
    r'缩写词|缩略形式|变体|异体|被动|主动|最高级|比较级|所有格|复数形式|单数形式|'
    r'形容词形式|副词形式|动词形式|名词形式)$')

# Kaikki 英文表（glosses + raw_glosses 兜底）
kk = {}
for line in open('/root/ref/kaikki-malay.jsonl', encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    w = (d.get('word') or '').lower()
    if not w:
        continue
    en = ''
    for s in (d.get('senses') or []):
        for g in (s.get('glosses') or []):
            en = str(g).strip()
            if en:
                break
        if not en:
            for rg in (s.get('raw_glosses') or []):
                t = str(rg).strip()
                if t:
                    en = t
                    break
        if en:
            break
    if en and w not in kk:
        kk[w] = en
print('Kaikki 词条: %d' % len(kk))

def tidy_en(s):
    if not s:
        return ''
    s = s.strip()
    if not s or EN_META.match(s):
        return ''
    if len(s) > 60:
        s = s[:57].rstrip(' ,;，，、') + '…'
    return s

def clean_zh(s):
    if not s:
        return ''
    t = str(s).strip()
    if not t:
        return ''
    out = ZH_TAG.sub('', t).strip(' ;；,，、')
    if not out or ZH_META_ONLY.match(out):
        return ''
    if len(out) > 40:
        out = out[:37].rstrip(' ;；,，、') + '…'
    return out

files = sorted(glob.glob(os.path.join(DICT, 'ms-*.txt')))
st = dict(total=0, en_meta=0, en_kk=0, zh_cleaned=0, zh_meta_only=0, dropped=0)
for fp in files:
    lst = json.load(open(fp, encoding='utf-8'))
    out = []
    for e in lst:
        if not e or not e.get('w'):
            st['dropped'] += 1
            continue
        st['total'] += 1
        w = str(e['w'])

        raw_en = str(e.get('en') or '').strip()
        if raw_en and EN_META.match(raw_en):
            e['en'] = ''
            st['en_meta'] += 1
        if not str(e.get('en') or '').strip():
            k = kk.get(w.lower())
            if k:
                t = tidy_en(k)
                if t:
                    e['en'] = t
                    st['en_kk'] += 1

        raw_zh = str(e.get('zh') or '').strip()
        if raw_zh:
            c = clean_zh(raw_zh)
            if not c:
                st['zh_meta_only'] += 1
            if c != raw_zh:
                st['zh_cleaned'] += 1
            e['zh'] = c

        en_f = str(e.get('en') or '').strip()
        zh_f = str(e.get('zh') or '').strip()
        if not en_f and not zh_f:
            st['dropped'] += 1
            continue
        out.append(e)
    json.dump(out, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

print('')
print('总词条        : %d' % st['total'])
print('en 元数据清理  : %d' % st['en_meta'])
print('en Kaikki 补  : %d' % st['en_kk'])
print('zh 清理       : %d' % st['zh_cleaned'])
print('zh 纯元数据清空 : %d' % st['zh_meta_only'])
print('丢弃无义词条  : %d' % st['dropped'])
