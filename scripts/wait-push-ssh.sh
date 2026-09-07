#!/bin/bash
# 等待 SSH key 生效后推送到 GitHub
cd "$(dirname "$0")/.."
GH_USER="${1:-hejialiang-No1}"
REPO="QuantDesk"

echo "[1/3] 等待 GitHub SSH 授权生效..."
for i in $(seq 1 100); do
  if ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1 | grep -q "successfully authenticated\|You've successfully"; then
    echo "    SSH 已生效 (第 ${i} 次检查)"
    break
  fi
  sleep 5
done

if ! ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1 | grep -q "successfully"; then
  echo "    ❌ SSH 仍未生效，请确认公钥已添加到 GitHub"
  exit 1
fi

echo "[2/3] 配置远端并推送..."
git remote remove origin 2>/dev/null
git remote add origin "git@github.com:$GH_USER/$REPO.git"
git branch -M main
if git push -u origin main 2>&1 | tail -6; then
  echo "[3/3] ✅ 推送完成: https://github.com/$GH_USER/$REPO"
else
  echo "    ❌ 推送失败（仓库不存在或用户名不对），请确认已创建空仓库 https://github.com/$GH_USER/$REPO"
  exit 1
fi
