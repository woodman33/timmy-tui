#!/usr/bin/env python3
"""TIMMY OpenHands SDK bridge — tools execute IN-PROCESS against the seeded
workspace (LocalWorkspace), closing the headless-CLI tool-exec gap (Phase A2).
Phase C: runs inside the ephemeral runner container; reports a host-path
canary (isolation evidence) and a full patch lifecycle: generate the worktree
patch, apply it to a PRISTINE clone, and assert acceptance there — proving the
patch alone turns red→green, not container state.

stdin: {"task": str, "workspace": str, "acceptance": [str], "pristine_dir": str}
stdout: one JSON line (last line is the result envelope).
Run with the uv tool python (host engine) or /bridge.py in the runner image.

R4 (H104): the re-prompt. When the agent stops with the task's acceptance
still failing, the bridge asks again, at most REPROMPT_ROUNDS times. It used to
ask with an instruction written for one test fixture (one file and one edit,
named), whatever the task was. Each re-prompt is now built from the task's
own acceptance commands that still fail and the end of each one's last output,
bounded (OUTPUT_TAIL characters a command, REPROMPT_MAX in all), and every
re-prompt sent is recorded in the result (`reprompts`: its round, the commands
that failed with their exit codes, and its text). The functions above main()
need no SDK, so they can be checked on their own (tests/openhands-bridge.test.ts).
"""
import json
import os
import re
import subprocess
import sys

# at most this many re-prompts after the first message (bounded, as before)
REPROMPT_ROUNDS = 3
# the end of each failing command's last output that a re-prompt quotes
OUTPUT_TAIL = 1200
# a whole re-prompt, at most
REPROMPT_MAX = 4000
# terminal control characters a command printed (colour codes and the like) are not quoted
_CONTROL = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def sh(cmd, cwd):
    return subprocess.run(['bash', '-c', cmd], cwd=cwd, capture_output=True)


def tail(text, limit):
    """The last `limit` characters of a command's output, without terminal control codes; marked when cut."""
    text = _CONTROL.sub('', text or '').strip()
    if len(text) <= limit:
        return text
    return '[... ' + str(len(text) - limit) + ' earlier characters not shown]\n' + text[-limit:]


def acceptance(commands, cwd):
    """Each acceptance command run in `cwd`: its exit code and the end of what it printed (stdout, then stderr)."""
    out = []
    for cmd in commands:
        r = sh(cmd, cwd)
        printed = (r.stdout or b'').decode('utf-8', 'replace') + (r.stderr or b'').decode('utf-8', 'replace')
        out.append({'cmd': cmd, 'code': r.returncode, 'output': tail(printed, OUTPUT_TAIL)})
    return out


def green(results):
    """The acceptance passes: there are checks, and every one exited 0."""
    return bool(results) and all(x['code'] == 0 for x in results)


CUT_NOTE = '\n[... cut: this re-prompt is at its length limit]'


def reprompt(results, round_no, rounds=REPROMPT_ROUNDS, max_chars=REPROMPT_MAX):
    """The message a re-prompt sends: the task's own acceptance commands that still fail, each with its exit code and the
    end of its last output, and what to do. Nothing in it is particular to one task. At most `max_chars` characters: each
    failing command gets an even share of the room left, and a block cut short says so."""
    failing = [r for r in results if r['code'] != 0]
    if not failing:
        return ''
    total, n = len(results), len(failing)
    if total == 1:
        what = 'its acceptance check still fails'
    else:
        what = '%d of its %d acceptance checks still %s' % (n, total, 'fails' if n == 1 else 'fail')
    head = ('The task is not finished: %s in the working directory (re-prompt %d of %d). %s, its exit code and the end '
            'of its last output:' % (what, round_no, rounds, 'The command' if n == 1 else 'Each command'))
    footer = ('Read that output, find the cause in the files of the working directory, and change them so that every '
              'acceptance command exits 0; then run %s yourself with the terminal tool. Do not change the acceptance '
              'command%s.' % ('it' if n == 1 else 'them', '' if n == 1 else 's'))
    # the blank lines between the head, each block and the footer
    budget = max_chars - len(head) - len(footer) - 2 * (n + 1)
    blocks = []
    for i, r in enumerate(failing):
        block = '$ %s\n(exit code %s)\n%s' % (r['cmd'], r['code'], r.get('output') or '(it printed nothing)')
        share = max(0, budget) // (n - i)
        if len(block) > share:
            block = block[:max(0, share - len(CUT_NOTE))].rstrip() + CUT_NOTE
        blocks.append(block)
        budget -= len(block)
    # the bound holds even when there are so many failing commands that each gets almost no room
    return '\n\n'.join([head] + blocks + [footer])[:max_chars]


def main():
    req = json.load(sys.stdin)
    work = req.get('workspace', os.environ.get('OPENHANDS_WORK_DIR', '/work'))
    pristine = req.get('pristine_dir', '/pristine')
    commands = req.get('acceptance', [])

    # Isolation evidence: host-OS paths that can ONLY exist inside the container
    # via a leaked host mount (macOS/Windows dirs; /home exists on bare Debian so
    # it is NOT a valid canary). The adapter interprets per engine (fail closed).
    host_canary = any(os.path.exists(p) for p in ('/Users', '/Applications', 'C:\\'))

    from openhands.sdk import LLM, Agent, LocalWorkspace, LocalConversation
    from openhands.sdk.security.confirmation_policy import NeverConfirm
    from openhands.tools.preset.default import register_default_tools, get_default_tools

    register_default_tools()  # terminal, file_editor, … into the registry
    llm = LLM(
        model=os.environ.get('LLM_MODEL', 'ollama/qwen3.8:27b-mlx'),
        base_url=os.environ.get('LLM_BASE_URL', 'http://localhost:11434'),
        api_key=os.environ.get('LLM_API_KEY', 'ollama'),
        # ollama streaming mangles tool-call args (empty params observed);
        # non-streaming parses them correctly
        **({'stream': False} if os.environ.get('LLM_MODEL', '').startswith('ollama/') else {}),
    )
    agent = Agent(llm=llm, tools=get_default_tools())
    conv = LocalConversation(agent=agent, workspace=LocalWorkspace(working_dir=work))
    conv.set_confirmation_policy(NeverConfirm())  # headless: never block on confirm

    result = {'ok': False, 'host_canary': host_canary, 'reprompt_rounds': REPROMPT_ROUNDS, 'reprompts': []}
    try:
        send = getattr(conv, 'send_message', None) or getattr(conv, 'ask_agent', None)
        if send is None:
            result['note'] = 'no send_message/ask_agent on LocalConversation'
        else:
            send(req['task'])
            run = getattr(conv, 'run', None)  # send_message enqueues; run() drives the loop
            if callable(run):
                run()
            # bounded re-prompt loop: the agent sometimes stops before its acceptance passes; ask again with what still
            # fails, until it passes or the rounds are used (still agent-driven: the bridge edits nothing)
            for round_no in range(1, REPROMPT_ROUNDS + 1):
                results = acceptance(commands, work)
                if not results or green(results):
                    break
                text = reprompt(results, round_no)
                result['reprompts'].append({
                    'round': round_no,
                    'failing': [{'cmd': r['cmd'], 'code': r['code']} for r in results if r['code'] != 0],
                    'text': text,
                })
                send(text)
                if callable(run):
                    run()
            # ---- patch lifecycle (in-container) ----
            patch = subprocess.run(['git', '-C', work, 'diff'],
                                   capture_output=True, text=True).stdout or ''
            result['patch'] = patch
            result['work_acceptance'] = [{'cmd': r['cmd'], 'code': r['code']} for r in acceptance(commands, work)]
            pristine_acceptance = []
            patch_applied = False
            if patch.strip():
                c = subprocess.run(['git', 'clone', '-q', work, pristine],
                                   capture_output=True)
                if c.returncode == 0:
                    ap = subprocess.run(['git', '-C', pristine, 'apply',
                                         '--whitespace=nowarn', '-'],
                                        input=patch, capture_output=True, text=True)
                    patch_applied = ap.returncode == 0
                    pristine_acceptance = ([{'cmd': r['cmd'], 'code': r['code']} for r in acceptance(commands, pristine)]
                                           if patch_applied
                                           else [{'cmd': 'git apply (pristine)', 'code': ap.returncode}])
            result['patch_applied'] = patch_applied
            result['pristine_acceptance'] = pristine_acceptance
            result['ok'] = True
    except Exception as e:  # honesty clause: surface why
        result['note'] = str(e)[:300]
    finally:
        try:
            conv.close()
        except Exception:
            pass
    print(json.dumps(result))


if __name__ == '__main__':
    main()
