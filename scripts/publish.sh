#!/bin/bash
# 等待授权完成后自动创建仓库并推送
export HTTPS_PROXY=socks5h://127.0.0.1:7890
export HTTP_PROXY=socks5h://127.0.0.1:7890
cd "$(dirname "$0")/.."

echo "[1/4] 等待 GitHub 授权..."
for i in $(seq 1 200); do
  if gh auth status >/dev/null 2>&1; then
    echo "    授权成功 (第 ${i} 次检查)"
    break
  fi
  sleep 3
done

if ! gh auth status >/dev/null 2>&1; then
  echo "    ❌ 超时未授权"
  exit 1
fi

USER=$(gh api user --jq '.login')
echo "[2/4] 已登录: $USER"

echo "[3/4] 创建远程仓库并推送..."
if gh repo create QuantDesk --public --source=. --remote=origin --push 2>&1 | tail -5; then
  echo "    推送完成"
else
  echo "    仓库可能已存在，尝试直接推送..."
  git remote add origin "https://github.com/$USER/QuantDesk.git" 2>/dev/null
  git branch -M main
  git push -u origin main 2>&1 | tail -5
fi

echo "[4/4] 仓库地址: https://github.com/$USER/QuantDesk"
