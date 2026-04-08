#!/bin/bash
set -e

# 1. 设置环境变量，告诉 Chrome 使用 99 号虚拟显示器
export DISPLAY=:99

# 2. 清理可能残留的 Xvfb 锁文件 (防止容器异常重启导致启动失败)
rm -f /tmp/.X99-lock

# 3. 启动 Xvfb 虚拟显示器 (1920x1080 24位色深，开启 GLX 和 render 模拟真实硬件加速)
echo "[System] Starting Xvfb on $DISPLAY..."
Xvfb $DISPLAY -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &

# 给 Xvfb 一点时间启动
sleep 1

# 4. 启动 Node.js 主程序
echo "[System] Starting Node.js server..."
exec node server.js
