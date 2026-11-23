#!/bin/zsh
# 双击这个文件即可启动「凑狗厨房」，并用默认浏览器打开。

cd -- "$(dirname -- "$0")" || exit 1

PORT="${PORT:-4174}"
URL="http://127.0.0.1:${PORT}"

if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
  echo "凑狗厨房已经在运行：${URL}"
  open "${URL}"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 24 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo ""
  read -r "?按回车键关闭…"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -n "${NODE_MAJOR}" ] && [ "${NODE_MAJOR}" -lt 24 ]; then
  echo "当前 Node.js 版本为 $(node -v)，需要 24 或更高版本。"
  echo ""
  read -r "?按回车键关闭…"
  exit 1
fi

echo "正在启动凑狗厨房…"
echo "打开地址：${URL}"
echo "关闭这个终端窗口即可停止服务。"
echo ""

(
  for _ in {1..40}; do
    if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
      open "${URL}"
      exit 0
    fi
    sleep 0.3
  done
  echo "服务启动超时，请查看上方的错误信息。"
) &

exec node server.js
