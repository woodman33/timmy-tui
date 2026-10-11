/*
 * The companion page's STREAMDOWN CHAT tab (R4 H95): the React island the page had at b69ab12, with its features, built
 * on this computer instead of loaded from esm.sh.
 *
 * scripts/companion-web-build.mjs bundles this module with React, Streamdown 2.5.0, @streamdown/code 1.1.1 (Shiki, with
 * its JavaScript regex engine: no WebAssembly) and @streamdown/mermaid 1.0.2 (Mermaid, securityLevel 'strict') into files
 * the companion serves (/web/island/...); Streamdown's own styles.css and the Tailwind classes it emits, precompiled with
 * tailwindcss 3.4.19 (preflight off, darkMode 'class', as the page configured the Play CDN), are served beside them. Nothing
 * here is loaded from another site. The page's looks for this tab are classes of companion.css (the page allows no inline
 * style block; React's style objects became those classes).
 *
 * What it does, as before: a message goes to POST /chat through the page's own chat call (companion.js: the token in a
 * header), and the answer of qwen/qwen3.8-max streams back from OpenRouter with this computer's key, so each message spends
 * its credits; Streamdown draws it as it arrives (caret, highlighted code with its copy and download buttons, drawn mermaid
 * diagrams, tables, task lists, links). ✨ Try it streams the page's own sample through the same renderer: no model is
 * asked and nothing is sent. Token counts: an estimate from the answer's length (said to be one), or the count the provider
 * reported, when it reported one.
 *
 * What it no longer pretends (R4 H95): a <receipt> card shows the id and sha it was given, as received, and says this page
 * verifies nothing: its button copies the command that checks the chain (`timmy verify`). An <approval> card shows its
 * command and says nothing is run or decided from this page (the decision is the REPL's NEEDS YOU): its button copies the
 * command. Neither turns green, granted or denied.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { createMermaidPlugin } from '@streamdown/mermaid';

const h = React.createElement;
const { useState, useRef, useEffect } = React;

const MODEL = 'qwen/qwen3.8-max';
/** The command that checks Timmy's receipt chain where Timmy runs (src/cli.ts `timmy verify`: the runs chain). */
export const VERIFY_COMMAND = 'timmy verify';

/** Mermaid draws in its strict mode (no script in a diagram, no click handlers, labels as text), whatever a diagram asks. */
const mermaid = createMermaidPlugin({ config: { securityLevel: 'strict' } });

/**
 * Copies `text` for a person to paste; says what happened in `say` for a moment. Where the browser will not copy (a page
 * opened over plain http from another device is not a secure context), it says so and shows the text instead.
 */
async function copyText(text, say) {
  try {
    if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
    await navigator.clipboard.writeText(text);
    say('Copied: ' + text);
  } catch (e) {
    say('Not copied (this browser would not): ' + text);
  }
}

/** A button that copies `text`, its words changing for three seconds to say what happened. */
function CopyButton(props) {
  const [said, setSaid] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = (words) => { setSaid(words); clearTimeout(timer.current); timer.current = setTimeout(() => setSaid(null), 3000); };
  return h('button', { type: 'button', className: props.className, onClick: () => { void copyText(props.text, say); } }, said || props.label);
}

/* ---------- TMX custom components (allowlisted tags) ---------- */

// <receipt id="..." sha="..."> — the id and sha as the answer gave them; this page verifies nothing.
function ReceiptCard(props) {
  // Streamdown's sanitizer prefixes every id with 'user-content-' (so markup cannot clobber the page's own ids); the card
  // shows the id the answer gave
  const given = typeof props.id === 'string' && props.id.startsWith('user-content-') ? props.id.slice('user-content-'.length) : props.id;
  const id = given || '(no id given)';
  const sha = props.sha || '(no sha given)';
  return h('div', { className: 'sd-receipt', 'data-card': 'receipt' },
    h('div', { className: 'sd-card-head' },
      h('strong', { className: 'sd-receipt-title' }, '🧾 RECEIPT · AS RECEIVED'),
      h('span', { className: 'sd-card-state' }, 'NOT VERIFIED HERE')
    ),
    h('div', { className: 'sd-card-row' }, 'Run ID: ', h('span', { className: 'sd-receipt-id' }, id)),
    h('div', { className: 'sd-card-row sd-break' }, 'SHA-256: ', h('span', { className: 'sd-receipt-sha' }, sha)),
    props.children ? h('div', { className: 'sd-card-body' }, props.children) : null,
    h('div', { className: 'sd-card-note' },
      'This page verifies nothing: it shows what the answer named. ',
      h('code', null, VERIFY_COMMAND), ' checks the receipt chain on the computer that runs Timmy.'),
    h(CopyButton, { className: 'sd-card-btn', text: VERIFY_COMMAND, label: 'Copy ' + VERIFY_COMMAND })
  );
}

// <approval command="..."> — the command, shown; nothing is run or decided here (the REPL's NEEDS YOU decides).
function ApprovalCard(props) {
  const command = props.command || '(no command given)';
  return h('div', { className: 'sd-approval', 'data-card': 'approval' },
    h('div', { className: 'sd-card-head' },
      h('strong', { className: 'sd-approval-title' }, '🔐 APPROVAL GATE'),
      h('span', { className: 'sd-card-state' }, 'DECIDED IN THE REPL, NOT HERE')
    ),
    h('pre', { className: 'sd-approval-cmd' }, '$ ', command),
    h('div', { className: 'sd-card-note' },
      'Nothing is run or decided from this page. The REPL asks before a risky command runs (NEEDS YOU), and the answer is given there.'),
    h('div', { className: 'sd-card-actions' },
      props.command ? h(CopyButton, { className: 'sd-card-btn', text: command, label: 'Copy command' }) : null
    )
  );
}

const sdComponents = { receipt: ReceiptCard, approval: ApprovalCard };
const sdAllowedTags = { receipt: ['id', 'sha'], approval: ['command'] };

function Markdown(props) {
  return h(Streamdown, {
    plugins: { code, mermaid },
    allowedTags: sdAllowedTags,
    components: sdComponents,
    isAnimating: !!props.animating,
    caret: props.animating ? 'block' : undefined,
    linkSafety: { enabled: false }, // local companion; skip the external-link modal (as before)
    className: 'sd-island'
  }, props.text || '');
}

/* ---------- The sample for the ✨ Try it button: the page's own text (no model is asked) ---------- */

export const SAMPLE = [
  '## ⚡ TMX P3 — streaming markdown surface',
  '',
  'This sample is the page’s own text, streamed here and rendered live by **Streamdown**: no model was asked.',
  'The allowlisted custom tags below draw their cards:',
  '',
  '<receipt id="run_tmx_demo_001" sha="sha256_7f3c9a1e4b2d8c5f0a6e1d9b7c3f2a8e4d6b1c9f3a7e5d2b8c4f0a6e1d9b3c7f">A sample receipt tag: its id and sha are made up for this sample, and nothing was sealed.</receipt>',
  '',
  '<approval command="npm run build && npm test"></approval>',
  '',
  'Plugins work too — syntax highlighting and diagrams:',
  '',
  '```ts',
  'export function sealReceipt(runId: string): string {',
  '  const payload = JSON.stringify({ runId, sealedAt: Date.now() });',
  '  return `sha256_${sha256(payload)}`;',
  '}',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[User Prompt] --> B[POST /chat SSE]',
  '  B --> C[Streamdown Parser]',
  '  C --> D[receipt Card]',
  '  C --> E[approval Gate]',
  '  C --> F[Mermaid Diagram]',
  '```'
].join('\n');

/* ---------- App ---------- */

function App() {
  const [messages, setMessages] = useState([]); // { role: 'user' | 'assistant', content, sample }
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState(null);
  const [tokens, setTokens] = useState(0);
  const [usage, setUsage] = useState(null);
  const [last, setLast] = useState(null); // what the counter is about: 'sample' | 'answer' | null
  const scrollRef = useRef(null);
  const demoTimer = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, error]);

  useEffect(() => () => {
    if (demoTimer.current) clearInterval(demoTimer.current);
  }, []);

  const replaceLastAssistant = (text) => {
    setMessages((prev) => {
      const next = prev.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'assistant') {
          next[i] = Object.assign({}, next[i], { content: text });
          break;
        }
      }
      return next;
    });
  };

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    const page = window.timmyCompanion;
    if (!page || !page.ready()) {
      setError('This page has no token from Timmy, so it asks nothing: open the companion from `timmy watch` (q on HOME).');
      return;
    }
    setError(null); setUsage(null); setTokens(0); setLast('answer');

    // the conversation as sent: the person's messages and the model's answers, never a sample of the page's own
    const convo = messages.filter((m) => !m.sample).concat([{ role: 'user', content: text }]);
    setMessages((prev) => prev.concat([{ role: 'user', content: text }, { role: 'assistant', content: '' }]));
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    let acc = '';
    try {
      // R4 (H84): through the page's own chat call, which sends the companion's token in a header
      await page.chat(convo.map((m) => ({ role: m.role, content: m.content })), (event, data) => {
        if (event === 'delta') {
          acc += typeof data === 'string' ? data : JSON.stringify(data);
          replaceLastAssistant(acc);
          setTokens(Math.max(1, Math.ceil(acc.length / 4))); // an estimate: about 4 characters a token
        } else if (event === 'usage') {
          setUsage(data);
        } else if (event === 'error') {
          setError((data && data.error) || String(data));
        }
      }, controller.signal);
    } catch (err) {
      if (!err || err.name !== 'AbortError') setError((err && err.message) || String(err));
    } finally {
      setStreaming(false);
    }
  }

  function tryIt() {
    if (streaming) return;
    setError(null); setUsage(null); setTokens(0); setLast('sample');
    setMessages((prev) => prev.concat([
      { role: 'user', content: '✨ Try it: this page’s own sample (receipt + approval + code fence + mermaid; no model is asked)', sample: true },
      { role: 'assistant', content: '', sample: true }
    ]));
    setStreaming(true);
    setSampling(true);
    let i = 0;
    const CHUNK = 5;
    demoTimer.current = setInterval(() => {
      i += CHUNK;
      const slice = SAMPLE.slice(0, i);
      replaceLastAssistant(slice);
      setTokens(Math.max(1, Math.ceil(slice.length / 4)));
      if (i >= SAMPLE.length) {
        clearInterval(demoTimer.current);
        demoTimer.current = null;
        setStreaming(false);
        setSampling(false);
      }
    }, 16);
  }

  const reported = usage && (usage.total_tokens || usage.completion_tokens);
  const tokenLabel = last === null
    ? '◉ nothing sent yet'
    : streaming
      ? '◉ ~' + tokens + ' tokens (estimated while streaming)'
      : reported
        ? '◉ ' + reported + ' tokens (reported by the provider)'
        : last === 'sample'
          ? '◉ ~' + tokens + ' tokens (estimated; the sample asked no model)'
          : '◉ ~' + tokens + ' tokens (estimated: no count was reported)';

  return h('div', { className: 'sd-app' },
    // Meta bar: model, status, token counter
    h('div', { className: 'sd-meta' },
      h('div', { className: 'sd-chips' },
        h('span', { className: 'sd-chip' }, MODEL),
        h('span', { className: 'sd-chip' + (streaming ? ' on' : ''), id: 'sd-status', role: 'status', 'aria-live': 'polite' },
          streaming ? (sampling ? 'STREAMING THE SAMPLE…' : 'STREAMING…') : 'IDLE')
      ),
      h('span', { className: 'sd-tokens' + (streaming ? ' on' : ''), id: 'sd-tokens' }, tokenLabel)
    ),

    // Message scroll area
    h('div', { ref: scrollRef, className: 'sd-messages', id: 'sd-messages' },
      messages.length === 0
        ? h('div', { className: 'sd-empty' },
          'Send a message to stream ', MODEL, ' through Streamdown (through OpenRouter, with this computer’s key: each message spends its credits),',
          h('br'),
          'or press ✨ Try it to stream this page’s own sample (no model is asked).')
        : messages.map((m, i) => m.role === 'user'
          ? h('div', { key: i, className: 'sd-user' + (m.sample ? ' sample' : '') }, m.content)
          : h('div', { key: i, className: 'sd-answer' + (m.sample ? ' sample' : ''), 'data-sample': m.sample ? 'yes' : 'no' },
            h(Markdown, {
              text: m.content,
              animating: streaming && i === messages.length - 1
            })
          )
        ),
      error ? h('div', { className: 'sd-error', role: 'alert' }, '⚠ ', error) : null
    ),

    // Input bar
    h('div', { className: 'sd-input-bar' },
      h('input', {
        id: 'sd-input',
        className: 'sd-input',
        value: input,
        placeholder: 'Message ' + MODEL + ' … (streams back as SSE; spends credits)',
        'aria-label': 'Message to the model',
        disabled: streaming,
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
        }
      }),
      h('button', { type: 'button', id: 'sd-try', onClick: tryIt, disabled: streaming, className: 'sd-btn-ghost' }, '✨ Try it'),
      h('button', {
        type: 'button',
        id: 'sd-send',
        onClick: () => { void send(); },
        disabled: streaming || !input.trim(),
        className: 'sd-btn-primary'
      }, streaming ? 'Streaming…' : 'Send ⚡')
    )
  );
}

const rootEl = document.getElementById('streamdown-root');
if (rootEl) {
  rootEl.dataset.island = 'ready';
  createRoot(rootEl).render(h(App));
}
