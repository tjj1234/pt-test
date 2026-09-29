#!/bin/bash
cd "$(dirname "$0")" || exit 1
PORT=8877
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:${PORT}/merged-hifi-v1.4.html"
  exit 0
fi
python3 -m http.server "$PORT" --bind 127.0.0.1 &
PID=$!
sleep 0.6
open "http://127.0.0.1:${PORT}/merged-hifi-v1.4.html"
wait $PID
