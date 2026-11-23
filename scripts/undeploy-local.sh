#!/bin/zsh
set -euo pipefail

LABEL="com.cougou.kitchen"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "已停止并卸载凑狗厨房后台服务。"
echo "数据库仍保存在项目 data/ 目录，账号和食谱不会丢失。"
