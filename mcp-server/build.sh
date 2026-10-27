#!/bin/bash
# AntiDebug Breaker MCP Server 构建脚本：tsc 编译 + esbuild 单文件打包
# 产物 dist/index.bundle.cjs 自包含全部依赖，分发/运行无需 node_modules
cd "$(dirname "$0")"
node node_modules/typescript/bin/tsc || exit 1
node node_modules/esbuild/bin/esbuild dist/index.js --bundle --platform=node --format=cjs --outfile=dist/index.bundle.cjs --external:bufferutil --external:utf-8-validate || exit 1
echo "构建完成: dist/index.bundle.cjs"
