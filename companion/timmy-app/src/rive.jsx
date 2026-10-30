// R12: the Rive faces in the Timmy app — the PRODUCTION mounts of window.TimmyRive (src/companion/client/rive-bindings.js, bundled
// here for its side effect, as Timmy Canvas's rive-shape.js does): AgentConsole for the agent's activity, ProviderCard for a
// provider's connection, ActionButton for a real action. The state each face shows comes from the bindings' own feeds, called
// with the backend's events (fromSse with the Chat turn's SSE, fromProviderState with the providers' states): the face never
// invents a state, its HTML word stays beside it (or in the accessibility tree when the face carries it legibly), and a missing
// runtime or .riv leaves those words alone (the bindings' TRUTH rule).
import { useEffect, useRef } from 'react';
import '../../../src/companion/client/rive-bindings.js';

const R = () => (typeof window !== 'undefined' ? window.TimmyRive : null);

/** The agent's activity (AgentConsole): fed by the Chat turn's events through TimmyRive.fromSse. */
export function ConsoleFace({ size = 'wide', theme }) {
  const ref = useRef(null);
  useEffect(() => {
    const rive = R();
    const host = ref.current;
    if (!rive || !host) return undefined;
    host.replaceChildren();
    const h = rive.mountConsole(host, { size, place: 'app', heading: null, word: 'idle', words: 'spoken', theme });
    return () => { try { h.unmount(); } catch { /* gone */ } };
  }, [size, theme]);
  return <div ref={ref} className="ta-face ta-face-console" data-face="console" />;
}

/** A Control Room run's face: AgentConsole bound to that run alone ('job:<id>'), fed its record's state (TimmyRive.fromJob). */
const JOB_WORD = { running: 'working', stopping: 'stopping', stopped: 'stopped', failed: 'failed', interrupted: 'failed', refused: 'failed', succeeded: 'idle' };
export function RunFace({ id, state, live, size = 'card', theme }) {
  const ref = useRef(null);
  const handle = useRef(null);
  useEffect(() => {
    const rive = R();
    const host = ref.current;
    if (!rive || !host) return undefined;
    host.replaceChildren();
    const h = rive.mountConsole(host, { name: `run:${id}`, binds: [`job:${id}`], size, place: 'app', heading: null, word: JOB_WORD[state] || 'idle', words: 'spoken', theme, label: `Run ${id}` });
    handle.current = h;
    return () => { handle.current = null; try { h.unmount(); } catch { /* gone */ } };
  }, [id, size, theme]);
  useEffect(() => {
    const rive = R();
    if (rive && rive.fromJob && handle.current) try { rive.fromJob(handle.current, JOB_WORD[state] || 'idle', `GET /api/control/runs/${id} (the run's ${live ? 'job' : 'end'}: ${state})`, !live); } catch { /* the face keeps its word */ }
  }, [id, state, live]);
  return <div ref={ref} className="ta-face ta-face-console ta-face-run" data-face="run" data-run={id} data-state={state} />;
}

/** A provider's connection (ProviderCard): fed with the provider's state word through TimmyRive.fromProviderState. */
/**
 * `fed`: the state is this page's own observation (a check it made): the face is fed it and says LIVE. Otherwise the state is
 * what this computer recorded (the view's providers, maybe days old): the face is not fed, and its caption says so.
 */
export function ProviderFace({ provider, name, state, source, size = 'card', theme, fed = false }) {
  const ref = useRef(null);
  const handle = useRef(null);
  useEffect(() => {
    const rive = R();
    const host = ref.current;
    if (!rive || !host) return undefined;
    host.replaceChildren();
    const h = rive.mountProviderCard(host, provider, { providerName: name, size, place: 'app', words: 'spoken', theme,
      ...(fed ? {} : { caption: 'AS RECORDED  /  NOT CHECKED ON THIS PAGE', word: typeof state === 'string' && state ? `${state} (recorded)` : 'not checked' }) });
    handle.current = h;
    return () => { handle.current = null; try { h.unmount(); } catch { /* gone */ } };
  }, [provider, size, theme, fed, fed ? '' : state]);
  useEffect(() => {
    const rive = R();
    if (fed && rive && typeof state === 'string' && state) rive.fromProviderState(provider, state, source);
  }, [provider, state, source, theme, fed]);
  useEffect(() => { if (handle.current && handle.current.setProvider) handle.current.setProvider({ name }); }, [name]);
  return <div ref={ref} className="ta-face ta-face-provider" data-face="provider" data-provider={provider} />;
}

/**
 * A real action (ActionButton): a <button> the bindings make around the canvas; a trusted click, Enter or Space calls `onPress`.
 * `disabled` sets the button's disabled attribute, and its words say "unavailable".
 */
export function ActionFace({ label, onPress, disabled = false, name, size = 'card', theme }) {
  const ref = useRef(null);
  const handle = useRef(null);
  const press = useRef(onPress);
  press.current = onPress;
  useEffect(() => {
    const rive = R();
    const host = ref.current;
    if (!rive || !host) return undefined;
    host.replaceChildren();
    const h = rive.mountActionButton(host, { label, name: name || `action:${label}`, size, place: 'app', theme, action: (ev) => { if (typeof press.current === 'function') press.current(ev); } });
    handle.current = h;
    if (disabled) h.setDisabled(true);
    return () => { handle.current = null; try { h.unmount(); } catch { /* gone */ } };
  }, [label, size, theme, name]);
  useEffect(() => { if (handle.current && handle.current.setDisabled) handle.current.setDisabled(disabled); }, [disabled]);
  return <div ref={ref} className="ta-face ta-face-action" data-face="action" />;
}

/** The bindings' feeds, for the store (null when the runtime script is absent). */
export const riveFeed = {
  sse(event, data) { const rive = R(); if (rive) try { rive.fromSse(event, data, `POST /api/chat/turn (SSE ${event})`); } catch { /* the face keeps its word */ } },
  /** A provider's check answered on this page: every face bound to that provider (the Models card, the desk's) takes it, LIVE. */
  provider(id, word, source) { const rive = R(); if (rive && typeof word === 'string' && word) try { rive.fromProviderState(id, word, source); } catch { /* the face keeps its word */ } },
  stopping(source = 'Stop taken (POST /api/chat/stop)') { const rive = R(); if (rive) try { rive.stopping(source); } catch { /* the face keeps its word */ } },
};
