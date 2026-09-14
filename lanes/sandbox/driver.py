#!/usr/bin/env python
"""OpenHands SDK driver for the Timmy sandbox lane (shelf-w6d3 step 1).

Runs ONE task against ONE repo snapshot inside an OpenHands agent-server
container, records every conversation event to a JSONL file, and writes a
result JSON the lane seals as sandbox.run. Runs with the uv tool venv's python
(the one `openhands` is installed in), never the system python.

  driver.py --workspace <host dir> --task <text> --out <dir> [--model m] [--base-url u]
            [--image ghcr.io/openhands/agent-server:latest-python | --base-image nikolaik/python-nodejs:python3.12-nodejs22]
            [--platform linux/arm64] [--wall 900] [--max-iterations 60]
"""
import argparse
import json
import os
import sys
import time
import traceback


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=os.environ.get("SANDBOX_MODEL", "openrouter/google/gemini-3.7-flash"))
    ap.add_argument("--base-url", default=os.environ.get("SANDBOX_BASE_URL", "https://openrouter.ai/api/v1"))
    ap.add_argument("--image", default=os.environ.get("SANDBOX_IMAGE", "ghcr.io/openhands/agent-server:latest-python"))
    ap.add_argument("--base-image", default=os.environ.get("SANDBOX_BASE_IMAGE", ""))
    ap.add_argument("--platform", default=os.environ.get("SANDBOX_PLATFORM", "linux/arm64"))
    ap.add_argument("--wall", type=int, default=900)
    ap.add_argument("--max-iterations", type=int, default=60)
    ap.add_argument("--host-port", type=int, default=0)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    events_path = os.path.join(a.out, "events.jsonl")
    result_path = os.path.join(a.out, "result.json")
    started = time.time()
    result = {
        "v": 1, "ok": False, "task": a.task, "model": a.model, "base_url": a.base_url, "image": a.base_image or a.image,
        "dev_image": bool(a.base_image), "platform": a.platform, "workspace": a.workspace, "events": 0, "tool_calls": 0,
        "final": None, "error": None, "container": None, "cost_usd": None, "tokens": None, "ms": 0,
    }

    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("LLM_API_KEY")
    if not api_key:
        result["error"] = "no OPENROUTER_API_KEY / LLM_API_KEY in the environment"
        json.dump(result, open(result_path, "w"), indent=1)
        return 2

    try:
        from openhands.sdk import LLM, Agent, Conversation, Tool  # type: ignore
        from openhands.workspace import DockerWorkspace  # type: ignore
        try:
            from openhands.workspace import DockerDevWorkspace  # type: ignore
        except Exception:  # pragma: no cover
            DockerDevWorkspace = None
    except Exception as e:  # pragma: no cover
        result["error"] = f"openhands sdk import failed: {e}"
        json.dump(result, open(result_path, "w"), indent=1)
        return 2

    events_f = open(events_path, "w")
    n_events = 0
    n_tools = 0
    recorded = []

    def cap(v, n=4000):
        # keep every line valid JSON: cap long strings inside the event instead of cutting the line
        if isinstance(v, str):
            return v if len(v) <= n else v[:n] + f"…[+{len(v) - n} chars]"
        if isinstance(v, list):
            return [cap(x, n) for x in v]
        if isinstance(v, dict):
            return {k: cap(x, n) for k, x in v.items()}
        return v

    def on_event(ev):
        nonlocal n_events, n_tools
        n_events += 1
        try:
            d = ev.model_dump(mode="json") if hasattr(ev, "model_dump") else {"repr": repr(ev)}
        except Exception:
            d = {"repr": repr(ev)}
        kind = d.get("kind") or type(ev).__name__
        if "Action" in kind and "Message" not in kind:
            n_tools += 1
        d = cap(d)
        recorded.append((kind, d))
        events_f.write(json.dumps({"i": n_events, "t": round(time.time() - started, 3), "kind": kind, "event": d}, default=str) + "\n")
        events_f.flush()

    def text_of(msg):
        if not isinstance(msg, dict):
            return None
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [c.get("text", "") for c in content if isinstance(c, dict)]
            return " ".join(p for p in parts if p) or None
        return None

    def final_from_events():
        # the agent's last word: a FinishAction message, else its last MessageEvent text
        for kind, d in reversed(recorded):
            if d.get("source") != "agent":
                continue
            action = d.get("action") or {}
            if isinstance(action, dict) and action.get("kind") == "FinishAction" and action.get("message"):
                return action["message"]
            if kind.endswith("MessageEvent"):
                t = text_of(d.get("llm_message") or d.get("message") or {})
                if t:
                    return t
        return None

    llm = LLM(model=a.model, api_key=api_key, base_url=a.base_url, usage_id="timmy-sandbox")
    # tools are referenced by their REGISTERED names (importing the modules registers them);
    # the agent server in the container resolves the same names on its side
    from openhands.tools.file_editor import FileEditorTool  # type: ignore
    from openhands.tools.terminal import TerminalTool  # type: ignore
    agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)])

    ws_kwargs = dict(working_dir="/workspace", volumes=[f"{a.workspace}:/workspace"], platform=a.platform, forward_env=[])
    if a.host_port:
        ws_kwargs["host_port"] = a.host_port
    try:
        if a.base_image:
            if DockerDevWorkspace is None:
                raise RuntimeError("DockerDevWorkspace unavailable in this SDK")
            workspace = DockerDevWorkspace(base_image=a.base_image, **ws_kwargs)
        else:
            workspace = DockerWorkspace(server_image=a.image, **ws_kwargs)
    except Exception as e:
        result["error"] = f"workspace start failed: {e}"
        result["trace"] = traceback.format_exc()[-4000:]
        result["ms"] = int((time.time() - started) * 1000)
        json.dump(result, open(result_path, "w"), indent=1)
        return 3

    try:
        result["container"] = getattr(workspace, "_container_id", None)
        result["host"] = getattr(workspace, "host", None)
        conversation = Conversation(agent=agent, workspace=workspace, callbacks=[on_event], max_iteration_per_run=a.max_iterations)
        conversation.send_message(a.task)
        conversation.run()
        state = conversation.state
        result["final"] = final_from_events()
        result["status"] = str(getattr(state, "agent_status", ""))
        try:
            m = llm.metrics
            result["cost_usd"] = getattr(m, "accumulated_cost", None)
            tu = getattr(m, "accumulated_token_usage", None)
            if tu is not None:
                result["tokens"] = {"prompt": getattr(tu, "prompt_tokens", None), "completion": getattr(tu, "completion_tokens", None)}
        except Exception:
            pass
        result["ok"] = True
    except Exception as e:
        result["error"] = f"conversation failed: {e}"
        result["trace"] = traceback.format_exc()[-4000:]
    finally:
        # keep the container's own log beside the run before the workspace tears it down
        try:
            import subprocess
            cid = getattr(workspace, "_container_id", None)
            if cid:
                logs = subprocess.run(["docker", "logs", "--tail", "400", cid], capture_output=True, text=True, timeout=60)
                with open(os.path.join(a.out, "container.log"), "w") as f:
                    f.write(logs.stdout)
                    f.write(logs.stderr)
        except Exception:
            pass
        try:
            workspace.cleanup() if hasattr(workspace, "cleanup") else None
        except Exception:
            pass
        try:
            workspace.__exit__(None, None, None)
        except Exception:
            pass
        events_f.close()
        result["events"] = n_events
        result["tool_calls"] = n_tools
        result["ms"] = int((time.time() - started) * 1000)
        json.dump(result, open(result_path, "w"), indent=1, default=str)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
