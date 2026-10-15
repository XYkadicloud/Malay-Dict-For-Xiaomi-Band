#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
translate-proto.py — 「词对词直译」原型（**未集成，仅存档**）

═══════════════════════════════════════════════════════════
状态：原型验证完成，**用户决定不做**，故仅归档供日后参考。
═══════════════════════════════════════════════════════════

一、目的
  评估「把词典变成翻译软件」的可行性。结论：手环上做不了真翻译，
  只能做「翻译助手」（词对词直译 + 明确标注）。

二、两个硬约束（决定天花板）
  ① 手环单块分配上限 1024KB（真机实测）→ 任何 seq2seq 模型都装不下
  ② 词典里多词短语仅 2,703 条（14.2%）→ 语料不足以支撑统计翻译

三、实测结果（v0.15 词典，27,129 个中文键）

  能用的：
    我吃苹果      -> ku makan epal
    我要一杯水     -> ku nak secawan air
    这个多少钱     -> ini berapa harga
    请给我一杯咖啡   -> pinta bagi ku secawan kopi

  崩掉的：
    你会说英语吗    -> lu yuran kata wira nahu morfin
                      （「会」→yuran 会费、「吗」→morfin 吗啡）
    他是我朋友     -> ia ya ku teman

  覆盖率：高频中文词 2,767 个，词典覆盖 2,110 个 = 76.3%

四、若日后要做，缺 6 样
  1. 分词（最长匹配）
  2. 译文组装
  3. 语序调整（中↔马都是 SVO；但马来语定语后置、量词接数词）
  4. 虚词表（吗/了/的/把/被 —— 不能按字面译）
  5. 形态学（马来语黏着语：makan 有 30 个派生）
  6. 输入框放开（search.ux 现为 maxlength=5）

五、失败显示原则（当时提议）
  译不出的字**原样保留并标黄**，而不是硬塞一个错词。
  塞成 morfin 比标问号糟糕得多。
"""
import csv
import glob
import json
import os
import re

DICT = '/root/repo/malay-dict/devices/xiaomi-band-9/source/chinese/src/assets/dict'
SRC = '/tmp/work/json-backup'
ECDICT = '/root/ref/ecdict.csv'

csv.field_size_limit(10 ** 9)


def load_zh():
    """中文键 → [马来语|词性, ...]"""
    zh = {}
    for fp in glob.glob(DICT + '/zh-*.txt'):
        for ln in open(fp, encoding='utf-8'):
            ln = ln.rstrip('\n')
            t = ln.find('\t')
            if t > 0:
                zh[ln[:t]] = ln[t + 1:].split(',')
    return zh


def pick(cands):
    """
    从候选释义里选「最适合直译」的一个。
    优先：有词性 > 词形短 > 无空格
    （对比过「直接取第一个」，效果明显更好）
    """
    best, bs = None, -1e9
    for c in cands:
        w, _, p = c.partition('|')
        s = 0.0
        if p:
            s += 3.0
        s -= len(w) * 0.1
        if ' ' in w:
            s -= 1.0
        if s > bs:
            bs, best = s, w
    return best


def make_segmenter(zh):
    """贪心最长匹配分词器"""
    maxlen = max(len(k) for k in zh)

    def seg(s):
        out, i = [], 0
        while i < len(s):
            hit = None
            for L in range(min(maxlen, len(s) - i), 0, -1):
                if s[i:i + L] in zh:
                    hit = (s[i:i + L], L)
                    break
            if hit:
                out.append(hit[0])
                i += hit[1]
            else:
                out.append(s[i])       # 未命中的字原样保留
                i += 1
        return out
    return seg


def translate(s, zh, seg):
    """逐词直译；未命中的字原样保留（不硬塞错词）"""
    out = []
    for p in seg(s):
        v = zh.get(p)
        out.append(pick(v) if v else p)
    return ' '.join(out)


def coverage(zh):
    """高频中文词的词典覆盖率"""
    common = []
    with open(ECDICT, encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            tr = (row.get('translation') or '').strip()
            if not tr:
                continue
            fr = 0
            for k in ('frq', 'bnc'):
                v = (row.get(k) or '').strip()
                if v.isdigit():
                    fr = max(fr, int(v))
            if fr == 0 or fr > 5000:
                continue
            first = re.split(r'[；;，,、/]', tr)[0]
            first = re.sub(
                r'^\[[^\]]*\]|^(n|v|vt|vi|adj|adv|prep|pron|conj|int|art|num|aux|abbr|suf|pref)\.\s*',
                '', first).strip()
            first = re.sub(r'[\[\]（）()【】]', '', first).strip()
            if 1 <= len(first) <= 6 and re.match(r'^[\u4e00-\u9fa5]+$', first):
                common.append(first)
    common = list(dict.fromkeys(common))
    have = sum(1 for w in common if w in zh)
    return len(common), have


def main():
    zh = load_zh()
    print('中文键 %d' % len(zh))
    seg = make_segmenter(zh)

    print()
    print('=== 直译实测 ===')
    tests = [
        '我吃苹果', '我爱你', '我在学校吃苹果', '今天天气很好',
        '我要一杯水', '这个多少钱', '他是我朋友', '请给我一杯咖啡',
        '你会说英语吗',
    ]
    for s in tests:
        print('  %-12s -> %s' % (s, translate(s, zh, seg)))

    print()
    n, h = coverage(zh)
    print('=== 覆盖率 ===')
    print('  高频中文词 %d 个，词典覆盖 %d (%.1f%%)' % (n, h, h * 100.0 / max(1, n)))


if __name__ == '__main__':
    main()
