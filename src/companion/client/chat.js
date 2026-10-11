/*
 * The model chat (the companion page's MODEL CHAT tab; R4 H92). It replaces the Streamdown island, which loaded React,
 * Streamdown and its plugins from esm.sh and compiled Tailwind in the page: that code ran with the page's token. Now it is
 * this module, the page's own markdown renderer (markdown.js) and marked, all served by the companion on this computer.
 *
 * A message goes to POST /chat through the page's own chat call (companion.js, which sends the token in a header); the
 * companion streams the answer of qwen/qwen3.8-max from OpenRouter, with this computer's key, so each message spends its
 * credits. The answer is drawn as it arrives. Show a sample draws a text of the page's own, saying so: no model is asked
 * and nothing is sent. Token counts: an estimate from the answer's length while it streams (said to be one), then the
 * count the provider reported, when it reported one.
 */
import { plainText, renderMarkdown } from '/markdown.js';

const MODEL = 'qwen/qwen3.8-max';

const messagesEl = document.getElementById('model-messages');
const emptyEl = document.getElementById('model-empty');
const inputEl = document.getElementById('model-input');
const sendEl = document.getElementById('model-send');
const sampleEl = document.getElementById('model-sample');
const statusEl = document.getElementById('model-status');
const tokensEl = document.getElementById('model-tokens');
const errorEl = document.getElementById('model-error');
const noteEl = document.getElementById('model-note');

/** marked's lexer once its module has loaded from this companion; null until then, or when it could not be loaded. */
let lex = null;
/** Every message on the tab: { role, content, sample, body } (body: the element its words are drawn in). */
const messages = [];
let busy = false;
let usage = null;
let estimate = 0;

function setStatus(state) {
  statusEl.dataset.state = state;
  statusEl.textContent = state === 'streaming' ? 'STREAMING…' : state === 'sample' ? 'DRAWING THE SAMPLE…' : 'IDLE';
}

function showTokens() {
  const reported = usage && (usage.total_tokens || usage.completion_tokens);
  tokensEl.textContent = reported
    ? `${reported} tokens (reported)`
    : estimate ? `~${estimate} tokens (estimated from its length)` : '';
}

function showError(words) {
  errorEl.textContent = words ? `⚠ ${words}` : '';
  errorEl.hidden = !words;
}

function updateSend() {
  sendEl.disabled = busy || !inputEl.value.trim();
  sampleEl.disabled = busy;
}

/** Draws a message's words: a person's as text, an answer as markdown (or as text until marked is here). */
function draw(m) {
  if (m.role === 'user') { m.body.textContent = m.content; return; }
  m.body.replaceChildren(lex ? renderMarkdown(m.content, lex) : plainText(m.content));
}

// While an answer streams, it is drawn at most once a frame.
const pending = new Set();
let frame = 0;
function schedule(m) {
  pending.add(m);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const p of pending) draw(p);
    pending.clear();
  });
}

function addMessage(role, content, sample = false) {
  if (emptyEl) emptyEl.hidden = true;
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}${sample ? ' sample' : ''}`;
  let body = wrap;
  if (role === 'assistant') {
    const who = document.createElement('div');
    who.className = 'chat-who';
    who.textContent = sample ? 'a sample of this page’s own (no model was asked)' : `the answer to a request for ${MODEL}, through OpenRouter`;
    body = document.createElement('div');
    body.className = 'md';
    wrap.append(who, body);
  }
  const m = { role, content, sample, body };
  messages.push(m);
  messagesEl.append(wrap);
  draw(m);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return m;
}

async function send() {
  const words = inputEl.value.trim();
  if (!words || busy) return;
  const page = window.timmyCompanion;
  if (!page || !page.ready()) {
    showError('This page has no token from Timmy, so it asks nothing: open the companion from `timmy watch` (q on HOME).');
    return;
  }
  showError('');
  usage = null;
  estimate = 0;
  showTokens();
  // the conversation as sent: the person's messages and the model's answers, never a sample of the page's own
  const convo = messages.filter((m) => !m.sample).map((m) => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: words }]);
  addMessage('user', words);
  const reply = addMessage('assistant', '');
  inputEl.value = '';
  busy = true;
  setStatus('streaming');
  updateSend();
  let acc = '';
  try {
    await page.chat(convo, (event, data) => {
      if (event === 'delta') {
        acc += typeof data === 'string' ? data : JSON.stringify(data);
        reply.content = acc;
        schedule(reply);
        estimate = Math.max(1, Math.ceil(acc.length / 4));
        showTokens();
      } else if (event === 'usage') {
        usage = data;
        showTokens();
      } else if (event === 'error') {
        showError((data && data.error) || String(data));
      }
    });
  } catch (err) {
    if (!err || err.name !== 'AbortError') showError((err && err.message) || String(err));
  } finally {
    draw(reply);
    busy = false;
    setStatus('idle');
    showTokens();
    updateSend();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

/** A text of the page's own, drawn as an answer would be, a few characters at a time. Nothing is sent. */
const SAMPLE = [
  '## A sample answer, drawn by this page',
  '',
  'This text is the page’s own: **no model was asked** and nothing was sent.',
  'It shows what the model chat draws:',
  '',
  '- headings, lists, **strong** and *emphasised* words',
  '- `inline code`, and code blocks with a Copy button',
  '- a mermaid block, shown as its source (no diagram is drawn here)',
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
  '  A[Your message] --> B[POST /chat]',
  '  B --> C[OpenRouter]',
  '  C --> D[This page draws the answer]',
  '```',
].join('\n');

function showSample() {
  if (busy) return;
  showError('');
  usage = null;
  estimate = 0;
  showTokens();
  addMessage('user', 'Show a sample (drawn by this page; no model is asked)', true);
  const reply = addMessage('assistant', '', true);
  busy = true;
  setStatus('sample');
  updateSend();
  let i = 0;
  const timer = setInterval(() => {
    i += 6;
    reply.content = SAMPLE.slice(0, i);
    schedule(reply);
    if (i >= SAMPLE.length) {
      clearInterval(timer);
      draw(reply);
      busy = false;
      setStatus('idle');
      updateSend();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }, 16);
}

inputEl.addEventListener('input', updateSend);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
});
sendEl.addEventListener('click', () => { void send(); });
sampleEl.addEventListener('click', showSample);
updateSend();
setStatus('idle');

// marked, from this companion (the installed package's own file); without it, answers are shown as plain text.
import('/vendor/marked.esm.js').then((m) => {
  lex = (src) => m.marked.lexer(src);
  for (const msg of messages) draw(msg);
}, () => {
  noteEl.textContent = 'The markdown parser could not be loaded from this computer, so answers are shown as plain text.';
  noteEl.hidden = false;
});
