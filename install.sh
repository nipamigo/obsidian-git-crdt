#!/bin/bash
# Git CRDT Plugin - 一键安装 / One-Click Installer
# obsidian-git-crdt v0.6.0
# 支持 macOS / Linux

set -e

echo "═══════════════════════════════════════════════════"
echo "  Git CRDT Plugin - 一键安装 / One-Click Installer"
echo "  obsidian-git-crdt v0.6.0"
echo "═══════════════════════════════════════════════════"
echo

# ===== 检查 main.js 是否在同目录 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/main.js" ]; then
    SRC_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/git-crdt/main.js" ]; then
    SRC_DIR="$SCRIPT_DIR/git-crdt"
else
    echo "[错误] 找不到 main.js"
    echo "[Error] main.js not found."
    echo
    echo "请确保 install.sh 和 main.js、manifest.json 在同一目录。"
    echo "Please ensure install.sh is in the same folder as main.js and manifest.json."
    exit 1
fi

echo "[1/5] 插件文件已找到 / Plugin files found"
echo "  源目录: $SRC_DIR"
echo

# ===== 搜索 Obsidian vault =====
echo "[2/5] 搜索 Obsidian Vault / Searching for Obsidian Vault..."
echo

VAULTS=()

# macOS 常见位置
if [ "$(uname)" = "Darwin" ]; then
    SEARCH_PATHS=(
        "$HOME/Documents"
        "$HOME/Obsidian"
        "$HOME/Desktop"
        "$HOME/Library/CloudStorage"
        "$HOME/Library/Mobile Documents"
    )
else
    # Linux 常见位置
    SEARCH_PATHS=(
        "$HOME/Documents"
        "$HOME/Obsidian"
        "$HOME/Desktop"
        "$HOME/Nextcloud"
    )
fi

for search_path in "${SEARCH_PATHS[@]}"; do
    if [ -d "$search_path" ]; then
        while IFS= read -r d; do
            if [ -d "$d/.obsidian" ]; then
                VAULTS+=("$d")
            fi
        done < <(find "$search_path" -maxdepth 3 -type d 2>/dev/null)
    fi
done

# 去重
IFS=$'\n' VAULTS=($(printf "%s\n" "${VAULTS[@]}" | sort -u))
unset IFS

VAULT_COUNT=${#VAULTS[@]}

if [ $VAULT_COUNT -eq 0 ]; then
    echo "  未自动找到 Vault,请手动输入路径。"
    echo "  No vault found automatically. Please enter the path manually."
    echo
    read -p "请输入 Vault 路径 / Enter vault path: " VAULT_DIR
    if [ ! -d "$VAULT_DIR/.obsidian" ]; then
        echo
        echo "[错误] 该路径下没有 .obsidian 目录,不是有效的 Vault。"
        echo "[Error] No .obsidian directory found at this path."
        exit 1
    fi
elif [ $VAULT_COUNT -eq 1 ]; then
    VAULT_DIR="${VAULTS[0]}"
    echo "  已自动找到 Vault / Vault found automatically:"
    echo "  $VAULT_DIR"
else
    echo "  找到多个 Vault,请选择 / Multiple vaults found, choose one:"
    echo
    for i in "${!VAULTS[@]}"; do
        echo "  [$((i+1))] ${VAULTS[$i]}"
    done
    echo
    read -p "请输入序号 / Enter number (1-$VAULT_COUNT): " CHOICE
    VAULT_DIR="${VAULTS[$((CHOICE-1))]}"
fi

echo
echo "  目标 Vault: $VAULT_DIR"
echo

# ===== 创建插件目录 =====
echo "[3/5] 创建插件目录 / Creating plugin directory..."
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/git-crdt"

if [ ! -d "$PLUGIN_DIR" ]; then
    mkdir -p "$PLUGIN_DIR"
    echo "  已创建: $PLUGIN_DIR"
else
    echo "  目录已存在,将覆盖插件文件 / Directory exists, will overwrite plugin files"
fi
echo

# ===== 复制文件 =====
echo "[4/5] 复制插件文件 / Copying plugin files..."
cp -f "$SRC_DIR/main.js" "$PLUGIN_DIR/main.js"
cp -f "$SRC_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"

if [ -f "$SRC_DIR/styles.css" ]; then
    cp -f "$SRC_DIR/styles.css" "$PLUGIN_DIR/styles.css"
    echo "  已复制: main.js, manifest.json, styles.css"
else
    echo "  已复制: main.js, manifest.json"
fi
echo

# ===== 完成提示 =====
echo "[5/5] 安装完成! / Installation complete!"
echo "═══════════════════════════════════════════════════"
echo
echo "  接下来在 Obsidian 中启用插件:"
echo "  Next, enable the plugin in Obsidian:"
echo
echo "  1. 打开 Obsidian"
echo "  2. 设置 → 第三方插件 / Settings → Community plugins"
echo "  3. 关闭\"安全模式\" / Turn off \"Safe mode\""
echo "  4. 找到 \"Git CRDT\" → 点击启用"
echo "     Find \"Git CRDT\" → click enable"
echo
echo "  5. 设置 → Git CRDT → 配置 Git Remote URL 和 Token"
echo "     Settings → Git CRDT → configure remote URL and token"
echo
echo "═══════════════════════════════════════════════════"
