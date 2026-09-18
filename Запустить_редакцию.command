#!/bin/zsh
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:4317/api/health 2>/dev/null | /usr/bin/grep -q 'telegram-editor'; then
  /usr/bin/open http://127.0.0.1:4317
  exit 0
fi
if ! command -v node >/dev/null; then
  print 'Не найден Node.js. Установите Node.js 24 или новее.'
  read -k 1
  exit 1
fi
(sleep 2; /usr/bin/open http://127.0.0.1:4317) &
node src/server.mjs
