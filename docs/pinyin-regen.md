# 拼音映射表重新生成指南

`tools/pinyin-map.js` 是**汉字 → 拼音（无声调）**的静态映射表，供 `tools/build-dict.js`
生成中文反查索引（`py` 表）时使用。

**运行时（手环上）不需要它**，它只在构建阶段使用，因此不会打进 RPK。

---

## 什么时候需要重新生成

当 `tools/seed-words.js` 中新增的**中文释义引入了 `pinyin-map.js` 里没有的汉字**时。

`build-dict.js` 会输出「无拼音 N」计数，若 N > 0 说明有汉字缺拼音。

---

## 生成步骤

### 1. 提取种子词库中的全部汉字

```bash
cd ~/repo/malay-dict/devices/xiaomi-band-9/source/chinese
node -e "
const seed=require('./tools/seed-words.js')
const set={}
for(const l of seed){
  const p=String(l).split('|')
  const chars=(p[2]||'').match(/[\u4e00-\u9fa5]/g)||[]
  for(const c of chars) set[c]=1
}
const a=Object.keys(set).sort()
console.log('COUNT='+a.length)
require('fs').writeFileSync('/tmp/hanzi.txt',a.join(''))
"
```

### 2. 安装 pinyin-pro（一次性，临时目录）

```bash
mkdir -p /tmp/pygen && cd /tmp/pygen
echo '{"name":"pygen","version":"1.0.0"}' > package.json
npm install pinyin-pro --registry=https://registry.npmmirror.com/ --cache /tmp/npmcache
```

### 3. 生成映射表

```bash
cd /tmp/pygen && node -e "
const {pinyin}=require('pinyin-pro')
const fs=require('fs')
const hanzi=fs.readFileSync('/tmp/hanzi.txt','utf8')
const out={}
let miss=0
for(const ch of hanzi){
  const py=pinyin(ch,{toneType:'none',type:'array'})
  if(py&&py[0]){ out[ch]=py[0].replace(/[^a-z]/g,'') } else { miss++ }
}
fs.writeFileSync('/tmp/pinyin-map.json',JSON.stringify(out))
console.log('total='+Object.keys(out).length+' miss='+miss)
"
```

### 4. 写成 JS 模块

```bash
cd /tmp/pygen && node -e "
const fs=require('fs')
const map=JSON.parse(fs.readFileSync('/tmp/pinyin-map.json','utf8'))
let out='/******************************************************************************\n'
out+=' * @file        pinyin-map.js\n'
out+=' * @description 汉字 → 拼音（无声调）映射表\n'
out+=' *              由 tools/ 构建脚本生成，仅收录种子词库出现过的汉字。\n'
out+=' *              共 '+Object.keys(map).length+' 字。拼音数据来源 pinyin-pro (MIT)。\n'
out+=' ******************************************************************************/\n\n'
out+='module.exports = {\n'
const keys=Object.keys(map)
for(let i=0;i<keys.length;i++){
  out+='  '+JSON.stringify(keys[i])+': '+JSON.stringify(map[keys[i]])
  out+=(i<keys.length-1?',':'')+'\n'
}
out+='}\n'
fs.writeFileSync('/tmp/pinyin-map.js',out)
"
```

### 5. 覆盖并重建

```bash
cp /tmp/pinyin-map.js tools/pinyin-map.js
node tools/build-dict.js      # 检查「无拼音」应为 0
node tools/verify-dict.js     # 应全部通过
rm -rf /tmp/pygen /tmp/hanzi.txt /tmp/pinyin-map.json
```

---

## 已知限制

**多音字只取第一个读音。** 例如「行」在 pinyin-pro 默认返回 `xing`，但「银行」应为 `yinhang`。
当前 557 字中未发现影响反查的关键多音字，扩库后需抽查。

若出现多音字问题，可在 `pinyin-map.js` 中手动修正对应条目的拼音值。

---

*最后更新：2026-10-06*