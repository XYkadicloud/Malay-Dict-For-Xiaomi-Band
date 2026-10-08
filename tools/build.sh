#!/usr/bin/env bash
# 马来语词典 · 一键构建与验证
# 用法：bash tools/build.sh
#
# 注意：必须在已安装 node_modules 的工程根目录执行
#       （即包含 package.json 的目录）

set +e

cd "$(dirname "$0")/.." || exit 1

echo "=========================================="
echo " 马来语词典 · 构建流程"
echo "=========================================="
echo "工作目录: $(pwd)"
echo ""

# ---------- 1. 生成词库 ----------
echo "[1/4] 生成词库分片..."
node tools/build-dict.js
if [ $? -ne 0 ]; then
  echo "❌ 词库生成失败"
  exit 1
fi
echo ""

# ---------- 2. 离线验证 ----------
echo "[2/4] 离线验证词库与搜索逻辑..."
node tools/verify-dict.js
VERIFY=$?
if [ $VERIFY -ne 0 ]; then
  echo "❌ 验证未通过，已中止构建"
  exit 1
fi
echo ""

# ---------- 3. 构建 RPK ----------
echo "[3/4] 构建 RPK..."
npm run build
if [ $? -ne 0 ]; then
  echo "❌ 构建失败"
  exit 1
fi
echo ""

# ---------- 4. 检查产物 ----------
echo "[4/4] 检查产物..."
RPK=$(find dist -maxdepth 1 -name '*.rpk' -type f -size +0c | head -1)
if [ -z "$RPK" ]; then
  echo "❌ 未找到非空 RPK"
  exit 1
fi

echo ""
echo "=========================================="
echo " ✅ 构建成功"
echo "=========================================="
ls -la dist/*.rpk
echo ""
sha256sum dist/*.rpk
echo ""
echo "RPK 内容抽查："
unzip -l "$RPK" 2>/dev/null | grep -E 'manifest.json|assets/dict/index|pages/' | head -10
echo ""
echo "导出到手机："
echo "  mkdir -p /sdcard/Download/malay-dict"
echo "  cp dist/*.rpk /sdcard/Download/malay-dict/"
