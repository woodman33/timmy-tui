"""FAKE openhands.sdk (R4 H104): LLM, Agent, LocalWorkspace and LocalConversation as the bridge uses them.

LocalConversation.send_message records each message (one JSON line in the file FAKE_OH_LOG names). run() stands in for the
agent's turn: on the run whose number is FAKE_OH_FIX_ON_RUN (1 is the run after the task, 2 the run after the first
re-prompt, ...), it writes FAKE_OH_FIX_TEXT into the working directory's file FAKE_OH_FIX_FILE, the change a real agent
would make; on every other run it changes nothing. Nothing is asked of any model.
"""
import json
import os


class LLM(object):
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class Agent(object):
    def __init__(self, llm=None, tools=None):
        self.llm = llm
        self.tools = tools or []


class LocalWorkspace(object):
    def __init__(self, working_dir):
        self.working_dir = working_dir


class LocalConversation(object):
    def __init__(self, agent=None, workspace=None, max_iteration_per_run=None):
        self.agent = agent
        self.workspace = workspace
        # the iteration budget the bridge gives each run (b56c36f0), recorded for the test
        self.max_iteration_per_run = max_iteration_per_run
        self.runs = 0
        self.policy = None

    def set_confirmation_policy(self, policy):
        self.policy = policy

    def send_message(self, text):
        log = os.environ.get('FAKE_OH_LOG')
        if log:
            with open(log, 'a') as f:
                f.write(json.dumps({'message': text}) + '\n')

    def run(self):
        self.runs += 1
        fix_on = int(os.environ.get('FAKE_OH_FIX_ON_RUN', '0') or '0')
        if fix_on and self.runs == fix_on:
            path = os.path.join(self.workspace.working_dir, os.environ['FAKE_OH_FIX_FILE'])
            with open(path, 'w') as f:
                f.write(os.environ.get('FAKE_OH_FIX_TEXT', ''))

    def close(self):
        pass
