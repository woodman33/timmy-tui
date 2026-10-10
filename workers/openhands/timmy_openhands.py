"""timmy_openhands: one OpenHands SDK conversation, inside Timmy's OpenHands container (round R4, helper H52).

NOT YET EXERCISED with the real OpenHands SDK: written against the SDK as the older Command Post bridge used it
(scripts/openhands-sdk-bridge.py: LLM, Agent, LocalWorkspace, LocalConversation, NeverConfirm and the default tool
preset of openhands-sdk and openhands-tools 1.21.0) and against the SDK's documented names, each read defensively;
checked here only with `python3 -m py_compile`. The first real run is the operator's, on the Mac.

Timmy runs it as (src/code-agents/openhands.ts, openHandsDockerArgs)
    docker run --rm -i ... timmy-openhands:1.21.0 python /timmy/timmy_openhands.py
with only a COPY of the project mounted at /work (read-write) and a copy of this file mounted read-only at /timmy,
so changing this file needs no new image. The container is the boundary: nothing inside it asks for confirmation.

Its stdin: one JSON object, {"v": 1, "task": "<the task>", "token": "<32 hex>"}, read to its end.

What it runs: the SDK's Agent with two tools of the SDK's default preset, the terminal and the file editor (picked by
name, the browser left out; the SDK adds its own finish and think tools to every agent, as the Mac's run showed), on a LocalWorkspace at /work, with NeverConfirm, at most
TIMMY_OPENHANDS_MAX_ITERATIONS steps (default 40). The model is the one LLM_MODEL names at LLM_BASE_URL, with the key
LLM_API_KEY (Timmy gives ollama/<model>, this machine's Ollama as host.docker.internal sees it, and the local
placeholder key). An ollama model is asked without streaming: the older bridge saw a streamed answer lose its tool-call
arguments. Nothing here is specific to a task or a fixture.

Its stdout: JSON Lines, and nothing else. Each line carries "v": 1, its "type" and the run's "token" (Timmy believes a
line only with it); anything else this process or what it starts writes to its stdout goes to stderr instead:
    {"type": "started", "sdk", "tools_package", "python", "model", "tools", "max_iterations", "llm_options"}
    {"type": "action", "n", "tool", "name", "kind", "command"?, "path"?, "thought"?}         each one summarised,
    {"type": "observation", "n", "tool", "kind", "error", "exit_code"?, "excerpt"?}        with bounded excerpts
    {"type": "message", "source": "agent", "excerpt"}
    {"type": "error", "tool"?, "excerpt"}                    an error the SDK reported to the agent (it goes on)
    {"type": "event", "kind"}                                another SDK event, named only
    {"type": "result", "status", "finished", "steps", "max_iterations", "final_message", "final_chars", "usage"?, "error"?}
The result line is the last one: "finished" is true only when the SDK's own state says its conversation finished.

Stopped (round R4, H62; ledger row 159): on SIGTERM (what docker stop sends) or SIGINT (Ctrl+C through docker's signal
proxy) it prints its result line at once, from the handler itself, so no exception handling of the SDK's can swallow it:
    {"type": "result", "status": "stopped", "finished": false, "steps", "max_iterations", "signal", "usage"?, "final_message"?}
with its steps and its tokens so far; then it flushes and exits. A signal arriving while it writes a line waits for that
line to be written whole. A signal before it has read its task (it has no token yet) prints no protocol line, only its words
on stderr. A signal after its own result line changes nothing.

Its exit status: 0 finished; 3 the agent did not finish (its step limit, stuck, an error); 2 it could not start (its
stdin, the SDK, the tools); 143 stopped by SIGTERM (docker stop), 130 by SIGINT.
"""
import json
import os
import re
import signal
import sys
import threading
import traceback

PROTOCOL = 1
EXCERPT = 400
FINAL_MAX = 16000
STDIN_MAX = 4 * 1024 * 1024
WORK = "/work"
TERMINAL = re.compile(r"terminal|bash", re.I)
EDITOR = re.compile(r"file.?editor|str.?replace", re.I)
TOKEN_FORM = re.compile(r"[0-9a-f]{32}")

# The protocol channel is the stdout Timmy reads. Everything else written to fd 1 from here on (the SDK, LiteLLM, a
# library's print) goes to stderr, so it can never be read as a protocol line; os.dup's copy is not inherited by the
# processes the terminal tool starts.
_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", errors="replace")
os.dup2(2, 1)
sys.stdout = sys.stderr

TOKEN = None

# R4 (H62): what a stop's result line says, as main() makes it (a signal may come at any point of it).
RUN = {"events": None, "conversation": None, "llm": None, "limit": None}
# One line at a time on the protocol channel (the SDK may call back from a thread of its own).
_lock = threading.Lock()
# The main thread is writing a line: a signal handled meanwhile (signal handlers run in the main thread) waits for it.
_main_writing = False
_pending = None
# Its result line is out (its own, or a stop's): a later signal changes nothing.
_ended = False


def line_text(line_type, fields):
    line = {"v": PROTOCOL, "type": line_type}
    if TOKEN:
        line["token"] = TOKEN
    for key, value in fields.items():
        if value is not None:
            line[key] = value
    return json.dumps(line, ensure_ascii=True, default=str) + "\n"


def emit(line_type, /, **fields):
    # The line's type is positional-only: the action, observation and event lines also carry a field named `kind` (the
    # SDK's own kind), which a parameter named kind took twice (the Mac's first real run, ledger row 159: TypeError).
    global _main_writing
    text = line_text(line_type, fields)
    main = threading.current_thread() is threading.main_thread()
    if main:
        _main_writing = True
    try:
        with _lock:
            try:
                _proto.write(text)
                _proto.flush()
            except Exception:
                pass
    finally:
        if main:
            _main_writing = False
    # A stop that came while this line was written is acted on now that the line is whole (R4, H62).
    if main and _pending is not None:
        stop_now(_pending)


def clip(value, limit=EXCERPT):
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    text = text.replace("\r", "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def note(text):
    """A plain line on stderr: Timmy shows it as the worker's own words, and never believes it as a protocol line."""
    try:
        sys.stderr.write("timmy_openhands: " + text.replace("\n", " ") + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def finish(code):
    try:
        _proto.flush()
    except Exception:
        pass
    os._exit(code)


class Limit(BaseException):
    """Its step limit, enforced here when this SDK's conversation takes no iteration limit of its own."""


def signal_name(signum):
    try:
        return signal.Signals(signum).name
    except Exception:
        return "signal %s" % signum


def stop_now(signum):
    """R4 (H62): stopped by a signal (docker stop's SIGTERM, or SIGINT): its result line, status stopped, with its token,
    its steps and its tokens so far and the signal, flushed; then it exits 128 + the signal's number. With no token yet
    (its task not read) only its words, on stderr: a line without the run's token would not be believed."""
    global _ended, _pending
    if _ended:
        return
    _ended = True
    _pending = None
    name = signal_name(signum)
    if not TOKEN:
        note("stopped (%s) before it read its task" % name)
        finish(128 + signum)
    events = RUN.get("events")
    steps = events.steps if events is not None else 0
    usage = None
    try:
        usage = usage_of(RUN.get("conversation"), RUN.get("llm"))
    except BaseException:
        usage = None
    if usage is None and events is not None:
        usage = events.usage
    final = (events.finish_message or events.agent_message) if events is not None else None
    text = line_text("result", {"status": "stopped", "finished": False, "steps": steps, "max_iterations": RUN.get("limit"),
                                "signal": name, "usage": usage, "final_message": clip(final, FINAL_MAX)})
    # Another thread may be writing a line: it is let finish (bounded); this thread's own line is never interrupted here.
    held = _lock.acquire(timeout=5)
    try:
        _proto.write(text)
        _proto.flush()
    except BaseException:
        pass
    finally:
        if held:
            _lock.release()
    note("stopped (%s) at step %d" % (name, steps))
    finish(128 + signum)


def _stop(signum, frame):
    """SIGTERM or SIGINT: the result line now, or, when the main thread is writing a line, once that line is whole."""
    global _pending
    if _ended:
        return
    if _main_writing:
        _pending = signum
        return
    stop_now(signum)


def install_handlers():
    """SIGTERM and SIGINT are the worker's: installed at its start, and again before the conversation runs, in case the
    SDK installed its own while it was set up (R4, H62; whether it does was not checked with the real SDK)."""
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)


install_handlers()


def read_request():
    raw = sys.stdin.buffer.read(STDIN_MAX + 1)
    if len(raw) > STDIN_MAX:
        raise ValueError("its stdin held more than 4 MiB")
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict) or request.get("v") != 1:
        raise ValueError("its stdin is not a Timmy request (v 1)")
    task = request.get("task")
    token = request.get("token")
    if not isinstance(token, str) or not TOKEN_FORM.fullmatch(token):
        raise ValueError("its stdin carries no run token")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("its stdin carries no task")
    return task, token


def max_iterations():
    try:
        n = int(os.environ.get("TIMMY_OPENHANDS_MAX_ITERATIONS", "40"))
    except ValueError:
        n = 40
    return max(1, min(n, 500))


def dist_version(name):
    try:
        from importlib import metadata
        return metadata.version(name)
    except Exception:
        return None


def as_dict(obj):
    dump = getattr(obj, "model_dump", None)
    if callable(dump):
        try:
            value = dump(mode="json")
            if isinstance(value, dict):
                return value
        except Exception:
            pass
    return {}


def text_of(value, depth=0):
    """The text in a value the SDK gives (a string, TextContent items, a dict holding one), or None."""
    if value is None or depth > 4:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [text_of(item, depth + 1) for item in value]
        joined = "\n".join(part for part in parts if part)
        return joined or None
    if isinstance(value, dict):
        for key in ("text", "content", "output", "message", "error"):
            if key in value:
                found = text_of(value[key], depth + 1)
                if found:
                    return found
    return None


def tool_kind(name):
    if not isinstance(name, str):
        return "tool"
    if TERMINAL.search(name):
        return "terminal"
    if EDITOR.search(name):
        return "file_editor"
    return name


def pick_tools():
    """The terminal and the file editor from the SDK's default preset (as the older bridge used it), the browser left out."""
    from openhands.tools.preset.default import get_default_tools, register_default_tools
    for call in (lambda: register_default_tools(enable_browser=False), register_default_tools):
        try:
            call()
            break
        except TypeError:
            continue
    try:
        tools = get_default_tools(enable_browser=False)
    except TypeError:
        tools = get_default_tools()
    seen = []
    keep = []
    for tool in tools:
        name = getattr(tool, "name", None)
        if name is None and isinstance(tool, dict):
            name = tool.get("name")
        name = str(name)
        seen.append(name)
        if TERMINAL.search(name) or EDITOR.search(name):
            keep.append((tool, name))
    kinds = sorted({tool_kind(name) for _, name in keep})
    if len(keep) != 2 or kinds != ["file_editor", "terminal"]:
        raise RuntimeError("the default tool preset did not give one terminal and one file editor (it gave: %s)" % ", ".join(seen))
    return [tool for tool, _ in keep], [name for _, name in keep]


def make_llm(LLM, model, base_url, api_key):
    """The LLM with the options this SDK takes: each option it refuses is dropped, the last first, and said."""
    options = []
    if model.startswith(("ollama/", "ollama_chat/")):
        options.append(("stream", False))
    options.append(("timeout", 300))
    options.append(("usage_id", "agent"))
    last_error = None
    while True:
        try:
            llm = LLM(model=model, base_url=base_url, api_key=api_key, **dict(options))
            return llm, [key for key, _ in options]
        except Exception as error:  # pydantic refuses an unknown field; an older SDK has fewer options
            last_error = error
            if not options:
                raise last_error
            options.pop()


def make_conversation(agent, on_event, limit):
    import inspect
    try:
        from openhands.sdk import LocalConversation as Conversation
    except ImportError:
        from openhands.sdk import Conversation
    workspace = WORK
    try:
        from openhands.sdk import LocalWorkspace
        workspace = LocalWorkspace(working_dir=WORK)
    except Exception:
        workspace = WORK
    try:
        params = inspect.signature(Conversation.__init__).parameters
    except (TypeError, ValueError):
        params = {}
    kwargs = {}
    live = "callbacks" in params
    if live:
        kwargs["callbacks"] = [on_event]
    if "max_iteration_per_run" in params:
        kwargs["max_iteration_per_run"] = limit
    elif "max_iterations" in params:
        kwargs["max_iterations"] = limit
    if "visualizer" in params:
        kwargs["visualizer"] = None
    elif "visualize" in params:
        kwargs["visualize"] = False
    conversation = Conversation(agent=agent, workspace=workspace, **kwargs)
    try:
        from openhands.sdk.security.confirmation_policy import NeverConfirm
        setter = getattr(conversation, "set_confirmation_policy", None)
        if callable(setter):
            setter(NeverConfirm())
    except Exception as error:
        note("NeverConfirm could not be set (%s); the SDK's default confirmation policy applies" % clip(error, 200))
    return conversation, live, "max_iteration_per_run" in params or "max_iterations" in params


class Events:
    """Each SDK event, summarised as one protocol line (kind, tool, a bounded excerpt)."""

    def __init__(self, limit):
        self.steps = 0
        self.limit = limit
        self.enforce = False
        self.agent_message = None
        self.finish_message = None
        self.seen_ids = set()
        # R4 (H62): its tokens as of its last event, for a stop's result line when they cannot be read at that moment
        self.usage = None

    def __call__(self, event):
        try:
            key = getattr(event, "id", None)
            if key is not None:
                if key in self.seen_ids:
                    return
                self.seen_ids.add(key)
            try:
                self.usage = usage_of(RUN.get("conversation"), RUN.get("llm")) or self.usage
            except Exception:
                pass
            self.summarise(event)
            if self.enforce and self.steps > self.limit:
                raise Limit()
        except Limit:
            raise
        except Exception as error:
            emit("event", kind=clip(type(event).__name__, 60), note=clip("not summarised: %s" % error, 200))

    def summarise(self, event):
        kind = type(event).__name__
        data = as_dict(event)
        if kind == "ActionEvent" or (kind.endswith("ActionEvent") and "action" in data):
            self.steps += 1
            action = data.get("action") or {}
            name = data.get("tool_name") or action.get("kind") or "tool"
            command = action.get("command")
            path = action.get("path")
            if str(action.get("kind", "")).startswith("Finish") or str(name).lower() == "finish":
                message = action.get("message")
                if isinstance(message, str) and message.strip():
                    self.finish_message = message
            emit("action", n=self.steps, tool=tool_kind(name), name=clip(name, 60), kind=clip(action.get("kind") or kind, 60),
                 command=clip(command) if isinstance(command, str) else None,
                 path=clip(path, 300) if isinstance(path, str) else None,
                 thought=clip(text_of(data.get("thought")), 200))
            return
        if kind == "ObservationEvent" or kind.endswith("Observation") or kind.endswith("ObservationEvent"):
            observation = data.get("observation") or data
            name = data.get("tool_name") or observation.get("kind") or "tool"
            error = observation.get("error") or observation.get("is_error")
            exit_code = observation.get("exit_code")
            if not isinstance(exit_code, int):
                exit_code = (observation.get("metadata") or {}).get("exit_code") if isinstance(observation.get("metadata"), dict) else None
            emit("observation", n=self.steps, tool=tool_kind(name), kind=clip(observation.get("kind") or kind, 60),
                 error=bool(error) or kind == "UserRejectObservation",
                 exit_code=exit_code if isinstance(exit_code, int) else None,
                 excerpt=clip(text_of(observation)))
            return
        if kind == "MessageEvent":
            if data.get("source") == "agent":
                message = data.get("llm_message") or {}
                text = text_of(message.get("content") if isinstance(message, dict) else None)
                if text:
                    self.agent_message = text
                    emit("message", source="agent", excerpt=clip(text))
            return
        if kind == "AgentErrorEvent":
            emit("error", tool=clip(data.get("tool_name"), 60), excerpt=clip(data.get("error") or text_of(data)))
            return
        if kind in ("SystemPromptEvent", "ConversationStateUpdateEvent", "TokenEvent"):
            return
        emit("event", kind=clip(kind, 60))


def final_response(conversation, events):
    try:
        from openhands.sdk.conversation.response_utils import get_agent_final_response
        text = get_agent_final_response(conversation.state.events)
        if isinstance(text, str) and text.strip():
            return text
    except Exception:
        pass
    return events.finish_message or events.agent_message


def status_of(conversation):
    state = getattr(conversation, "state", None)
    status = getattr(state, "execution_status", None)
    if status is None:
        status = getattr(state, "agent_status", None)
    status = getattr(status, "value", status)
    return str(status).lower() if status is not None else "unknown"


def usage_of(conversation, llm):
    for source in (getattr(getattr(conversation, "agent", None), "llm", None), llm):
        metrics = getattr(source, "metrics", None)
        usage = getattr(metrics, "accumulated_token_usage", None)
        prompt = getattr(usage, "prompt_tokens", None)
        completion = getattr(usage, "completion_tokens", None)
        if isinstance(prompt, int) or isinstance(completion, int):
            return {"input": prompt if isinstance(prompt, int) else 0, "output": completion if isinstance(completion, int) else 0}
    return None


def final_result(**fields):
    """The run's own result line: once it is going out, a signal changes nothing (R4, H62)."""
    global _ended
    _ended = True
    emit("result", **fields)


def main():
    global TOKEN
    try:
        task, TOKEN = read_request()
    except Exception as error:
        note("its stdin is not a Timmy request: %s" % clip(error, 200))
        finish(2)
    limit = max_iterations()
    model = os.environ.get("LLM_MODEL", "")
    base_url = os.environ.get("LLM_BASE_URL", "")
    api_key = os.environ.get("LLM_API_KEY", "ollama")
    events = Events(limit)
    # R4 (H62): what a stop's result line reads, as it is made (a signal may come at any point from here on)
    RUN["limit"] = limit
    RUN["events"] = events
    conversation = None
    llm = None
    try:
        from openhands.sdk import LLM, Agent
        tools, names = pick_tools()
        llm, options = make_llm(LLM, model, base_url, api_key)
        RUN["llm"] = llm
        agent = Agent(llm=llm, tools=tools)
        conversation, live, bounded = make_conversation(agent, events, limit)
        RUN["conversation"] = conversation
    except Exception as error:
        final_result(status="setup", finished=False, steps=0, max_iterations=limit,
                     error=clip("%s: %s" % (type(error).__name__, error), 600))
        note(clip(traceback.format_exc(), 4000))
        finish(2)
    # An SDK whose conversation takes no iteration limit has its steps counted here, and is stopped past the limit.
    events.enforce = live and not bounded
    emit("started", sdk=dist_version("openhands-sdk"), tools_package=dist_version("openhands-tools"),
         python=sys.version.split()[0], model=clip(model, 200), tools=["terminal", "file_editor"], tool_names=names,
         max_iterations=limit, bounded=bounded or events.enforce, llm_options=options, live_events=live)
    error_text = None
    limited = False
    try:
        conversation.send_message(task)
        install_handlers()
        conversation.run()
    except Limit:
        limited = True
    except Exception as error:
        error_text = clip("%s: %s" % (type(error).__name__, error), 600)
        note(clip(traceback.format_exc(), 4000))
    if not live:
        for event in list(getattr(getattr(conversation, "state", None), "events", []) or []):
            events(event)
    status = status_of(conversation)
    finished = status == "finished" and error_text is None and not limited
    if not finished and error_text is not None:
        status = "error"
    elif not finished and (limited or events.steps >= limit):
        status = "limit"
    final = final_response(conversation, events)
    final_result(status=status, finished=finished, steps=events.steps, max_iterations=limit,
                 final_message=clip(final, FINAL_MAX), final_chars=len(final) if isinstance(final, str) else 0,
                 usage=usage_of(conversation, llm), error=error_text)
    code = 0 if finished else 3
    try:
        if conversation is not None and callable(getattr(conversation, "close", None)):
            conversation.close()
    except BaseException:
        pass
    finish(code)


if __name__ == "__main__":
    main()
