from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
import json
import os
from pathlib import Path
from founder_terminal.config import load_config

class NormalizedEvent(BaseModel):
    id: str
    timestamp: str
    type: str
    conversation_id: str
    summary: str
    tool_name: Optional[str] = None
    raw: Dict[str, Any] = Field(default_factory=dict)

class RunStore:
    def __init__(self):
        self.config = load_config()
        self.runs_dir = self.config.runs_dir
        self.runs_dir.mkdir(parents=True, exist_ok=True)

    def save_event(self, run_id: str, event: NormalizedEvent) -> None:
        """
        Appends the normalized event into .runs/<run_id>/normalized_events.jsonl after applying secret redaction.
        """
        from founder_terminal.runs.redaction import redact_secrets
        
        # Redact event summary
        event.summary = redact_secrets(event.summary)
        
        # Redact raw dictionary payloads recursively
        if event.raw:
            def redact_value(val):
                if isinstance(val, dict):
                    return {k: redact_value(v) for k, v in val.items()}
                elif isinstance(val, list):
                    return [redact_value(x) for x in val]
                elif isinstance(val, str):
                    return redact_secrets(val)
                return val
            event.raw = redact_value(event.raw)

        run_path = self.runs_dir / run_id
        run_path.mkdir(parents=True, exist_ok=True)
        
        event_file = run_path / "normalized_events.jsonl"
        with open(event_file, "a") as f:
            f.write(event.model_dump_json() + "\n")

    def get_events(self, run_id: str) -> List[NormalizedEvent]:
        """
        Reads and parses all normalized events from the run log file
        """
        run_path = self.runs_dir / run_id
        event_file = run_path / "normalized_events.jsonl"
        
        if not event_file.exists():
            return []
            
        events = []
        with open(event_file, "r") as f:
            for line in f:
                if line.strip():
                    try:
                        events.append(NormalizedEvent.model_validate_json(line))
                    except Exception:
                        pass
        return events

    def log_config_mutation(self, file_path: str, action: str, backup_path: str) -> None:
        """
        Logs a host file modification action into the current active run log (fallback to general mutations.jsonl)
        """
        mutation_log = self.runs_dir / "host_mutations.jsonl"
        entry = {
            "timestamp": os.getenv("CURRENT_TIME", ""),
            "file": file_path,
            "action": action,
            "backup": backup_path,
            "operator": "operator"
        }
        with open(mutation_log, "a") as f:
            f.write(json.dumps(entry) + "\n")
