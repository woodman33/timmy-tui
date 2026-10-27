#!/usr/bin/env python3
"""Real OpenHands SDK bridge; run inside the runner container for isolation.

stdin: task, workspace, acceptance, pristine_dir, optional max_iterations (1..16)
and acceptance_timeout_s (1..60). stdout's last line is the result envelope.
The iteration budget covers the initial run and one corrective run together.
Host SDK mode is an explicit local execution mode, not a sandbox.
"""
import json
import os
import signal
import subprocess
import sys


def bounded_int(value, default, maximum):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError('limits must be positive integers')
    return min(value, maximum)


def acceptance(commands, cwd, timeout_s):
    """Keep checker execution in this bridge's workspace/container boundary."""
    out = []
    for command in commands:
        child = subprocess.Popen(
            ['bash', '-c', command], cwd=cwd, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            code = child.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            # Stop descendants too; killing only bash leaves checker jobs behind.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            out.append({'cmd': command, 'code': 124, 'timed_out': True})
            continue
        out.append({'cmd': command, 'code': code})
    return out


def green(checks):
    return bool(checks) and all(check['code'] == 0 for check in checks)


def create_conversation(workspace, max_iterations):
    # Imports are lazy so offline bridge tests do not load a model runtime.
    from openhands.sdk import LLM, Agent, LocalWorkspace, LocalConversation
    from openhands.sdk.security.confirmation_policy import NeverConfirm
    from openhands.tools.preset.default import register_default_tools, get_default_tools

    register_default_tools()
    model = os.environ.get('LLM_MODEL', 'ollama/qwen3.8:27b-mlx')
    llm = LLM(
        model=model,
        base_url=os.environ.get('LLM_BASE_URL', 'http://localhost:11434'),
        api_key=os.environ.get('LLM_API_KEY', 'ollama'),
        **({'stream': False} if model.startswith('ollama/') else {}),
    )
    conv = LocalConversation(
        agent=Agent(llm=llm, tools=get_default_tools()),
        workspace=LocalWorkspace(working_dir=workspace),
        max_iteration_per_run=max_iterations,
    )
    conv.set_confirmation_policy(NeverConfirm())
    return conv


def run_bridge(req):
    # A heuristic mount canary, not proof that arbitrary host access is absent.
    result = {'ok': False, 'host_canary': any(
        os.path.exists(path) for path in ('/Users', '/Applications', 'C:\\')
    ), 'work_acceptance': [], 'pristine_acceptance': [], 'patch_applied': False}
    conv = None
    try:
        work = req.get('workspace', os.environ.get('OPENHANDS_WORK_DIR', '/work'))
        pristine = req.get('pristine_dir', '/pristine')
        commands = req.get('acceptance', [])
        if not isinstance(commands, list) or not commands or not all(
            isinstance(command, str) and command.strip() for command in commands
        ):
            raise ValueError('at least one nonempty acceptance command is required')
        if not isinstance(req.get('task'), str) or not req['task'].strip():
            raise ValueError('a nonempty task is required')
        budget = bounded_int(req.get('max_iterations'), 4, 16)
        timeout_s = bounded_int(req.get('acceptance_timeout_s'), 60, 60)
        # Pin the source before the agent can create commits in its workspace.
        base = subprocess.run(['git', '-C', work, 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, timeout=30, check=True).stdout.strip()
        initial_budget = max(1, budget - 1)
        conv = create_conversation(work, initial_budget)
        conv.send_message(req['task'])
        conv.run()
        checks = acceptance(commands, work, timeout_s)
        if not green(checks) and budget > 1:
            # Feedback describes the actual task's checks, never a canned fixture edit.
            conv.send_message(
                'The approved task is not yet accepted. These checks failed: '
                + json.dumps([check for check in checks if check['code'] != 0])
                + '. Inspect the relevant failure and correct the task implementation. '
                'Do not weaken, replace, or bypass the acceptance checks.'
            )
            conv.max_iteration_per_run = 1
            conv.run()
            checks = acceptance(commands, work, timeout_s)
        result['work_acceptance'] = checks
        patch = subprocess.run(['git', '-C', work, 'diff', '--binary', base],
                               capture_output=True, text=True, timeout=30, check=True).stdout
        result['patch'] = patch
        clone = subprocess.run(['git', 'clone', '-q', work, pristine],
                               capture_output=True, timeout=60)
        if clone.returncode != 0:
            raise RuntimeError('pristine clone failed')
        subprocess.run(['git', '-C', pristine, 'checkout', '--detach', base],
                       capture_output=True, timeout=30, check=True)
        if patch.strip():
            applied = subprocess.run(['git', '-C', pristine, 'apply', '--whitespace=nowarn', '-'],
                                     input=patch, capture_output=True, text=True, timeout=30)
            if applied.returncode != 0:
                raise RuntimeError('patch could not be applied to pristine source')
        # An empty patch is valid only if the unchanged source also passes.
        result['patch_applied'] = True
        result['pristine_acceptance'] = acceptance(commands, pristine, timeout_s)
        result['ok'] = green(checks) and green(result['pristine_acceptance'])
        if not result['ok']:
            result['note'] = 'working or pristine acceptance failed'
    except Exception as exc:
        result['note'] = str(exc)[:300]
    finally:
        if conv is not None:
            try:
                conv.close()
            except Exception:
                pass
    return result


def main():
    try:
        result = run_bridge(json.load(sys.stdin))
    except Exception as exc:
        result = {'ok': False, 'host_canary': None, 'note': str(exc)[:300]}
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
