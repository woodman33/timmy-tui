"""fake-openhands-sdk.py: a FAKE OpenHands SDK, a TEST DOUBLE for the tests of Timmy's OpenHands worker (round R4, H62).

It is NOT the OpenHands SDK: it calls no model, runs no tool and contacts nothing. It puts FAKE modules under the names
the worker imports (openhands.sdk, openhands.sdk.security.confirmation_policy, openhands.tools.preset.default) into
sys.modules, loads Timmy's real worker (workers/openhands/timmy_openhands.py, or the copy a run mounts) and runs its main(),
so the worker's own code runs as it does in its container: its stdin, its protocol lines, its signal handling, its exit.

    python3 -B fake-openhands-sdk.py <path to timmy_openhands.py>

The FAKE conversation acts on words in the task:
    HANG      two FAKE terminal actions (each adds 450 prompt and 15 completion tokens to the FAKE LLM's usage), then it
              waits until the process is stopped
    TEXTCALL  round R4, H69 (ledger row 162, r20): the FAKE model answers its first turn with TEXT that reads as a tool
              call's arguments, {"command": "find /work -name \"index.html\" -type f"}, not with a tool call; as the SDK does with
              any answer without a tool call, the FAKE conversation then says it finished, after 0 steps (5,552 prompt and
              100 completion tokens, as r20 reported)
    TEXTTWICE with TEXTCALL: two such answers (a FAKE conversation that goes on after the first)
    (default) one FAKE terminal action, then it finishes (status finished)
FAKE_SDK_SIGNAL_IN_WRITE=1: the worker's protocol channel sends this process a SIGTERM halfway through writing its first
action line (a signal arriving while the worker writes a line).
FAKE_SDK_OWN_HANDLER=1: the FAKE conversation installs a SIGTERM handler of its own as it is made, one that does nothing
(an SDK that would swallow the signal).
FAKE_SDK_NATIVE_TOOL_CALLING=0 or 1: the FAKE LLM's own native_tool_calling setting (absent when unset).

A FAKE litellm (round R4, H69), always put in place of the real one, so no test ever imports LiteLLM (whose import could
reach the network): it sends nothing anywhere. It keeps a FAKE model registry (register_model, supports_function_calling)
and a FAKE Ollama chat route whose parameter mapping decides, as LiteLLM's documentation describes its Ollama provider,
"litellm defaults to json mode tool calls if native tool calling not supported": the tools natively only for a model
registered as ollama_chat/<model> with supports_function_calling, otherwise JSON mode (format json, the tools put aside, and
the module's add_function_to_prompt set, as LiteLLM sets it). FAKE_LITELLM chooses how it behaves:
    (unset)          as above
    native           its Ollama chat route always passes the tools natively (as LiteLLM's current source does)
    refuse-register  register_model raises (a LiteLLM that refuses the entry)
    no-mapping       it has no OllamaChatConfig (only supports_function_calling can be asked)
    absent           no litellm at all: `import litellm` fails
FAKE_LITELLM_LOG=<file>: every call it is given (and the FAKE SDK's LLM as it is made) is appended there as a JSON line,
so a test can see what the worker gave LiteLLM and in which order.
"""
import importlib.util
import json
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


FAKE_LITELLM = os.environ.get("FAKE_LITELLM", "")
LOG = os.environ.get("FAKE_LITELLM_LOG")


def record(call, **fields):
    """One call, as a JSON line in FAKE_LITELLM_LOG (when a test names one)."""
    if not LOG:
        return
    with open(LOG, "a", encoding="utf-8") as out:
        out.write(json.dumps(dict(call=call, **fields), default=str, sort_keys=True) + "\n")


class LLM:
    def __init__(self, model, base_url=None, api_key=None, **options):
        self.model = model
        self.options = options
        self.metrics = Metrics()
        # FAKE_SDK_NATIVE_TOOL_CALLING=0 or 1: the FAKE LLM's own native_tool_calling setting (absent otherwise); 0 plays an
        # SDK that describes the tools in its prompt instead of giving them to LiteLLM
        flag = os.environ.get("FAKE_SDK_NATIVE_TOOL_CALLING")
        if flag in ("0", "1"):
            self.native_tool_calling = flag == "1"
        fake = sys.modules.get("litellm")
        record("openhands.sdk.LLM", model=model, base_url=base_url, options=sorted(options),
               add_function_to_prompt=getattr(fake, "add_function_to_prompt", None) if fake is not None else None)


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

    def answer_text(self, n, text):
        """The FAKE model answers with text and no tool call: the SDK's agent turns that into its MessageEvent."""
        usage = self.agent.llm.metrics.accumulated_token_usage
        usage.prompt_tokens += 5552
        usage.completion_tokens += 100
        for callback in self.callbacks:
            callback(event("MessageEvent", {"id": "m%d" % n, "source": "agent", "llm_message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}))

    def run(self):
        self.state.execution_status = "running"
        if "TEXTCALL" in self.task.split():
            # r20: the first tool call came back as plain text; an answer without a tool call ends the SDK's run (FINISHED)
            self.answer_text(1, '{"command": "find /work -name \\"index.html\\" -type f"}')
            if "TEXTTWICE" in self.task.split():
                self.answer_text(2, '```json\n{"command": "ls /work"}\n```')
            self.state.execution_status = "finished"
            return
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


def fake_litellm():
    """The FAKE litellm (see the docstring): a registry, and an Ollama chat route that decides as LiteLLM documents it."""
    registry = {}
    made = module("litellm", model_cost=registry, add_function_to_prompt=False)

    def register_model(model_cost):
        record("register_model", model_cost=model_cost)
        if FAKE_LITELLM == "refuse-register":
            raise ValueError("a FAKE refusal of register_model")
        for key, value in model_cost.items():
            registry.setdefault(key, {}).update(value)

    def supports_function_calling(model, custom_llm_provider=None):
        record("supports_function_calling", model=model)
        return registry.get(model, {}).get("supports_function_calling") is True

    class OllamaChatConfig:
        def map_openai_params(self, non_default_params, optional_params, model, drop_params):
            record("OllamaChatConfig.map_openai_params", model=model, params=sorted(non_default_params), drop_params=drop_params)
            for param, value in non_default_params.items():
                if param != "tools":
                    continue
                known = registry.get("ollama_chat/" + model, {}).get("supports_function_calling") is True
                if FAKE_LITELLM == "native" or known:
                    optional_params["tools"] = value
                else:
                    optional_params["format"] = "json"
                    made.add_function_to_prompt = True
                    optional_params["functions_unsupported_model"] = value
            return optional_params

    made.register_model = register_model
    made.supports_function_calling = supports_function_calling
    if FAKE_LITELLM != "no-mapping":
        made.OllamaChatConfig = OllamaChatConfig


if FAKE_LITELLM == "absent":
    sys.modules["litellm"] = None  # `import litellm` raises ImportError
else:
    fake_litellm()

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
