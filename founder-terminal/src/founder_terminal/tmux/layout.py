from pathlib import Path
import os
import subprocess
import datetime
from founder_terminal.tmux.detector import detect_tmux
from founder_terminal.runs.store import RunStore

class TmuxLayoutGenerator:
    def __init__(self):
        self.store = RunStore()
        self.output_dir = Path("layouts/generated")
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def generate_agentops_layout(self, dry_run: bool = True) -> str:
        """
        Creates and/or dry-runs a multi-pane Operator Room Workspace layout script.
        """
        script = (
            "#!/usr/bin/env bash\n"
            "# ==============================================================================\n"
            "# AGENTOPS ROOM LAYOUT SCRIPT — reproducible tmux workspace\n"
            f"# Generated: {datetime.datetime.now().isoformat()}\n"
            "# © 2026 The TIMMY authors.\n"
            "# ==============================================================================\n\n"
            "echo \"Spawning AgentOps Workspace Rooms...\"\n\n"
            "# 1. Initialize core monitor session\n"
            "tmux new-session -d -s agentops -n monitor\n"
            "tmux send-keys -t agentops:monitor.0 'founder-terminal' C-m\n\n"
            "# 2. Partition quadrants\n"
            "tmux split-window -h -t agentops:monitor.0\n"
            "tmux send-keys -t agentops:monitor.1 'abtop' C-m\n"
            "tmux split-window -v -t agentops:monitor.1\n"
            "tmux send-keys -t agentops:monitor.2 'echo \"Run claude here when ready\"' C-m\n\n"
            "# 3. OpenHands log tailing window\n"
            "tmux new-window -t agentops -n openhands\n"
            "tmux send-keys -t agentops:openhands.0 'echo \"Run openhands CLI here when ready\"' C-m\n"
            "tmux split-window -h -t agentops:openhands.0\n"
            "tmux send-keys -t agentops:openhands.1 'echo \"Repo Shell ready...\"' C-m\n\n"
            "# 4. Cloudflare worker console window\n"
            "tmux new-window -t agentops -n cloudflare\n"
            "tmux send-keys -t agentops:cloudflare.0 'echo \"wrangler dev loop...\"' C-m\n\n"
            "# Attach session\n"
            "tmux attach -t agentops\n"
        )
        
        script_file = self.output_dir / "agentops.sh"
        
        # Save script file
        with open(script_file, "w") as f:
            f.write(script)
        
        # Log mutation safely
        self.store.log_config_mutation(
            file_path=str(script_file.resolve()),
            action="GENERATE_TMUX_LAYOUT",
            backup_path="None (New File)"
        )
        
        if not dry_run:
            # Enforce layout execution via subprocess if confirmed
            try:
                subprocess.run(f"bash {script_file}", shell=True, check=True)
            except Exception as e:
                return f"Error executing layout script: {e}"

        return script

if __name__ == "__main__":
    print("Generating AgentOps Layout dry-run...")
    gen = TmuxLayoutGenerator()
    print(gen.generate_agentops_layout(dry_run=True))
