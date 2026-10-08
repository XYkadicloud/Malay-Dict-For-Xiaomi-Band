/******************************************************************************
 * @file        lang.js
 * @description 语言/模式管理：马→中、中→马、马→英 三种查询方向
 ******************************************************************************/

export const MODE_MS2ZH = 'ms2zh'   // 马来语 → 中文
export const MODE_ZH2MS = 'zh2ms'   // 中文 → 马来语
export const MODE_MS2EN = 'ms2en'   // 马来语 → 英文

const ORDER = [MODE_MS2ZH, MODE_ZH2MS, MODE_MS2EN]

const LABEL = {
  ms2zh: '马→中',
  zh2ms: '中→马',
  ms2en: '马→英'
}

const SUB = {
  ms2zh: '马来语 → 中文',
  zh2ms: '中文 → 马来语',
  ms2en: '马来语 → 英文'
}

const PH = {
  ms2zh: '输马来语，如 makan',
  zh2ms: '输中文或拼音，如 吃 / chi',
  ms2en: '输马来语，看英文释义'
}

export function nextMode(cur) {
  const i = ORDER.indexOf(cur)
  if (i < 0) return MODE_MS2ZH
  return ORDER[(i + 1) % ORDER.length]
}

export function modeLabel(m) {
  return LABEL[m] || '马→中'
}

export function modeSub(m) {
  return SUB[m] || SUB.ms2zh
}

export function modePlaceholder(m) {
  return PH[m] || PH.ms2zh
}

/** 该模式是否需要显示拼音候选 */
export function needCandidates(m) {
  return m === MODE_ZH2MS
}

/** 该模式是否按汉字/拼音输入 */
export function isChineseInput(m) {
  return m === MODE_ZH2MS
}