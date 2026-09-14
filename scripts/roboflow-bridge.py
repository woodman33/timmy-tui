#!/usr/bin/env python3
"""TIMMY roboflow bridge — runs inside .timmy/venv-roboflow.
JSON request on stdin, JSON result on stdout. Key from ROBOFLOW_API_KEY.
Actions: upload | detect | sample (observer: ffmpeg frames -> upload)."""
import json, os, subprocess, sys, tempfile

def main():
    req = json.load(sys.stdin)
    action = req.get("action")
    try:
        from roboflow import Roboflow
        rf = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"])
    except Exception as e:
        print(json.dumps({"ok": False, "state": "not_configured", "note": f"roboflow sdk/key: {e}"}))
        return
    ws = rf.workspace(req.get("workspace") or os.environ.get("ROBOFLOW_WORKSPACE", ""))
    if action == "upload":
        proj = ws.project(req["project"])
        res = proj.upload(req["path"])
        print(json.dumps({"ok": True, "action": "upload", "id": str(res), "path": req["path"]}))
    elif action == "detect":
        from inference_sdk import InferenceHTTPClient, InferenceConfiguration
        client = InferenceHTTPClient(
            api_url=os.environ.get("TIMMY_VISION_SERVER_URL", "https://serverless.roboflow.com"),
            api_key=os.environ["ROBOFLOW_API_KEY"],
        ).configure(InferenceConfiguration(api_key_transport="header", confidence_threshold=req.get("confidence", 40) / 100.0, disable_active_learning=True))
        res = client.infer(req["path"], model_id=f'{req["project"]}/{req.get("version", 1)}')
        print(json.dumps({"ok": True, "action": "detect", "predictions": res.get("predictions", [])[:20]}))
    elif action == "sample":
        # observer v1: sample N frames from a video, upload each as evidence
        n = req.get("frames", 4)
        tmp = tempfile.mkdtemp(prefix="timmy-rf-")
        subprocess.run(["ffmpeg", "-y", "-i", req["video"], "-vf", f"select=not(mod(n\\,{max(1,int(req.get('every',30))))})",
                        "-vsync", "vfr", "-frames:v", str(n), f"{tmp}/f-%02d.png"],
                       check=True, capture_output=True)
        ids = []
        proj = ws.project(req["project"])
        for f in sorted(os.listdir(tmp)):
            if f.endswith(".png"):
                ids.append(str(proj.upload(os.path.join(tmp, f))))
        print(json.dumps({"ok": True, "action": "sample", "evidence_ids": ids, "video": req["video"]}))
    else:
        print(json.dumps({"ok": False, "note": f"unknown action {action}"}))

if __name__ == "__main__":
    main()
