#!/bin/bash
### CleanFnOS 多架构 fpk 构建脚本
### 用法: scripts/build.sh <x86|arm> [version]
### 按架构修改 manifest 的 arch/platform → fnpack build → 重命名产物
### 产物: dist/cleanfnos_<version>_<arch>.fpk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_SRC="${REPO_ROOT}"

ARCH="${1:-x86}"
VERSION_ARG="${2:-}"

if [ "$ARCH" != "x86" ] && [ "$ARCH" != "arm" ]; then
  echo "错误: 架构必须是 x86 或 arm，收到 '$ARCH'" >&2
  exit 1
fi

# 从 manifest 读取 appname / version
APPNAME="$(grep '^appname' "${APP_SRC}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')"
MANIFEST_VERSION="$(grep '^version' "${APP_SRC}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')"
VERSION="${VERSION_ARG:-${MANIFEST_VERSION}}"

# 架构映射（飞牛命名：x86=amd64、arm=aarch64）
if [ "$ARCH" = "x86" ]; then
  MANIFEST_ARCH="x86_64"
  MANIFEST_PLATFORM="x86"
else
  MANIFEST_ARCH="aarch64"
  MANIFEST_PLATFORM="arm"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> [${ARCH}] 复制应用源码到临时目录"
cp -a "${APP_SRC}/." "${WORK_DIR}/"

echo "==> [${ARCH}] 注入对应架构的 fpcalc（Chromaprint 指纹工具）"
mkdir -p "${WORK_DIR}/app/bin"
if [ "$ARCH" = "x86" ]; then
  cp "${APP_SRC}/thirdparty/fpcalc-x86_64" "${WORK_DIR}/app/bin/fpcalc"
else
  cp "${APP_SRC}/thirdparty/fpcalc-aarch64" "${WORK_DIR}/app/bin/fpcalc"
fi
chmod +x "${WORK_DIR}/app/bin/fpcalc"

echo "==> [${ARCH}] 设置 manifest arch=${MANIFEST_ARCH} platform=${MANIFEST_PLATFORM} version=${VERSION}"
sed -i.tmp "s/^arch[[:space:]]*=.*/arch                  = ${MANIFEST_ARCH}/" "${WORK_DIR}/manifest"
sed -i.tmp "s/^platform[[:space:]]*=.*/platform              = ${MANIFEST_PLATFORM}/" "${WORK_DIR}/manifest"
sed -i.tmp "s/^version[[:space:]]*=.*/version               = ${VERSION}/" "${WORK_DIR}/manifest"
rm -f "${WORK_DIR}/manifest.tmp"

echo "==> [${ARCH}] fnpack build（在 ${WORK_DIR} 内执行，输出落在该目录）"
cd "${WORK_DIR}"
fnpack build

OUTPUT_DIR="${REPO_ROOT}/dist"
mkdir -p "${OUTPUT_DIR}"
FPK_NAME="${APPNAME}_${VERSION}_${MANIFEST_PLATFORM}.fpk"
mv "${WORK_DIR}/${APPNAME}.fpk" "${OUTPUT_DIR}/${FPK_NAME}"

echo "==> [${ARCH}] 完成: ${OUTPUT_DIR}/${FPK_NAME}"
ls -lh "${OUTPUT_DIR}/${FPK_NAME}"
