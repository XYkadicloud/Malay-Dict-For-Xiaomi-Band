# 数据来源与许可证

本项目为**离线词典**，词库数据是核心资产。以下为全部第三方来源与合规义务。

---

## 一、代码组件

### 1. InputMethod.ux（马来语键盘）

- **来源**：[NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)
- **许可证**：MIT License（已核实仓库 LICENSE 文件）
- **改动**：移除中文拼音 / 日文罗马字 / T9 / circle / rect 布局；由横向滚动全键盘改为固定 6 列压缩 QWERTY；新增 shift 与符号页
- **义务**：保留原始版权声明与 MIT 许可证文本

### 2. uiAdm.js / storage.js

- **来源**：参考 [MingChengNetworkStudio/ResonaUI](https://github.com/MingChengNetworkStudio/ResonaUI) 的架构思路**重写**
- **许可证**：MIT
- **说明**：原 ResonaUI 的 `uiAdm.js` 与 `download.js` 为 MPL-2.0-only，本项目未复制其代码，仅参考接口设计后独立实现，因此不受 MPL 约束
- **义务**：保留 MIT 声明

### 3. pinyin-map.js（汉字→拼音）

- **来源**：[pinyin-pro](https://github.com/zh-lx/pinyin-pro)
- **许可证**：MIT
- **生成方式**：构建时用 pinyin-pro 批量转换，输出静态映射表（运行时**不依赖**该库）
- **义务**：保留 MIT 声明

### 4. vela-watch-design 键盘图片资源

- **来源**：Operit skill `vela-watch-design/assets/components/InputMethod/assets/arc/`
- **用途**：键盘功能键图标（空格、删除、大小写等）
- **状态**：待核实原始来源与许可证

---

## 二、词库数据

### 当前状态（P0/P1）

种子词库 `tools/seed-words.js`（436 条）为**人工整理**，释义与例句参考公开词典资料后重写。
中文释义属**二次构建**，部分条目为机器辅助整理。

> ⚠️ **发布前必须**：对高频词做人工校对，并在 App 内标注数据来源与许可。

### 计划引入的数据源

| 来源 | 内容 | 许可证 | 商用 | 修改 | 署名 | 可打包 |
|---|---|---|---|---|---|---|
| [Kaikki.org](https://kaikki.org/dictionary/Malay/) | 马来语词条（英文 Wiktionary 抽取） | CC BY-SA 4.0 (+GFDL) | ✅ | ✅ | **必须**署名 + 链接 | ✅ 但**衍生数据须同许可** |
| [Tatoeba](https://tatoeba.org/) | 马来语例句 | CC BY 2.0 FR（部分 CC0） | ✅ | ✅ | **必须**署名 + 链 tatoeba.org | ✅ |
| [CC-CEDICT](https://cc-cedict.org/) | 汉英词典（英→中桥接） | CC BY-SA 4.0 | ✅ | ✅ | **必须**署名 | ✅ 许可证版本待核实 |
| DBP / PRPM / Kamus Dewan | 权威马来语词典 | 版权保留，**无开放许可** | ❌ | ❌ | — | **❌ 不可用** |
| 商业词典（Kamus Pro 等） | — | 商业版权 | ❌ | ❌ | — | ❌ |

### 中文释义构建路线

Kaikki 的马来语词条只有**英文释义**，没有中文。三条路线：

1. **Wiktionary 翻译表匹配** — 用英文释义去匹配英文 Wiktionary 的 Mandarin 翻译表（覆盖率中，质量较好）
2. **CC-CEDICT 反查** — 覆盖率低
3. **机器翻译 + 人工抽检** — 覆盖率高，质量参差

**当前选择**：① 为主 + ③ 兜底，高频词人工校对。UI 上标注「机器辅助」。

---

## 三、CC BY-SA 的传染性说明

若词库数据源自 Kaikki（CC BY-SA 4.0），则：

- **词库衍生数据**（分片 JSON、中文索引）必须**同样以 CC BY-SA 4.0 发布**
- **代码**（`.ux` / `.js`）可保持 MIT，与词库分开声明
- 必须提供**署名页**，包含：来源名称、作者、许可证名称、许可证链接、是否修改

### 建议的署名文本

```
本应用的词库数据部分来源于：

• Wiktionary / Kaikki.org
  马来语词条数据，由 Wiktextract 从英文 Wiktionary 抽取
  https://kaikki.org/dictionary/Malay/
  许可证：CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/
  修改说明：提取词条释义，并二次构建中文释义

• Tatoeba
  马来语例句
  https://tatoeba.org/
  许可证：CC BY 2.0 FR — https://creativecommons.org/licenses/by/2.0/fr/

• pinyin-pro
  汉字拼音数据
  https://github.com/zh-lx/pinyin-pro
  许可证：MIT

本项目代码以 MIT 许可证发布。
词库数据以 CC BY-SA 4.0 许可证发布。
```

---

## 四、发布前合规检查清单

- [ ] App 内「关于」页含完整署名与许可证链接
- [ ] 仓库根目录放 `NOTICE` 文件
- [ ] 若引入 Kaikki 数据：词库文件附 CC BY-SA 4.0 声明
- [ ] 若引入 Tatoeba 例句：例句来源标注
- [ ] 保留 `InputMethod.ux` 的 MIT 版权头
- [ ] 不使用 DBP / Kamus Dewan / 商业词典的任何内容
- [ ] 若复用了 BandLingo（GPLv3）的代码：本项目须整体 GPLv3 开源（**当前未复用**）

---

*最后更新：2026-10-06*