#!/usr/bin/env bash
# hub-attach.sh — per-connection command ttyd execs for the hive-v2 hub preview.
# Lands the client in the hive-v2-hub tmux session running `hive ui`; every
# concurrent attach is its own tmux client (no session stealing).
set -euo pipefail
SESSION=hive-v2-hub
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -n hub -c /home/ubuntu/hive-work -x 200 -y 55 'exec hive ui'
  tmux set-window-option -t "$SESSION:hub" automatic-rename off
  tmux set-option -t "$SESSION" window-size latest
fi
exec tmux new-session -A -s "$SESSION"
