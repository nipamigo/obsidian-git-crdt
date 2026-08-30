@echo off
chcp 65001 >nul 2>&1
title Git CRDT Plugin Installer
setlocal enabledelayedexpansion

echo ════════════════════════════════════════════════════
echo   Git CRDT Plugin - 一键安装 / One-Click Installer
echo   obsidian-git-crdt v0.6.0
echo ════════════════════════════════════════════════════
echo.

REM ===== 检查 main.js 是否在同目录 =====
if not exist "%~dp0main.js" (
    if not exist "%~dp0git-crdt\main.js" (
        echo [错误] 找不到 main.js
        echo [Error] main.js not found.
        echo.
        echo 请确保 install.bat 和 main.js、manifest.json 在同一目录。
        echo Please ensure install.bat is in the same folder as main.js and manifest.json.
        echo.
        pause
        exit /b 1
    )
    set "SRC_DIR=%~dp0git-crdt"
) else (
    set "SRC_DIR=%~dp0"
)

echo [1/5] 插件文件已找到 / Plugin files found
echo   源目录: %SRC_DIR%
echo.

REM ===== 搜索 Obsidian vault =====
echo [2/5] 搜索 Obsidian Vault / Searching for Obsidian Vault...
echo.

set "VAULT_DIR="
set "VAULT_COUNT=0

REM 常见 vault 位置
set "SEARCH_PATHS[0]=%USERPROFILE%\Documents"
set "SEARCH_PATHS[1]=%USERPROFILE%\OneDrive\Documents"
set "SEARCH_PATHS[2]=%USERPROFILE%\OneDrive\Obsidian"
set "SEARCH_PATHS[3]=%USERPROFILE%\Obsidian"
set "SEARCH_PATHS[4]=%USERPROFILE%\Desktop"
set "SEARCH_PATHS[5]=D:\Obsidian"
set "SEARCH_PATHS[6]=D:\Documents"
set "SEARCH_PATHS[7]=D:\

for /L %%i in (0,1,7) do (
    if defined SEARCH_PATHS[%%i] (
        for /d %%D in ("!SEARCH_PATHS[%%i]!\*") do (
            if exist "%%D\.obsidian" (
                set /a VAULT_COUNT+=1
                set "FOUND_VAULT[!VAULT_COUNT!]=%%D"
                echo   [!VAULT_COUNT!] %%D
            )
        )
    )
)

echo.
if %VAULT_COUNT% equ 0 (
    echo   未自动找到 Vault,请手动输入路径。
    echo   No vault found automatically. Please enter the path manually.
    echo.
    set /p "VAULT_DIR=请输入 Vault 路径 / Enter vault path: "
    if not exist "!VAULT_DIR!.obsidian" (
        echo.
        echo [错误] 该路径下没有 .obsidian 目录,不是有效的 Vault。
        echo [Error] No .obsidian directory found at this path.
        echo.
        pause
        exit /b 1
    )
) else if %VAULT_COUNT% equ 1 (
    set "VAULT_DIR=!FOUND_VAULT[1]!"
    echo   已自动找到 Vault / Vault found automatically:
    echo   !VAULT_DIR!
) else (
    echo   找到多个 Vault,请选择 / Multiple vaults found, choose one:
    echo.
    set /p "CHOICE=请输入序号 / Enter number (1-!VAULT_COUNT!): "
    set "VAULT_DIR=!FOUND_VAULT[%CHOICE%]!"
)

echo.
echo   目标 Vault: %VAULT_DIR%
echo.

REM ===== 创建插件目录 =====
echo [3/5] 创建插件目录 / Creating plugin directory...
set "PLUGIN_DIR=%VAULT_DIR%\.obsidian\plugins\git-crdt"

if not exist "%PLUGIN_DIR%" (
    mkdir "%PLUGIN_DIR%"
    echo   已创建: %PLUGIN_DIR%
) else (
    echo   目录已存在,将覆盖插件文件 / Directory exists, will overwrite plugin files
)

echo.

REM ===== 复制文件 =====
echo [4/5] 复制插件文件 / Copying plugin files...
copy /y "%SRC_DIR%\main.js" "%PLUGIN_DIR%\main.js" >nul 2>&1
copy /y "%SRC_DIR%\manifest.json" "%PLUGIN_DIR%\manifest.json" >nul 2>&1

if exist "%SRC_DIR%\styles.css" (
    copy /y "%SRC_DIR%\styles.css" "%PLUGIN_DIR%\styles.css" >nul 2>&1
    echo   已复制: main.js, manifest.json, styles.css
) else (
    echo   已复制: main.js, manifest.json
)

echo.

REM ===== 完成提示 =====
echo [5/5] 安装完成! / Installation complete!
echo ════════════════════════════════════════════════════
echo.
echo   接下来在 Obsidian 中启用插件:
echo   Next, enable the plugin in Obsidian:
echo.
echo   1. 打开 Obsidian
echo   2. 设置 → 第三方插件 / Settings → Community plugins
echo   3. 关闭"安全模式" / Turn off "Safe mode"
echo   4. 找到 "Git CRDT" → 点击启用
echo      Find "Git CRDT" → click enable
echo.
echo   5. 设置 → Git CRDT → 配置 Git Remote URL 和 Token
echo      Settings → Git CRDT → configure remote URL and token
echo.
echo ════════════════════════════════════════════════════
echo.
pause
