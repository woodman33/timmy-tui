import time
import shutil
import hashlib
import subprocess
import shlex
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from founder_terminal.runners.base import BaseRunner
from founder_terminal.agentpass.passport import AgentPassPassport
from founder_terminal.agentpass.verifier import verify_action
from founder_terminal.runs.redaction import redact_secrets

class OpenHandsRunner(BaseRunner):
    """
    TIMMY V1.5.2 launch-grade hardened OpenHands Governed External Agent Sandbox Runner
    """
    def __init__(self):
        self._artifacts: List[str] = []
        
    @property
    def runner_id(self) -> str:
        return "openhands"

    @property
    def display_name(self) -> str:
        return "OpenHands Governed Agent Sandbox"

    @property
    def required_scopes(self) -> List[str]:
        return [
            "agent.run.openhands",
            "agent.run.openhands.headless",
            "context.read.openhands_sdk"
        ]

    @property
    def risk_class(self) -> str:
        return "workspace_mutation"

    @property
    def risk_classes(self) -> List[str]:
        return ["workspace_mutation", "model_execution", "network_call"]

    @property
    def supports_dry_run(self) -> bool:
        return True

    @property
    def supports_live(self) -> bool:
        return True

    def is_installed(self) -> bool:
        """
        Detects whether 'openhands' CLI exists in the system PATH.
        """
        return shutil.which("openhands") is not None

    def build_command_args(self, task: str) -> List[str]:
        """
        Constructs the canonical list of arguments for headless OpenHands command execution.
        """
        return ["openhands", "--task", task, "--mode", "headless"]

    def build_command(self, task: str, mode: str) -> str:
        """
        BaseRunner compatibility: builds safe shlex quoted command string.
        """
        args = self.build_command_args(task)
        return " ".join(shlex.quote(arg) for arg in args)

    def run(
        self,
        task: str,
        mode: str,
        require_approval: bool = True,
        simulate: bool = False,
        estimated_cost_usd: float = 0.01,
        cwd: Optional[str] = None,
        timeout_seconds: int = 600
    ) -> Dict[str, Any]:
        """
        Executes or previews the OpenHands governed agent sandbox execution loop.
        """
        start_time = time.time()
        self._artifacts = []
        
        # 1. Resolve workspace root path safely
        if cwd is None:
            cwd = os.getcwd()
        cwd_absolute = str(Path(cwd).resolve())

        # 2. Canonical argument construction to prevent divergence
        command_args = self.build_command_args(task)
        command_preview = " ".join(shlex.quote(arg) for arg in command_args)
        command_hash = hashlib.sha256(command_preview.encode("utf-8")).hexdigest()

        # 3. Strict mode validation
        if mode not in ["dry-run", "live"]:
            return {
                "success": False,
                "runner_id": self.runner_id,
                "runner_mode": "headless",
                "execution_mode": "dry_run" if mode == "dry-run" else "live",
                "runner_simulated": simulate,
                "command_args": command_args,
                "command_preview": command_preview,
                "command_hash": command_hash,
                "cwd": cwd_absolute,
                "exit_code": 2,
                "duration_ms": 0,
                "stdout": "",
                "stderr": f"✕ Validation Error: Unsupported runner execution mode '{mode}'. Allowed modes: dry-run, live.",
                "stdout_hash": hashlib.sha256(b"").hexdigest(),
                "stderr_hash": hashlib.sha256(f"Unsupported runner execution mode '{mode}'".encode("utf-8")).hexdigest(),
                "approval_status": "DENIED",
                "passport_status": "DENIED",
                "risk_class": self.risk_class,
                "risk_classes": self.risk_classes,
                "estimated_cost_usd": estimated_cost_usd,
                "diagnostics": [f"✕ Strict Gating: Mode '{mode}' is invalid."],
                "artifacts": [],
                "files_changed": []
            }

        # 4. Gating Verification Loop
        passport = AgentPassPassport()
        diagnostics = []

        # Check required scopes
        for scope in self.required_scopes:
            if scope not in passport.scopes:
                return {
                    "success": False,
                    "runner_id": self.runner_id,
                    "runner_mode": "headless",
                    "execution_mode": "dry_run" if mode == "dry-run" else "live",
                    "runner_simulated": simulate,
                    "command_args": command_args,
                    "command_preview": command_preview,
                    "command_hash": command_hash,
                    "cwd": cwd_absolute,
                    "exit_code": 126,
                    "duration_ms": 0,
                    "stdout": "",
                    "stderr": f"✕ Security Gating Denied: Passport lacks required scope '{scope}'",
                    "stdout_hash": hashlib.sha256(b"").hexdigest(),
                    "stderr_hash": hashlib.sha256(f"Missing scope entitlement: {scope}".encode("utf-8")).hexdigest(),
                    "approval_status": "DENIED",
                    "passport_status": "DENIED",
                    "risk_class": self.risk_class,
                    "risk_classes": self.risk_classes,
                    "estimated_cost_usd": estimated_cost_usd,
                    "diagnostics": [f"✕ Missing scope entitlement: {scope}"],
                    "artifacts": [],
                    "files_changed": []
                }

        diagnostics.append("✓ AgentPass: Required scopes successfully verified in active passport.")

        # Evaluate action using the general verifier with estimated cost
        ap_verify = verify_action(
            passport,
            tool="openhands.run",
            risk_level="high" if mode == "live" else "low",
            risk_class=self.risk_class,
            cost=estimated_cost_usd
        )
        diagnostics.extend(ap_verify.diagnostics)

        if ap_verify.status == "DENIED":
            return {
                "success": False,
                "runner_id": self.runner_id,
                "runner_mode": "headless",
                "execution_mode": "dry_run" if mode == "dry-run" else "live",
                "runner_simulated": simulate,
                "command_args": command_args,
                "command_preview": command_preview,
                "command_hash": command_hash,
                "cwd": cwd_absolute,
                "exit_code": 126,
                "duration_ms": 0,
                "stdout": "",
                "stderr": "✕ Security Gating Denied: AgentPass validation block",
                "stdout_hash": hashlib.sha256(b"").hexdigest(),
                "stderr_hash": hashlib.sha256(b"AgentPass validation block").hexdigest(),
                "approval_status": "DENIED",
                "passport_status": "DENIED",
                "risk_class": self.risk_class,
                "risk_classes": self.risk_classes,
                "estimated_cost_usd": estimated_cost_usd,
                "diagnostics": diagnostics,
                "artifacts": [],
                "files_changed": []
            }

        # 5. Enforce human operator approval correctly
        # Combined operator require_approval OR AgentPass verifier mandating APPROVAL_REQUIRED
        approval_status = "NOT_REQUIRED"
        if mode == "live":
            approval_needed = require_approval or (ap_verify.status == "APPROVAL_REQUIRED")
            if approval_needed:
                print(f"\n🚨 TIMMY GOVERNANCE ADVISORY: Gated external runner execution request.")
                print(f"  Runner ID    : {self.runner_id}")
                print(f"  Display Name : {self.display_name}")
                print(f"  Command      : {command_preview}")
                print(f"  Risk Classes : {', '.join(self.risk_classes)}")
                print(f"  Cost Limit   : ${estimated_cost_usd:.4f}")
                print(f"  Active Budget: ${passport.budget_usd:.2f}")

                try:
                    approve = input("⚠️ APPROVE OpenHands runner live execution? [y/N]: ").strip().lower()
                except (KeyboardInterrupt, EOFError):
                    approve = "no"

                if approve not in ["y", "yes"]:
                    end_time = time.time()
                    return {
                        "success": False,
                        "runner_id": self.runner_id,
                        "runner_mode": "headless",
                        "execution_mode": "live",
                        "runner_simulated": simulate,
                        "command_args": command_args,
                        "command_preview": redact_secrets(command_preview),
                        "command_hash": command_hash,
                        "cwd": redact_secrets(cwd_absolute),
                        "exit_code": 130,
                        "duration_ms": int((end_time - start_time) * 1000),
                        "stdout": "",
                        "stderr": "✕ Operator Denied: Human approval gate rejected live write.",
                        "stdout_hash": hashlib.sha256(b"").hexdigest(),
                        "stderr_hash": hashlib.sha256(b"Live command write rejected by operator.").hexdigest(),
                        "approval_status": "DENIED",
                        "passport_status": ap_verify.status,
                        "risk_class": self.risk_class,
                        "risk_classes": self.risk_classes,
                        "estimated_cost_usd": estimated_cost_usd,
                        "diagnostics": diagnostics,
                        "artifacts": [],
                        "files_changed": []
                    }
                approval_status = "APPROVED"

        # 6. Dry Run preview logic
        if mode == "dry-run":
            end_time = time.time()
            duration_ms = int((end_time - start_time) * 1000)

            stdout_text = f"[OpenHands Dry Run] Pre-flight validation passed.\nWould execute: {command_preview}\nTask: {task}"
            stderr_text = ""

            # Secrets Redaction
            stdout_text = redact_secrets(stdout_text)
            cwd_redacted = redact_secrets(cwd_absolute)
            command_preview_redacted = redact_secrets(command_preview)
            diagnostics_redacted = [redact_secrets(d) for d in diagnostics]

            stdout_hash = hashlib.sha256(stdout_text.encode("utf-8")).hexdigest()
            stderr_hash = hashlib.sha256(stderr_text.encode("utf-8")).hexdigest()

            return {
                "success": True,
                "runner_id": self.runner_id,
                "runner_mode": "headless",
                "execution_mode": "dry_run",
                "runner_simulated": simulate,
                "command_args": command_args,
                "command_preview": command_preview_redacted,
                "command_hash": command_hash,
                "cwd": cwd_redacted,
                "exit_code": 0,
                "duration_ms": duration_ms,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "stdout_hash": stdout_hash,
                "stderr_hash": stderr_hash,
                "approval_status": approval_status,
                "passport_status": ap_verify.status,
                "risk_class": self.risk_class,
                "risk_classes": self.risk_classes,
                "estimated_cost_usd": estimated_cost_usd,
                "diagnostics": diagnostics_redacted,
                "artifacts": [],
                "files_changed": []
            }

        # 7. Live sandbox execution logic
        installed = self.is_installed()
        stdout_text = ""
        stderr_text = ""
        exit_code = 0
        execution_mode = "live"
        runner_simulated = False
        files_changed = []

        if installed:
            # Capturing git status before run to track actual workspace changes
            files_before = set()
            is_git = False
            try:
                git_res = subprocess.run(
                    ["git", "status", "--porcelain"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=cwd_absolute,
                    timeout=5
                )
                if git_res.returncode == 0:
                    is_git = True
                    for line in git_res.stdout.split("\n"):
                        if line.strip():
                            parts = line.strip().split(None, 1)
                            if len(parts) > 1:
                                files_before.add(parts[1])
            except Exception:
                pass

            # Safe execution under canonical subprocess array execution
            try:
                proc = subprocess.run(
                    command_args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=cwd_absolute,
                    timeout=timeout_seconds
                )
                stdout_text = proc.stdout
                stderr_text = proc.stderr
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                end_time = time.time()
                return {
                    "success": False,
                    "runner_id": self.runner_id,
                    "runner_mode": "headless",
                    "execution_mode": "live",
                    "runner_simulated": False,
                    "command_args": command_args,
                    "command_preview": redact_secrets(command_preview),
                    "command_hash": command_hash,
                    "cwd": redact_secrets(cwd_absolute),
                    "exit_code": 124,
                    "duration_ms": int((end_time - start_time) * 1000),
                    "stdout": "",
                    "stderr": "✕ OpenHands runner timed out after execution ceiling exceeded.",
                    "stdout_hash": hashlib.sha256(b"").hexdigest(),
                    "stderr_hash": hashlib.sha256(b"OpenHands runner timed out").hexdigest(),
                    "approval_status": approval_status,
                    "passport_status": ap_verify.status,
                    "risk_class": self.risk_class,
                    "risk_classes": self.risk_classes,
                    "estimated_cost_usd": estimated_cost_usd,
                    "diagnostics": diagnostics,
                    "artifacts": [],
                    "files_changed": []
                }
            except Exception as e:
                stdout_text = ""
                stderr_text = f"Subprocess crash: {str(e)}"
                exit_code = 1

            # Capturing git status after run to compute actual changed files
            if is_git:
                try:
                    git_res = subprocess.run(
                        ["git", "status", "--porcelain"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        cwd=cwd_absolute,
                        timeout=5
                    )
                    if git_res.returncode == 0:
                        files_after = set()
                        for line in git_res.stdout.split("\n"):
                            if line.strip():
                                parts = line.strip().split(None, 1)
                                if len(parts) > 1:
                                    files_after.add(parts[1])
                        files_changed = list(files_after - files_before)
                except Exception:
                    pass
            else:
                diagnostics.append("⚠️ Git diff unavailable: current working directory is not a git repository.")

        else:
            # Gated simulation checks: OpenHands is missing
            if not simulate:
                end_time = time.time()
                return {
                    "success": False,
                    "runner_id": self.runner_id,
                    "runner_mode": "headless",
                    "execution_mode": "live",
                    "runner_simulated": False,
                    "command_args": command_args,
                    "command_preview": redact_secrets(command_preview),
                    "command_hash": command_hash,
                    "cwd": redact_secrets(cwd_absolute),
                    "exit_code": 127,
                    "duration_ms": int((end_time - start_time) * 1000),
                    "stdout": "",
                    "stderr": "✕ System Error: 'openhands' command binary not found in host PATH (exit_code 127). Live execution aborted.",
                    "stdout_hash": hashlib.sha256(b"").hexdigest(),
                    "stderr_hash": hashlib.sha256(b"openhands command not found").hexdigest(),
                    "approval_status": approval_status,
                    "passport_status": ap_verify.status,
                    "risk_class": self.risk_class,
                    "risk_classes": self.risk_classes,
                    "estimated_cost_usd": estimated_cost_usd,
                    "diagnostics": diagnostics + ["✕ openhands command binary missing from system PATH."],
                    "artifacts": [],
                    "files_changed": []
                }
            
            # Explicit simulate=True parameter is passed
            print(f"[System] 'openhands' CLI tool not found in PATH. Simulating launch-grade stateful sandbox...")
            time.sleep(0.5)
            execution_mode = "simulated"
            runner_simulated = True
            
            # Generate simulated receipts
            stdout_text = (
                f"[OpenHands Stateful Sandbox] Successfully executed governed task: {task}\n"
                f"✓ Sandbox Container initialized: id=oh_sandbox_oh_33a1\n"
                f"✓ Context packs retrieved successfully: openhands-sdk (v1.0.0)\n"
                f"✓ Verified safe read-only facts: Attributions: built by the TIMMY project • Creator Attribution Shield Active\n"
                f"✓ Execution Status: Completed."
            )
            stderr_text = ""
            exit_code = 0
            
            # Create a mock simulated artifact
            sim_artifact_file = Path(cwd_absolute) / "artifacts" / "FACTS.md"
            try:
                sim_artifact_file.parent.mkdir(parents=True, exist_ok=True)
                with open(sim_artifact_file, "w") as f:
                    f.write(f"# Simulated OpenHands Execution\nTask: {task}\nStatus: PASS\n")
                files_changed = ["artifacts/FACTS.md"]
                self._artifacts = ["artifacts/FACTS.md"]
            except Exception:
                pass

        # 8. Redaction & Secure Hashing
        stdout_text = redact_secrets(stdout_text)
        stderr_text = redact_secrets(stderr_text)
        cwd_redacted = redact_secrets(cwd_absolute)
        command_preview_redacted = redact_secrets(command_preview)
        diagnostics_redacted = [redact_secrets(d) for d in diagnostics]

        stdout_hash = hashlib.sha256(stdout_text.encode("utf-8")).hexdigest()
        stderr_hash = hashlib.sha256(stderr_text.encode("utf-8")).hexdigest()

        end_time = time.time()
        duration_ms = int((end_time - start_time) * 1000)

        # Update private artifacts list from changes
        if files_changed and not self._artifacts:
            self._artifacts = list(files_changed)

        return {
            "success": exit_code == 0,
            "runner_id": self.runner_id,
            "runner_mode": "headless",
            "execution_mode": execution_mode,
            "runner_simulated": runner_simulated,
            "command_args": command_args,
            "command_preview": command_preview_redacted,
            "command_hash": command_hash,
            "cwd": cwd_redacted,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "stdout_hash": stdout_hash,
            "stderr_hash": stderr_hash,
            "approval_status": approval_status,
            "passport_status": ap_verify.status,
            "risk_class": self.risk_class,
            "risk_classes": self.risk_classes,
            "estimated_cost_usd": estimated_cost_usd,
            "diagnostics": diagnostics_redacted,
            "artifacts": self._artifacts,
            "files_changed": files_changed
        }

    def collect_artifacts(self) -> List[str]:
        """
        Returns the list of actual artifacts collected during the run.
        """
        return self._artifacts

    def summarize_result(self, result: Dict[str, Any]) -> str:
        if not result.get("success", False):
            return f"✕ OpenHands Sandbox Execution Failed: {result.get('stderr') or result.get('error', 'Unknown Error')}"
        return (
            f"✓ OpenHands Governed Agent Sandbox Executed Successfully!\n"
            f"  Command Preview: {result.get('command_preview')}\n"
            f"  Execution Mode : {result.get('execution_mode').upper()} (Simulated: {result.get('runner_simulated')})\n"
            f"  Exit Code      : {result.get('exit_code')}\n"
            f"  Duration       : {result.get('duration_ms')} ms\n"
            f"  Stdout Hash    : {result.get('stdout_hash')[:16]}...\n"
            f"  Stderr Hash    : {result.get('stderr_hash')[:16]}...\n"
            f"  Files Changed  : {result.get('files_changed')}\n"
            f"  Artifacts      : {result.get('artifacts')}\n"
            f"  Operator Appr. : {result.get('approval_status')}"
        )
