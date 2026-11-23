#!/bin/zsh
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
LABEL="com.cougou.kitchen"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
UID_NUM="$(id -u)"
NODE_BIN="$(command -v node || true)"
PORT="${PORT:-4174}"

if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 Node.js，请先安装 Node.js 24 或更高版本。"
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then
  echo "当前 Node.js 版本为 $("$NODE_BIN" -v)，需要 24 或更高版本。"
  exit 1
fi

mkdir -p "$ROOT/logs" "$PLIST_DIR"

# Stop the previous version of the agent, if any.
launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
sleep 0.4

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被其他进程占用，请先停止它："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  exit 1
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>TZ</key>
    <string>Asia/Shanghai</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$ROOT/logs/server.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/logs/server-error.log</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
PLIST_EOF

chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "服务启动失败。最近日志："
  tail -30 "$ROOT/logs/server-error.log" "$ROOT/logs/server.log" 2>/dev/null || true
  exit 1
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo "凑狗厨房已部署为 macOS 用户服务（登录时自动启动，异常退出自动重启）。"
echo "本机：http://127.0.0.1:$PORT"
if [[ -n "$LAN_IP" ]]; then
  echo "局域网：http://$LAN_IP:$PORT"
fi
echo "管理员后台：http://127.0.0.1:$PORT/admin"
echo "日志：$ROOT/logs/server.log"
echo "停止/卸载：$ROOT/scripts/undeploy-local.sh"
