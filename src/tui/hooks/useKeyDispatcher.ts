// v1.0.5-keyboard-arch — ONE root dispatcher + a focus STACK.
// The modalInput boolean is gone. The stack top is the single key owner
// ('nav' | 'input:*' | 'modal:*'); push on claim, pop on release, and
// pop-on-unmount is structural (a dead component can never hold focus).
// Esc is handled by the dispatcher BEFORE consulting the owner, so trapped
// focus is structurally impossible. The footer shows the stack top.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useInput, type Key } from 'ink';

export type KeyHandler = (input: string, key: Key) => void;

export interface FocusApi {
  stack: string[];
  top: string;
  claim: (name: string) => void;
  release: (name: string) => void;
  register: (name: string, h: KeyHandler) => void;
  handlerFor: (name: string) => KeyHandler | undefined;
}

const FocusContext = createContext<FocusApi | null>(null);

export function useFocus(): FocusApi {
  const api = useContext(FocusContext);
  if (!api) throw new Error('useFocus outside FocusProvider');
  return api;
}

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>(['nav']);
  const handlers = useRef(new Map<string, KeyHandler>());

  const api = useMemo<FocusApi>(() => ({
    stack,
    top: stack[stack.length - 1] ?? 'nav',
    claim: (name) => setStack(s => (s.includes(name) ? s : [...s, name])),
    release: (name) => setStack(s => (s.includes(name) ? s.filter(x => x !== name) : s)),
    register: (name, h) => { handlers.current.set(name, h); },
    handlerFor: (name) => handlers.current.get(name)
  }), [stack]);

  return React.createElement(FocusContext.Provider, { value: api }, children);
}

/**
 * Panel/component key owner. The callback ONLY fires when the dispatcher's
 * focus stack says this owner is active (or, in 'nav' mode, when the
 * dispatcher grants the residue to the active view's panels). Registers on
 * mount; unregister AND release on unmount — structural pop.
 */
export function useKeyOwner(name: string, handler: KeyHandler): void {
  const api = useFocus();
  const hRef = useRef(handler);
  hRef.current = handler;
  useEffect(() => {
    api.register(name, (i, k) => hRef.current(i, k));
    return () => {
      api.release(name);
      api.register(name, () => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
}

/** Guard for panel callbacks: silent under foreign input focus or modals. */
export function panelMayAct(api: FocusApi, mine: string): boolean {
  const t = api.top;
  if (t === 'nav') return true;              // dispatcher grants residue
  return t === mine;                          // our own claimed input
}

export interface DispatcherDeps {
  view: number;
  gotoView: (v: number) => void;
  cyclePane: (reverse: boolean) => void;
  openPalette: () => void;
  paletteKey: KeyHandler;
  toggleHelp: () => void;
  quit: () => void;
  jumpTelemetry: () => void;
  enterCommandInput: () => void;
}

/** The ONE root useInput. Routes every key exactly one place. */
export function useKeyDispatcher(d: DispatcherDeps): void {
  const api = useFocus();
  useInput((input, key) => {
    const top = api.top;

    // first-run onboarding is a sovereign permitted leaf
    if (top === 'modal:onboarding') return;

    // 1) Esc ALWAYS reaches the root, before any owner
    if (key.escape) {
      if (top.startsWith('modal:')) api.release(top);
      else if (top.startsWith('input:')) api.release(top);
      return; // nav: no-op
    }

    // 2) Tab is dispatcher-level focus cycling (owners never see it)
    if (key.tab) {
      if (!top.startsWith('modal:')) d.cyclePane(Boolean(key.shift));
      return;
    }

    // 3) modal owners get everything else
    if (top === 'modal:palette') { d.paletteKey(input, key); return; }
    if (top === 'modal:help') return; // help closes via Esc only
    if (top === 'modal:receipt') return; // receipt detail closes via Esc only

    // 4) input owner consumes the residue
    if (top.startsWith('input:')) {
      api.handlerFor(top)?.(input, key);
      return;
    }

    // 5) nav level globals — C3 (ui.cutover-plan): the v2 shell owns nav at
    // cutover, so these legacy globals live behind TIMMY_SHELL=v1 for one
    // release. ^C quit stays universal; ^K palette retires per reconciliation (a).
    if (key.ctrl && input === 'c') { d.quit(); return; }
    if (process.env.TIMMY_SHELL === 'v1') {
      if (key.ctrl && input === 'k') { d.openPalette(); return; }
      if (input >= '1' && input <= '9') { d.gotoView(Number(input) - 1); return; }
      if (input === 'l') { d.jumpTelemetry(); return; }
      if (input === 'q') { d.quit(); return; }
      if (input === '?') { d.toggleHelp(); return; }
      if (key.return && d.view === 0) { d.enterCommandInput(); return; }
    }
  });
}
