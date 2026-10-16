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
 *
 * R4 (H98): the ✨ sample says it is one where it is seen: its message, its answer and each card it draws carry a visible
 * SAMPLE label (the page's own chip). A card in a model's answer carries none.
 *
 * R4 (H104, second part): Send takes the chat's route, as the companion says it (companion.js: GET /api/chat/route, the
 * setup's choice; src/companion/chat-route.ts): with the local model, its answer streams from this computer's Ollama with no
 * tools, and the chip beside Send says so ("local <model> · Ollama · no tools here"); with OpenRouter and a key, as before;
 * with neither, Send stays off and the words above it say why and where chat happens. ✨ Try it asks no model either way.
 * R5 (H132): under the free-only policy, a model not known to be free leaves Send off in the policy's words; one that is free
 * is said to be (route.freeOnly).
 * What the local turn says beside its answer (a cloud-backed model, a cut answer) is shown under it, and its cost as the
 * route reports it (none on this computer's Ollama, otherwise unknown): never an invented number.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { createMermaidPlugin } from '@streamdown/mermaid';

const h = React.createElement;
const { useState, useRef, useEffect, createContext, useContext } = React;

/** R4 (H98): true inside the ✨ sample's answer, so each card drawn there says SAMPLE too. */
const SampleContext = createContext(false);
/** The visible SAMPLE label: the page's own chip. */
const sampleLabel = (words) => h('span', { className: 'sd-chip', 'data-sample-label': '' }, words || 'SAMPLE');

const MODEL = 'qwen/qwen3.8-max';
/** The command that checks Timmy's receipt chain where Timmy runs (src/cli.ts `timmy verify`: the runs chain). */
export const VERIFY_COMMAND = 'timmy verify';

/** Mermaid draws in its strict mode (no script in a diagram, no click handlers, labels as text), whatever a diagram asks. */
const mermaid = createMermaidPlugin({ config: { securityLevel: 'strict' } });

/*
 * R4 (H104): a drawn diagram keeps readable labels. r24: the ✨ sample's diagram labels were about 6 px. Mermaid gives its
 * drawing width="100%" (and a max-width of its own size); Streamdown puts it in a shrink-to-fit box, where 100% has nothing
 * to resolve against, so the browser drew it 300 px wide at every window size (measured in Chromium: 955 px of drawing at
 * 31%, its 16 px labels at 5 px), and its fullscreen view fitted it to the screen (6 px on a phone).
 *
 * Each drawing (in the chat and in its fullscreen view) is given its own size: as wide as it was drawn, narrower to fit its
 * panel, but never so narrow that its smallest text is under LABEL_MIN_PX on screen (its text's own size, at least 12 px).
 * What does not fit is cut at the panel's edge, its start shown first (companion.css), and Streamdown's own controls show
 * the rest: drag to pan, the zoom buttons and the mouse wheel, Reset, and fullscreen. The drawing's markup is Mermaid's
 * (set as it drew it); only the element's own style properties are set here, through the DOM, which the page's
 * Content-Security-Policy does not govern. The diagram downloads (SVG, PNG) are Mermaid's drawings as they were.
 */
export const LABEL_MIN_PX = 12;
const fitted = new WeakSet();

/** The smallest font size, in the drawing's own units (px at its own size), of text it draws; Infinity when it has none. */
function smallestText(svg) {
  let least = Infinity;
  const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    // the drawing's own style sheet, title and description are text that is not drawn
    if (!el || !n.nodeValue || !n.nodeValue.trim() || el.closest('style, title, desc')) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px > 0 && px < least) least = px;
  }
  return least;
}

/** Gives one drawn diagram its size (once): its own width, fitted to its panel down to the scale that keeps its text readable. */
export function fitDiagram(svg) {
  if (fitted.has(svg)) return;
  const box = svg.viewBox && svg.viewBox.baseVal;
  if (!box || !(box.width > 0) || !(box.height > 0)) return;
  fitted.add(svg);
  const least = smallestText(svg);
  // the scale at which its smallest text is LABEL_MIN_PX on screen (above 1 for a drawing whose text is smaller than that);
  // its least width rounded up to a whole pixel, so layout's rounding cannot take its text under LABEL_MIN_PX (measured:
  // 716.32 px was laid out at 716.31, its 16 px text at 11.9999 px)
  const floor = Number.isFinite(least) ? LABEL_MIN_PX / least : 1;
  const narrowest = Math.ceil(box.width * floor);
  svg.style.width = `${floor > 1 ? narrowest : box.width}px`;
  svg.style.maxWidth = '100%';
  svg.style.minWidth = `${narrowest}px`;
  svg.style.height = 'auto';
  svg.dataset.fit = String(Math.round(floor * 1000) / 1000);
}

/** Every drawn diagram on the page not given its size yet: Streamdown draws them in the chat and in a fullscreen view. */
function fitDiagrams() {
  for (const svg of document.querySelectorAll('[aria-label="Mermaid chart"] > svg')) fitDiagram(svg);
}

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
  const sample = useContext(SampleContext);
  // Streamdown's sanitizer prefixes every id with 'user-content-' (so markup cannot clobber the page's own ids); the card
  // shows the id the answer gave
  const given = typeof props.id === 'string' && props.id.startsWith('user-content-') ? props.id.slice('user-content-'.length) : props.id;
  const id = given || '(no id given)';
  const sha = props.sha || '(no sha given)';
  return h('div', { className: 'sd-receipt', 'data-card': 'receipt' },
    h('div', { className: 'sd-card-head' },
      h('strong', { className: 'sd-receipt-title' }, '🧾 RECEIPT · AS RECEIVED'),
      sample ? sampleLabel() : null,
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
  const sample = useContext(SampleContext);
  const command = props.command || '(no command given)';
  return h('div', { className: 'sd-approval', 'data-card': 'approval' },
    h('div', { className: 'sd-card-head' },
      h('strong', { className: 'sd-approval-title' }, '🔐 APPROVAL GATE'),
      sample ? sampleLabel() : null,
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
  // R4 (H104, second part): the chat's route (null until the companion answers), what the last answer's turn said beside it,
  // and its cost as the route reported it
  const [route, setRoute] = useState(null);
  const [notes, setNotes] = useState([]);
  const [cost, setCost] = useState(null);
  const scrollRef = useRef(null);
  const demoTimer = useRef(null);

  useEffect(() => {
    const page = window.timmyCompanion;
    if (!page || typeof page.onRoute !== 'function') return undefined;
    const off = page.onRoute(setRoute);
    // asked again when the person comes back to this window (a /setup in a terminal changes it)
    const again = () => { void page.refreshRoute(); };
    window.addEventListener('focus', again);
    return () => { off(); window.removeEventListener('focus', again); };
  }, []);

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
    // R4 (H104, second part): only on a route the companion named; with none, its words, and nothing is sent
    if (!route || !route.ready) {
      setError(route ? route.words : 'The companion has not said which route the chat takes yet, so nothing was sent.');
      return;
    }
    setError(null); setUsage(null); setTokens(0); setLast('answer'); setNotes([]); setCost(null);

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
        } else if (event === 'notice') {
          // R4 (H104, second part): what the local turn said beside its answer
          if (data && typeof data.text === 'string' && data.text) setNotes((prev) => prev.concat([data.text]));
        } else if (event === 'cost') {
          setCost(data && typeof data.words === 'string' ? data.words : null);
        }
      }, controller.signal);
    } catch (err) {
      if (!err || err.name !== 'AbortError') setError((err && err.message) || String(err));
    } finally {
      setStreaming(false);
      // the route as it is now (the setup may have changed it in a terminal)
      if (typeof page.refreshRoute === 'function') void page.refreshRoute();
    }
  }

  function tryIt() {
    if (streaming) return;
    setError(null); setUsage(null); setTokens(0); setLast('sample'); setNotes([]); setCost(null);
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

  // R4 (H104, second part): the route's words: what Send does and where, or why it is off
  const ready = Boolean(route && route.ready);
  const routeLabel = route ? route.label : 'asking the companion which route the chat takes…';
  const empty = !route
    ? ['Asking the companion which route the chat takes…', h('br', { key: 'b' }), 'Meanwhile ✨ Try it streams this page’s own sample (no model is asked).']
    : route.kind === 'local'
      ? ['Send a message to stream ', route.model, '’s answer from Ollama through Streamdown (no tools here; nothing goes to OpenRouter),', h('br', { key: 'b' }), 'or press ✨ Try it to stream this page’s own sample (no model is asked).']
      : route.kind === 'openrouter'
        ? ['Send a message to stream ', MODEL, route.freeOnly ? ' through Streamdown (through OpenRouter, with this computer’s key; free-only is on, and this model is free),' : ' through Streamdown (through OpenRouter, with this computer’s key: each message spends its credits),', h('br', { key: 'b' }), 'or press ✨ Try it to stream this page’s own sample (no model is asked).']
        : ['Send is off here (why: under the messages).', h('br', { key: 'b' }), '✨ Try it streams this page’s own sample (no model is asked).'];
  const placeholder = !route ? 'Asking the companion which route the chat takes…'
    : route.kind === 'local' ? 'Message ' + route.model + ' … (Ollama, no tools here)'
      : route.kind === 'openrouter' ? 'Message ' + MODEL + (route.freeOnly ? ' … (streams back as SSE; free-only: free)' : ' … (streams back as SSE; spends credits)')
        : 'Send is off: see why above';

  return h('div', { className: 'sd-app' },
    // Meta bar: the route, status, token counter
    h('div', { className: 'sd-meta' },
      h('div', { className: 'sd-chips' },
        h('span', { className: 'sd-chip route', id: 'sd-route-chip', 'data-route': route ? route.kind : 'unknown' }, routeLabel),
        h('span', { className: 'sd-chip' + (streaming ? ' on' : ''), id: 'sd-status', role: 'status', 'aria-live': 'polite' },
          streaming ? (sampling ? 'STREAMING THE SAMPLE…' : 'STREAMING…') : 'IDLE'),
        cost ? h('span', { className: 'sd-chip', id: 'sd-cost' }, cost) : null
      ),
      h('span', { className: 'sd-tokens' + (streaming ? ' on' : ''), id: 'sd-tokens' }, tokenLabel)
    ),

    // Message scroll area
    h('div', { ref: scrollRef, className: 'sd-messages', id: 'sd-messages' },
      messages.length === 0
        ? h('div', { className: 'sd-empty' }, ...empty)
        : messages.map((m, i) => m.role === 'user'
          ? h('div', { key: i, className: 'sd-user' + (m.sample ? ' sample' : '') }, m.sample ? sampleLabel() : null, m.sample ? ' ' : null, m.content)
          : h('div', { key: i, className: 'sd-answer' + (m.sample ? ' sample' : ''), 'data-sample': m.sample ? 'yes' : 'no' },
            m.sample ? h('div', { className: 'sd-chips' }, sampleLabel('SAMPLE · THE PAGE’S OWN TEXT · NO MODEL WAS ASKED')) : null,
            h(SampleContext.Provider, { value: !!m.sample },
              h(Markdown, {
                text: m.content,
                animating: streaming && i === messages.length - 1
              })
            )
          )
        ),
      notes.length ? h('div', { className: 'sd-notes', id: 'sd-notes' }, notes.map((n, i) => h('div', { key: i, className: 'sd-note' }, 'ⓘ ', n))) : null,
      error ? h('div', { className: 'sd-error', role: 'alert' }, '⚠ ', error) : null
    ),

    // R4 (H104, second part): why Send is off, and where chat happens, when the chat has no route here
    route && !route.ready ? h('div', { className: 'sd-route-off', id: 'sd-route-off', role: 'status' }, route.words) : null,

    // Input bar
    h('div', { className: 'sd-input-bar' },
      h('input', {
        id: 'sd-input',
        className: 'sd-input',
        value: input,
        placeholder,
        'aria-label': 'Message to the model',
        disabled: streaming || Boolean(route && !route.ready),
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
        disabled: streaming || !input.trim() || !ready,
        title: ready ? route.label : route ? route.words : 'Asking the companion which route the chat takes',
        className: 'sd-btn-primary'
      }, streaming ? 'Streaming…' : route && !route.ready ? 'Send: off' : 'Send ⚡')
    )
  );
}

const rootEl = document.getElementById('streamdown-root');
if (rootEl) {
  rootEl.dataset.island = 'ready';
  createRoot(rootEl).render(h(App));
  // R4 (H104): each diagram drawn, in the chat or in its fullscreen view (Streamdown's portal into the page's body), is
  // given its size as it appears
  new MutationObserver(fitDiagrams).observe(document.body, { childList: true, subtree: true });
}
