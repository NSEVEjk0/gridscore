#!/usr/bin/env bash
# Start Gridscore inside a screen session named "gridscore":
#   window 1: worker  (pinned to 2 CPU cores with taskset -c 0-1)
#   window 2: web     (next start)
#   window 3: logs    (tail both log files)
#
# Usage: bash scripts/screen-start.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p logs data

screen -dmS gridscore bash -c 'while true; do sleep 3600; done'   # window 0: keeper

screen -S gridscore -X screen -t worker bash -c \
  'cd /root/gridscore && taskset -c 0-1 node worker/worker.mjs 2>&1 | tee -a logs/worker.log; exec bash'

screen -S gridscore -X screen -t web bash -c \
  'cd /root/gridscore && npm run start 2>&1 | tee -a logs/web.log; exec bash'

screen -S gridscore -X screen -t logs bash -c \
  'cd /root/gridscore && tail -f logs/worker.log logs/web.log'

echo "screen session 'gridscore' started: worker (taskset -c 0-1), web, logs"
echo "attach with: screen -r gridscore"
