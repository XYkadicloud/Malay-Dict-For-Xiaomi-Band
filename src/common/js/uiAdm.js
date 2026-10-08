/******************************************************************************
 * @file        uiAdm.js
 * @description UI 管理：页面注册、提示、时间格式化
 *              基于 ResonaUI (MIT) 的 uiAdm 思路精简重写，适配 Band 9 (192x490)
 ******************************************************************************/

import prompt from '@system.prompt'

const pageMap = {}

export function registerPage(name, vm) {
  if (name) pageMap[name] = vm
}

export function unregisterPage(name) {
  if (name && pageMap[name]) delete pageMap[name]
}

export function getPage(name) {
  return pageMap[name]
}

export function toast(message) {
  const msg = String(message == null ? '' : message)
  try {
    prompt.showToast({ message: msg, duration: 1500 })
  } catch (e) {
    console.log('[toast] ' + msg)
  }
}

export function formatTime(date) {
  const d = date || new Date()
  let h = d.getHours()
  let m = d.getMinutes()
  if (h < 10) h = '0' + h
  if (m < 10) m = '0' + m
  return h + ':' + m
}
