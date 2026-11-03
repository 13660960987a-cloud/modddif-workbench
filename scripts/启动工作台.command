#!/bin/zsh
cd "${0:A:h}/.."
if ! command -v node >/dev/null; then
  echo "未找到 Node.js，请先安装 Node.js。"
  read
  exit 1
fi
if [[ ! -d node_modules ]]; then npm install; fi
open http://127.0.0.1:5173/
npm run dev
