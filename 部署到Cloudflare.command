#!/bin/zsh
# 双击这个文件，把最新代码部署到 Cloudflare Pages + D1。

set -u
cd -- "$(dirname -- "$0")" || exit 1
ROOT="$PWD"

pause() {
  echo ""
  read -r "?按回车键关闭…"
}

fail() {
  echo ""
  echo "❌ $1"
  pause
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 24 或更高版本。"
  pause
  exit 1
fi

echo "① 构建静态文件…"
node cloudflare/build.mjs || fail "构建失败。"

cd "$ROOT/cloudflare" || fail "找不到 cloudflare 目录。"

echo ""
echo "② 检查 Cloudflare 登录状态…"
if ! npx --yes wrangler@4 whoami >/dev/null 2>&1; then
  echo "还没有登录 Cloudflare，正在打开浏览器授权…"
  npx --yes wrangler@4 login || fail "Cloudflare 登录失败。"
fi

echo ""
echo "③ 更新 D1 表结构…"
npx --yes wrangler@4 d1 execute cougou-kitchen --remote --file=schema.sql || fail "D1 表结构更新失败。"

echo ""
echo "④ 部署到 Cloudflare Pages…"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cougou-deploy.XXXXXX")" || fail "无法创建临时目录。"
cleanup() {
  cd "$ROOT" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp -R functions public wrangler.toml package.json "$TMP_DIR"/ || fail "复制部署文件失败。"
cd "$TMP_DIR" || fail "无法进入临时目录。"
npx --yes wrangler@4 pages deploy public --project-name cougou-kitchen --branch main || fail "部署失败。"

echo ""
echo "✅ 部署完成：https://cougou-kitchen.pages.dev"
echo "如果浏览器还显示旧版本，按 Cmd + Shift + R 强制刷新。"
pause
