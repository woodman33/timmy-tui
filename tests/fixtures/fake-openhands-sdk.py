"""fake-openhands-sdk.py: a FAKE OpenHands SDK, a TEST DOUBLE for the tests of Timmy's OpenHands worker (round R4, H62).

It is NOT the OpenHands SDK: it calls no model, runs no tool and contacts nothing. It puts FAKE modules under the names
the worker imports (openhands.sdk, openhands.sdk.security.confirmation_policy, openhands.tools.preset.default) into
sys.modules, loads Timmy's real worker (workers/openhands/timmy_openhands.py, or the copy a run mounts) and runs its main(),
so the worker's own code runs as it does in its container: its stdin, its protocol lines, its signal handling, its exit.

    python3 -B fake-openhands-sdk.py <path to timmy_openhands.py>

The FAKE conversation acts on words in the task:
    HANG      two FAKE terminal actions (each adds 450 prompt and 15 completion tokens to the FAKE LLM's usage), then it
              waits until the process is stopped
    (default) one FAKE terminal action, then it finishes (status finished)
FAKE_SDK_SIGNAL_IN_WRITE=1: the worker's protocol channel sends this process a SIGTERM halfway through writing its first
action line (a signal arriving while the worker writes a line).
FAKE_SDK_OWN_HANDLER=1: the FAKE conversation installs a SIGTERM handler of its own as it is made, one that does nothing
(an SDK that would swallow the signal).
"""
import importlib.util
import os
import signal
import sys
import time
import types


class Dump:
    def __init__(self, data):
        self._d = data

    def model_dump(self, mode=None):
        return self._d


def event(name, data):
    return type(name, (Dump,), {})(data)


class Usage:
    def __init__(self):
        self.prompt_tokens = 0
        self.completion_tokens = 0


class Metrics:
    def __init__(self):
        self.accumulated_token_usage = Usage()


class LLM:
    def __init__(self, model, base_url=None, api_key=None, **options):
        self.model = model
        self.options = options
        self.metrics = Metrics()


class Agent:
    def __init__(self, llm, tools):
        self.llm = llm
        self.tools = tools


class LocalWorkspace:
    def __init__(self, working_dir):
        self.working_dir = working_dir


class State:
    def __init__(self):
        self.execution_status = "idle"
        self.events = []


class LocalConversation:
    def __init__(self, agent, workspace, callbacks=None, max_iteration_per_run=None, visualizer=None):
        self.agent = agent
        self.callbacks = list(callbacks or [])
        self.state = State()
        self.task = ""
        if os.environ.get("FAKE_SDK_OWN_HANDLER") == "1":
            signal.signal(signal.SIGTERM, lambda signum, frame: None)

    def send_message(self, text):
        self.task = text

    def set_confirmation_policy(self, policy):
        self.policy = policy

    def step(self, n, command):
        usage = self.agent.llm.metrics.accumulated_token_usage
        usage.prompt_tokens += 450
        usage.completion_tokens += 15
        for callback in self.callbacks:
            callback(event("ActionEvent", {"id": "a%d" % n, "tool_name": "terminal", "action": {"kind": "TerminalAction", "command": command}}))
            callback(event("ObservationEvent", {"id": "o%d" % n, "tool_name": "terminal", "observation": {"kind": "TerminalObservation", "exit_code": 0, "content": "ok"}}))

    def run(self):
        self.state.execution_status = "running"
        if "HANG" in self.task.split():
            self.step(1, "ls")
            self.step(2, "cat a.txt")
            while True:
                time.sleep(0.05)
        self.step(1, "ls")
        self.state.execution_status = "finished"

    def close(self):
        pass


class NeverConfirm:
    pass


class Tool:
    def __init__(self, name):
        self.name = name


def register_default_tools(enable_browser=True):
    return None


def get_default_tools(enable_browser=True):
    return [Tool("terminal"), Tool("file_editor"), Tool("task_tracker")]


def module(name, **attrs):
    made = types.ModuleType(name)
    made.__dict__.update(attrs)
    sys.modules[name] = made
    return made


module("openhands")
module("openhands.sdk", LLM=LLM, Agent=Agent, LocalConversation=LocalConversation, LocalWorkspace=LocalWorkspace)
module("openhands.sdk.security")
module("openhands.sdk.security.confirmation_policy", NeverConfirm=NeverConfirm)
module("openhands.tools")
module("openhands.tools.preset")
module("openhands.tools.preset.default", get_default_tools=get_default_tools, register_default_tools=register_default_tools)

spec = importlib.util.spec_from_file_location("timmy_openhands", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
# The worker's module code has run (its signal handlers are installed): a test may signal it from here on.
sys.stderr.write("fake-openhands-sdk: the worker is loaded (a FAKE SDK)\n")
sys.stderr.flush()

if os.environ.get("FAKE_SDK_SIGNAL_IN_WRITE") == "1":
    real = worker._proto

    class Interrupting:
        """The worker's protocol channel, with a SIGTERM arriving halfway through its first action line."""

        def __init__(self):
            self.sent = False

        def write(self, text):
            if not self.sent and '"type": "action"' in text:
                self.sent = True
                half = len(text) // 2
                real.write(text[:half])
                real.flush()
                os.kill(os.getpid(), signal.SIGTERM)
                real.write(text[half:])
                return len(text)
            return real.write(text)

        def flush(self):
            real.flush()

    worker._proto = Interrupting()

worker.main()
