import json
from pathlib import Path
from typing import Dict, Any, List, Optional

class ReceiptAnalyzer:
    """
    TIMMY V1.5.2 launch-grade Receipt Analyzer & Recontextualization feedback loop.
    Reads an exported .agentrun manifest and compiles structured local context-pack recommendations.
    """
    def __init__(self):
        self.feedback_dir = Path("docs/context-packs/_generated/receipt-feedback")
        self.feedback_dir.mkdir(parents=True, exist_ok=True)

    def analyze_manifest(self, manifest_path: str) -> Dict[str, Any]:
        """
        Reads the .agentrun manifest.json and extracts launch-critical analytics metrics.
        """
        path = Path(manifest_path)
        if not path.exists():
            raise FileNotFoundError(f"✕ Receipt manifest not found at: {manifest_path}")

        if path.is_dir():
            path = path / "manifest.json"

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        run_id = data.get("run_id", "unknown_run")
        title = data.get("title", "General Run Session")
        selected_model = data.get("selected_model", data.get("requested_model", "unknown"))
        
        # Read terminal_intelligence block
        intel = data.get("terminal_intelligence", {})
        budget_zone = intel.get("budget_zone", "NORMAL")
        denied_action_count = intel.get("denied_action_count", 0)
        approval_count = intel.get("approval_count", 0)
        
        # Determine context packs
        context_pack_ids = []
        if "context_pack_id" in data:
            context_pack_ids.append(data["context_pack_id"])
        
        # Check files_changed
        files_changed = data.get("files_changed", [])
        if "runner" in data and isinstance(data["runner"], dict):
            runner_block = data["runner"]
            files_changed.extend(runner_block.get("files_changed", []))
        
        # Remove duplicates
        files_changed = list(set(files_changed))

        # Check for failures
        status = data.get("status", "COMPLETED")
        failure_reason = None
        if status == "FAILED" or "error" in data:
            failure_reason = data.get("error", "Execution aborted or timed out.")

        # Determine context-pack recommendations
        recommendations = []
        if budget_zone == "CAUTION" or budget_zone == "CRITICAL":
            recommendations.append(f"⚠️ Budget alert triggers: consider routing subsequent coder roles to lower-cost models.")
        if denied_action_count > 0:
            recommendations.append(f"🛑 Security Gating event: verify that AgentPass scopes include required permission claims.")
        if len(files_changed) > 5:
            recommendations.append(f"📦 Large workspace mutations: recommend creating custom localized context packs to reduce token footprint.")
        if not recommendations:
            recommendations.append("✓ Execution baseline optimal. Maintain current context-pack distribution rules.")

        analysis = {
            "run_id": run_id,
            "title": title,
            "selected_model": selected_model,
            "budget_zone": budget_zone,
            "denied_action_count": denied_action_count,
            "approval_count": approval_count,
            "context_pack_ids": context_pack_ids,
            "files_changed": files_changed,
            "failure_reason": failure_reason,
            "context_recommendations": recommendations
        }

        # Write output markdown feedback file
        self.write_feedback_report(analysis)

        return analysis

    def write_feedback_report(self, analysis: Dict[str, Any]) -> Path:
        """
        Saves structured recontextualization feedback under docs/context-packs/_generated/receipt-feedback/{run_id}.md
        """
        run_id = analysis["run_id"]
        report_file = self.feedback_dir / f"{run_id}.md"

        feedback_md = f"""# TIMMY Receipt Feedback - {run_id}

- **Session Title:** {analysis['title']}
- **Selected Model:** `{analysis['selected_model']}`
- **Budget Zone:** {analysis['budget_zone']}
- **Denied Action Count:** {analysis['denied_action_count']}
- **Approval Count:** {analysis['approval_count']}
- **Context Packs Engaged:** {', '.join(analysis['context_pack_ids']) if analysis['context_pack_ids'] else 'None'}
- **Files Mutated:** {', '.join(analysis['files_changed']) if analysis['files_changed'] else 'None'}
- **Failure Status:** {f"`{analysis['failure_reason']}`" if analysis['failure_reason'] else 'None (Success)'}

## Recontextualization Recommendations
"""
        for rec in analysis["context_recommendations"]:
            feedback_md += f"- {rec}\n"

        feedback_md += f"\n*Attributions: built by the TIMMY project • Creator Attribution Shield Active*\n"

        with open(report_file, "w", encoding="utf-8") as f:
            f.write(feedback_md)

        return report_file

    def get_feedback_list(self) -> List[Dict[str, Any]]:
        """
        Lists all generated feedback files.
        """
        feedback_list = []
        if not self.feedback_dir.exists():
            return []
            
        for file in self.feedback_dir.glob("*.md"):
            run_id = file.stem
            # Simple parse
            title = "Feedback Report"
            recommendations = []
            with open(file, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("- **Session Title:**"):
                        title = line.split("Title:**")[-1].strip()
                    elif line.startswith("- "):
                        # general bullet
                        pass
            feedback_list.append({
                "run_id": run_id,
                "title": title,
                "file_path": str(file)
            })
        return feedback_list
