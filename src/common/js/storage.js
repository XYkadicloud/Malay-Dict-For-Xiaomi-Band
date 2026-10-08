/******************************************************************************
 * @file        storage.js
 * @description 键值存储封装：设置 / 收藏 / 历史
 *              所有 value 以 JSON 字符串写入 @system.storage
 ******************************************************************************/

import storage from '@system.storage'

const K_SETTINGS = 'MD_SETTINGS'
const K_FAV = 'MD_FAV'
const K_HISTORY = 'MD_HISTORY'
const K_WRONG = 'MD_WRONG'

const MAX_FAV = 100
const MAX_HISTORY = 50
const MAX_WRONG = 60

const DEFAULT_SETTINGS = {
  vibrate: true,          // 按键振动
  showPhonetic: true,     // 显示音标/词性
  defLang: 'zh',          // ★ 默认原语言：zh | ms | en（目标固定马来语）
  pageSize: 10,           // ★ 每页条数：5 | 10 | 20
  learnCount: 10,         // ★ 每日学习每轮词数：5 | 10 | 15
  retryWrong: true        // ★ 测验答错自动重练（把错词放回队尾）
}

let settingsCache = null
let favCache = null
let historyCache = null

function read(key) {
  return new Promise(function (resolve) {
    try {
      storage.get({
        key: key,
        success: function (data) {
          if (data === undefined || data === null || data === '') {
            resolve(null)
          } else {
            resolve(data)
          }
        },
        fail: function () {
          resolve(null)
        }
      })
    } catch (e) {
      resolve(null)
    }
  })
}

function write(key, value) {
  return new Promise(function (resolve) {
    try {
      storage.set({
        key: key,
        value: value,
        success: function () {
          resolve(true)
        },
        fail: function () {
          resolve(false)
        }
      })
    } catch (e) {
      resolve(false)
    }
  })
}

function parseJSON(text, fallback) {
  if (!text) return fallback
  try {
    const v = JSON.parse(text)
    if (v === null || v === undefined) return fallback
    return v
  } catch (e) {
    return fallback
  }
}

export function init() {
  return Promise.all([loadSettings(), loadFav(), loadHistory()])
}

/* ------------------------------ 设置 ------------------------------ */

export function loadSettings() {
  return read(K_SETTINGS).then(function (text) {
    const saved = parseJSON(text, {})
    const merged = {}
    for (const k in DEFAULT_SETTINGS) merged[k] = DEFAULT_SETTINGS[k]
    for (const k in saved) merged[k] = saved[k]
    settingsCache = merged
    return merged
  })
}

export function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache)
  return loadSettings()
}

export function saveSettings(patch) {
  return getSettings().then(function (s) {
    for (const k in patch) s[k] = patch[k]
    settingsCache = s
    return write(K_SETTINGS, JSON.stringify(s)).then(function () {
      return s
    })
  })
}

/* ------------------------------ 收藏 ------------------------------ */

export function loadFav() {
  return read(K_FAV).then(function (text) {
    const list = parseJSON(text, [])
    favCache = Array.isArray(list) ? list : []
    return favCache
  })
}

export function getFav() {
  if (favCache) return Promise.resolve(favCache)
  return loadFav()
}

export function isFav(word) {
  return getFav().then(function (list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].w === word) return true
    }
    return false
  })
}

export function toggleFav(item) {
  return getFav().then(function (list) {
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i].w === item.w) {
        idx = i
        break
      }
    }
    let added = false
    if (idx >= 0) {
      list.splice(idx, 1)
    } else {
      list.unshift({ w: item.w, zh: item.zh || '', t: Date.now() })
      while (list.length > MAX_FAV) list.pop()
      added = true
    }
    favCache = list
    return write(K_FAV, JSON.stringify(list)).then(function () {
      return added
    })
  })
}

export function clearFav() {
  favCache = []
  return write(K_FAV, JSON.stringify([]))
}

/* ------------------------------ 历史 ------------------------------ */

export function loadHistory() {
  return read(K_HISTORY).then(function (text) {
    const list = parseJSON(text, [])
    historyCache = Array.isArray(list) ? list : []
    return historyCache
  })
}

export function getHistory() {
  if (historyCache) return Promise.resolve(historyCache)
  return loadHistory()
}

export function addHistory(item) {
  if (!item || !item.w) return Promise.resolve([])
  return getHistory().then(function (list) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].w === item.w) list.splice(i, 1)
    }
    list.unshift({ w: item.w, zh: item.zh || '', t: Date.now() })
    while (list.length > MAX_HISTORY) list.pop()
    historyCache = list
    return write(K_HISTORY, JSON.stringify(list)).then(function () {
      return list
    })
  })
}

export function clearHistory() {
  historyCache = []
  return write(K_HISTORY, JSON.stringify([]))
}

/* ------------------------------ 错词本（复习用） ------------------------------ */

let wrongCache = null

export function loadWrong() {
  return read(K_WRONG).then(function (text) {
    const list = parseJSON(text, [])
    wrongCache = Array.isArray(list) ? list : []
    return wrongCache
  })
}

export function getWrong() {
  if (wrongCache) return Promise.resolve(wrongCache)
  return loadWrong()
}

/**
 * 记录答错的词（带去重，重复答错会累计次数 n）
 * @param {{w:string, zh:string}} item
 */
export function addWrong(item) {
  if (!item || !item.w) return Promise.resolve([])
  return getWrong().then(function (list) {
    let hit = null
    for (let i = 0; i < list.length; i++) {
      if (list[i].w === item.w) { hit = list[i]; break }
    }
    if (hit) {
      hit.n = (hit.n || 1) + 1
      hit.t = Date.now()
    } else {
      list.unshift({ w: item.w, zh: item.zh || '', n: 1, t: Date.now() })
      while (list.length > MAX_WRONG) list.pop()
    }
    wrongCache = list
    return write(K_WRONG, JSON.stringify(list)).then(function () {
      return list
    })
  })
}

/** 答对了 → 从错词本移除（说明已掌握） */
export function removeWrong(word) {
  if (!word) return Promise.resolve([])
  return getWrong().then(function (list) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].w === word) list.splice(i, 1)
    }
    wrongCache = list
    return write(K_WRONG, JSON.stringify(list)).then(function () {
      return list
    })
  })
}

export function clearWrong() {
  wrongCache = []
  return write(K_WRONG, JSON.stringify([]))
}
/** ★ 一键清空全部本地数据（设置页用） */
export function clearAllData() {
  settingsCache = null
  favCache = []
  historyCache = []
  wrongCache = []
  return Promise.all([
    write(K_FAV, JSON.stringify([])),
    write(K_HISTORY, JSON.stringify([])),
    write(K_WRONG, JSON.stringify([])),
    write(K_SETTINGS, JSON.stringify(DEFAULT_SETTINGS))
  ]).then(function () {
    return true
  })
}
