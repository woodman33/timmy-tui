#!/usr/bin/env bash
# ==============================================================================
# AGENTOPS ROOM LAYOUT SCRIPT — reproducible tmux workspace
# Generated: 2026-05-31T03:48:59.435503
# © 2026 The TIMMY authors.
# ==============================================================================

echo "Spawning AgentOps Workspace Rooms..."

# 1. Initialize core monitor session
tmux new-session -d -s agentops -n monitor
tmux send-keys -t agentops:monitor.0 'founder-terminal' C-m

# 2. Partition quadrants
tmux split-window -h -t agentops:monitor.0
tmux send-keys -t agentops:monitor.1 'abtop' C-m
tmux split-window -v -t agentops:monitor.1
tmux send-keys -t agentops:monitor.2 'echo "Run claude here when ready"' C-m

# 3. OpenHands log tailing window
tmux new-window -t agentops -n openhands
tmux send-keys -t agentops:openhands.0 'echo "Run openhands CLI here when ready"' C-m
tmux split-window -h -t agentops:openhands.0
tmux send-keys -t agentops:openhands.1 'echo "Repo Shell ready..."' C-m

# 4. Cloudflare worker console window
tmux new-window -t agentops -n cloudflare
tmux send-keys -t agentops:cloudflare.0 'echo "wrangler dev loop..."' C-m

# Attach session
tmux attach -t agentops
