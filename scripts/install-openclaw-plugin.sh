#!/usr/bin/env bash
# OpenClaw 会先校验 ~/.openclaw/openclaw.json，再安装插件；若已配置 channels.pufferfish
# 而本机尚未登记该 channel，会报 unknown channel id。本脚本先临时去掉该段，装完后再合并。
set -euo pipefail

CFG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
BACKUP="${CFG}.bak.before-pufferfish-install"

if [[ ! -f "$CFG" ]]; then
  echo "未找到配置: $CFG"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cp "$CFG" "$BACKUP"
echo "已备份: $BACKUP"

export CFG
python3 <<'PY'
import json
import os
from pathlib import Path

cfg = Path(os.environ["CFG"])
data = json.loads(cfg.read_text(encoding="utf-8"))
ch = data.get("channels") or {}
if "pufferfish" in ch:
    del ch["pufferfish"]
    data["channels"] = ch
    cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("已临时移除 channels.pufferfish")
else:
    print("配置中无 channels.pufferfish，跳过移除")
PY

export CFG
openclaw plugins install . --link

echo ""
echo "安装完成。若之前有 channels.pufferfish，请从备份合并回 $CFG ："
echo "  diff -u $CFG $BACKUP"
echo "或手动把 pufferfish 段从 $BACKUP 拷回。"
