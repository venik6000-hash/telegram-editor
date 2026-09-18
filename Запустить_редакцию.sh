#!/bin/sh
cd "$(dirname "$0")" || exit 1
if command -v xdg-open >/dev/null 2>&1; then (sleep 2; xdg-open http://127.0.0.1:4317) & fi
exec node src/server.mjs
