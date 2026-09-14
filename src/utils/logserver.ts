// timmy logs companion — live receipt/event viewer for headless mode.
// When TIMMY is driven via MCP or CLI (no TUI on screen), this zero-dep
// server auto-pops a localhost page that streams the SAME NDJSON event bus
// the TUI consumes, plus the receipt chain with a verify button.
// SSE tail of .timmy/runs/timmy-events.jsonl; no dependencies, no secrets.
import { createServer, ServerResponse } from 'http';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { armPlan, dispatchPlan, dispatchContainerized, getPlan, pauseOrCancelLane, collectRun, createPlan, type DispatchPlan } from './dispatch.js';
import { composeUnifiedStage, stageHierarchy } from './usd-compiler.js';
import { merkleProofTree } from './agent-pass.js';
import { compileMissionMap, type MissionMapDoc } from './slate-compiler.js';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { readEvents, eventsPath, TimmyEvent } from './eventbus.js';
import { readChain, verifyChain, verifySignature, hashOf, appendReceipt } from './receipts.js';
import { listEscrows } from './escrow-engine.js';
import { theme } from '../tui/theme.js';

export const LOGS_PORT = (): number => Number(process.env.TIMMY_LOGS_PORT ?? 4310);

const kindColor = (kind: string): string => {
  if (kind.includes('sealed') || kind.includes('completed')) return theme.seal;
  if (kind.includes('failed') || kind.includes('broken')) return theme.danger;
  if (kind.includes('approval') || kind.includes('gated')) return theme.warn;
  if (kind.includes('fusion') || kind.includes('run')) return theme.accent;
  return theme.textSecondary;
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY :: LIVE LOGS</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid ${theme.surfaceRaised}; position: sticky; top: 0; background: ${theme.ground}; }
  header .logo { color: ${theme.accent}; font-weight: 700; letter-spacing: .08em; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: ${theme.danger}; }
  header .dot.on { background: ${theme.accent}; box-shadow: 0 0 8px ${theme.accent}88; }
  header .meta { color: ${theme.textMuted}; }
  header .right { margin-left: auto; display: flex; gap: 8px; }
  button { background: ${theme.surfaceRaised}; color: ${theme.accent}; border: 1px solid ${theme.line}; border-radius: 4px; font: inherit; padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: ${theme.accent}; }
  main { display: grid; grid-template-columns: 1.4fr 1fr; gap: 0; height: calc(100vh - 42px); }
  section { overflow-y: auto; padding: 12px 16px; }
  section + section { border-left: 1px solid ${theme.surfaceRaised}; }
  h2 { color: ${theme.accent}; font-size: 11px; letter-spacing: .18em; margin-bottom: 10px; }
  .ev { display: flex; gap: 10px; padding: 2px 0; white-space: pre-wrap; word-break: break-word; }
  .ev .ts { color: ${theme.textMuted}; flex: 0 0 86px; }
  .ev .kind { flex: 0 0 150px; font-weight: 600; }
  .ev .pl { color: ${theme.textSecondary}; }
  .rc { border: 1px solid ${theme.surfaceRaised}; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: ${theme.ground}; }
  .rc .sub { color: ${theme.textPrimary}; }
  .rc .hash { color: ${theme.seal}; }
  .rc .prev { color: ${theme.textMuted}; }
  .rc .meta { color: ${theme.textMuted}; font-size: 11px; }
  #verify-out { color: ${theme.warn}; padding: 6px 16px; border-top: 1px solid ${theme.surfaceRaised}; }
</style></head><body>
<header>
  <span class="logo">TIMMY</span><span class="meta">:: LIVE LOGS</span>
  <span class="dot" id="dot"></span><span class="meta" id="conn">connecting…</span>
  <span class="meta" id="cwd"></span>
  <span class="right"><button id="verify">verify chain</button></span>
</header>
<div id="verify-out"></div>
<main>
  <section><h2>EVENT BUS · LIVE</h2><div id="events"></div></section>
  <section><h2>RECEIPT CHAIN · runs</h2><div id="chain"></div></section>
</main>
<script>
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const eventsEl = document.getElementById('events');
const colors = KIND => KIND.includes('sealed')||KIND.includes('completed') ? theme.seal
  : KIND.includes('failed')||KIND.includes('broken') ? theme.danger
  : KIND.includes('approval')||KIND.includes('gated') ? theme.warn
  : KIND.includes('fusion')||KIND.includes('run') ? theme.accent : theme.textSecondary;
function addEvent(ev, scroll) {
  const d = document.createElement('div'); d.className = 'ev';
  d.innerHTML = '<span class="ts">'+esc((ev.ts||'').slice(11,19))+'</span>'
    + '<span class="kind" style="color:'+colors(ev.kind)+'">'+esc(ev.kind)+'</span>'
    + '<span class="pl">'+esc(JSON.stringify(ev.payload||{}).slice(0,220))+'</span>';
  eventsEl.appendChild(d);
  if (scroll) eventsEl.parentElement.scrollTop = eventsEl.parentElement.scrollHeight;
}
function loadChain() {
  fetch('/receipts?stream=runs').then(r=>r.json()).then(list => {
    const el = document.getElementById('chain');
    el.innerHTML = list.slice(-25).reverse().map(r =>
      '<div class="rc"><div class="sub">'+esc(r.subject||r.kind||'')+'</div>'
      + '<div><span class="hash">hash '+esc(String(r.hash||'').slice(0,18))+'…</span> '
      + '<span class="prev">prev '+esc(String(r.prev_hash||'').slice(0,18))+'…</span></div>'
      + '<div class="meta">'+esc(r.policy||'')+' · '+esc(String(r.ts||r.created_at||'').slice(11,19))+'</div></div>'
    ).join('');
  }).catch(()=>{});
}
const es = new EventSource('/events');
es.onopen = () => { document.getElementById('dot').className = 'dot on'; document.getElementById('conn').textContent = 'live'; };
es.onerror = () => { document.getElementById('dot').className = 'dot'; document.getElementById('conn').textContent = 'reconnecting…'; };
es.onmessage = m => { addEvent(JSON.parse(m.data), true); if (JSON.parse(m.data).kind === 'receipt.sealed') loadChain(); };
document.getElementById('verify').onclick = () => {
  fetch('/verify?stream=runs').then(r=>r.json()).then(v => {
    document.getElementById('verify-out').textContent = v.ok
      ? '✓ chain intact · '+v.count+' receipts · ed25519 signed · hash-linked'
      : '× chain BROKEN at '+(v.brokenAt||'?');
  });
};
fetch('/health').then(r=>r.json()).then(h => { document.getElementById('cwd').textContent = h.cwd; });
loadChain();
</script></body></html>`;

// ---- Command Post survey column (same controller, allowlisted actions) ----
export const isLocalIp = (ip: string): boolean =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

const listPlans = () => {
  const dir = join(process.cwd(), '.timmy', 'dispatch');
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return {
        id: s.id, lifecycle: s.lifecycle, plan_hash: s.plan_hash,
        harness: (s.plan?.harnesses ?? []).join(','), objective: (s.plan?.objective ?? '').slice(0, 60),
        blocked: s.blocked ?? null
      };
    });
  } catch { return []; }
};

// Mission Studio: survey surface for the Mission Map compiler + frame-accurate
// playback of compiled mission stages. Compiles only — launching stays with
// the controller (plan_dispatch → approve → dispatch). The Bézier sampler
// MIRRORS src/utils/theatre-runtime.ts (same bisection math, deterministic);
// bundler-based studios load the identical state via @theatre/core.
const MISSION_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY :: MISSION STUDIO</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 16px; }
  h1 { color: ${theme.accent}; font-size: 14px; letter-spacing: .12em; margin-bottom: 10px; }
  h2 { color: ${theme.accent}; font-size: 11px; letter-spacing: .18em; margin: 14px 0 6px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  textarea { flex: 1; min-width: 320px; background: ${theme.surfaceRaised}; color: ${theme.textPrimary}; border: 1px solid ${theme.line}; border-radius: 6px; padding: 8px; font: inherit; height: 170px; }
  button { background: ${theme.surfaceRaised}; border: 1px solid ${theme.accent}; color: ${theme.accent}; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: ${theme.accent}; color: ${theme.accent}; }
  input { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.textPrimary}; border-radius: 6px; padding: 6px 8px; font: inherit; }
  .plan { border: 1px solid ${theme.line}; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: ${theme.surfaceRaised}; }
  .plan .obj { font-weight: 600; }
  .plan .meta { color: ${theme.textSecondary}; font-size: 11px; }
  .plan .hash { color: ${theme.textPrimary}; }
  .err { color: ${theme.danger}; margin: 6px 0; }
  #stage { width: 260px; height: 130px; border: 1px solid ${theme.line}; background: ${theme.surfaceRaised}; position: relative; margin: 8px 0; }
  #actor { position: absolute; left: 20px; top: 50px; width: 24px; height: 24px; background: ${theme.accent}; border-radius: 4px; }
  #clock { color: ${theme.warn}; }
  .note { color: ${theme.textMuted}; font-size: 11px; }
</style></head><body>
<h1>TIMMY :: MISSION STUDIO · compile + playback</h1>

<h2>1 · MISSION MAP → CUE PLANS (timmy_mission_compile)</h2>
<div class="row"><textarea id="doc" spellcheck="false"></textarea></div>
<div class="row" style="margin-top:8px">
  <button onclick="compile()">compile</button>
  <span class="note">compiles only — launch stays with the controller: timmy_plan_dispatch → timmy approve → timmy_dispatch_plan</span>
</div>
<div id="plans"></div>

<h2>2 · THEATRE PLAYBACK (frame-accurate · 30fps timebase)</h2>
<div class="row">
  <input id="folder" value="studio/timmy-sting-5s" size="34">
  <button onclick="loadState()">load state</button>
  <button onclick="play()">play</button>
  <button onclick="stop()">stop</button>
</div>
<div id="stage"><div id="actor"></div></div>
<div id="clock">t=0.000</div>
<div id="stateNote" class="note">no state loaded — compiled folders carry theatre-state.json (theatre-runtime saveTheatreState)</div>

<h2>3 · VIDEO STEM (W3C media fragments — same addressing as the EDL)</h2>
<div class="row">
  <input id="vsrc" placeholder="media url" size="40">
  <input id="vin" type="number" value="0" step="0.1" style="width:70px">
  <input id="vout" type="number" value="5" step="0.1" style="width:70px">
  <button onclick="playVid()">play fragment</button>
</div>
<video id="vid" controls style="max-width:480px;width:100%;margin-top:8px;border:1px solid ${theme.line}"></video>

<h2>4 · LIVE MISSION TELEMETRY (container runs · event-bus SSE)</h2>
<div style="max-height:180px;overflow-y:auto;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised}">
  <pre id="telelog" style="padding:8px;color:${theme.textSecondary};font:inherit;white-space:pre-wrap">no live run yet — arm + launch an openhands/docker plan above</pre>
</div>

<h2>5 · INSPECTORS (Merkle proof tree · USD stage hierarchy)</h2>
<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:280px">
    <h3 style="color:${theme.seal}">Merkle proof</h3>
    <textarea id="passjson" rows="4" style="width:100%;background:${theme.surfaceRaised};color:${theme.textSecondary};border:1px solid ${theme.line};border-radius:6px;font:inherit">paste AgentPass JSON</textarea>
    <button id="btnmerkle">inspect merkle</button>
  </div>
  <div style="flex:1;min-width:280px">
    <h3 style="color:${theme.accent}">USD stage</h3>
    <textarea id="scenejson" rows="4" style="width:100%;background:${theme.surfaceRaised};color:${theme.textSecondary};border:1px solid ${theme.line};border-radius:6px;font:inherit">paste UsdScene JSON</textarea>
    <button id="btnstage">inspect stage</button>
  </div>
</div>
<pre id="insp" style="max-height:240px;overflow-y:auto;padding:8px;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised};color:${theme.textSecondary};font:inherit;white-space:pre-wrap"></pre>

<h2>6 · ESCROW LEDGER (live locks · refunds · slashes)</h2>
<pre id="escrows" style="max-height:160px;overflow-y:auto;padding:8px;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised};color:${theme.textSecondary};font:inherit;white-space:pre-wrap">no escrows yet</pre>

<script>
async function refreshEscrows() {
  const r = await (await fetch('/mission/escrows')).json();
  const box = document.getElementById('escrows');
  if (!r.ok || !r.escrows.length) { box.textContent = 'no escrows yet — arm one via the escrow engine'; return; }
  box.textContent = r.escrows.map(e =>
    e.escrow_id + ' · ' + e.state + ' · ceiling ' + e.ceiling_usd + ' · drawn ' + e.drawn_usd +
    (e.refund_usd != null ? ' · refund ' + e.refund_usd : '') +
    (e.qa_value != null ? ' · qa ' + e.qa_value : '') +
    (e.merkle_root ? ' · merkle ' + e.merkle_root : '')).join('\\n');
}
new EventSource('/events').onmessage = m => {
  const e = JSON.parse(m.data);
  if (String(e.kind).startsWith('escrow.')) refreshEscrows();
};
refreshEscrows();
async function inspectKind(kind) {
  const out = document.getElementById('insp');
  try {
    const body = kind === 'merkle'
      ? { kind, pass: JSON.parse(document.getElementById('passjson').value) }
      : { kind, scene: JSON.parse(document.getElementById('scenejson').value) };
    const r = await (await fetch('/mission/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) { out.textContent = 'parse error: ' + e; }
}
document.getElementById('btnmerkle').onclick = () => inspectKind('merkle');
document.getElementById('btnstage').onclick = () => inspectKind('stage');
const DEFAULT_DOC = {
  nodes: [
    { id: 'sting', kind: 'capsule', objective: 'render the 5s sting', copies: 1 },
    { id: 'stingHarness', kind: 'harness', harness: 'hyperframes' },
    { id: 'fix', kind: 'capsule', objective: 'sandboxed patch pass' },
    { id: 'fixHarness', kind: 'harness', harness: 'openhands', workspace: 'docker' },
    { id: 'fixGate', kind: 'gate', approval: 'manual', acceptance: ['npm test'] },
    { id: 'stingOut', kind: 'artifact', path: 'package.json' }
  ],
  edges: [
    { from: 'stingHarness', to: 'sting', kind: 'harness' },
    { from: 'fixHarness', to: 'fix', kind: 'harness' },
    { from: 'fixGate', to: 'fix', kind: 'gate' },
    { from: 'stingOut', to: 'fix', kind: 'artifact' },
    { from: 'sting', to: 'fix', kind: 'depends' }
  ]
};
document.getElementById('doc').value = JSON.stringify(DEFAULT_DOC, null, 2);

async function compile() {
  const out = document.getElementById('plans');
  out.innerHTML = '';
  let r;
  try {
    const res = await fetch('/mission/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: JSON.parse(document.getElementById('doc').value) }) });
    r = await res.json();
  } catch (e) { out.innerHTML = '<div class="err">compile failed: ' + String(e) + '</div>'; return; }
  for (const e of r.errors ?? []) out.innerHTML += '<div class="err">× ' + e + '</div>';
  PLANS = r.plans ?? [];
  PLANS.forEach((p, i) => {
    out.innerHTML += '<div class="plan"><div class="obj">' + p.plan.objective + '</div>'
      + '<div class="meta">node ' + p.node_id + ' · harness ' + p.plan.harnesses[0] + ' · workspace ' + p.plan.workspace.kind
      + ' · depends_on [' + (p.plan.cadence.depends_on || []).join(', ') + '] · approval ' + p.plan.approval.mode
      + ' · manifest ' + (p.plan.context_manifest || []).map(m => m.path + '@' + m.sha256.slice(0, 8) + '…').join(' ') + '</div>'
      + '<div class="meta" style="margin-top:6px"><button onclick="storePlan(' + i + ')">send to controller</button> <span id="gw-' + i + '"></span></div></div>';
  });
  if (!PLANS.length && !(r.errors ?? []).length) out.innerHTML = '<div class="err">no capsules in doc</div>';
}

// Arming gateway: the companion only EMITS hash-bound requests; the
// controller validates the operator token and alone executes (J-BANG).
let PLANS = [];
async function storePlan(i) {
  const el = document.getElementById('gw-' + i);
  const res = await fetch('/mission/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: PLANS[i].plan }) });
  const r = await res.json();
  if (!r.ok) { el.innerHTML = '<span class="err">× ' + (r.note ?? 'rejected') + '</span>'; return; }
  el.dataset.id = r.id;
  el.innerHTML = 'stored ' + r.id + ' · hash <span class="hash">' + r.plan_hash + '</span> '
    + '<input id="tok-' + i + '" placeholder="operator token (timmy approve …)" size="26"> '
    + '<button onclick="armLaunch(' + i + ')">arm + launch</button> <span id="al-' + i + '"></span>';
}
async function armLaunch(i) {
  const el = document.getElementById('gw-' + i);
  const out = document.getElementById('al-' + i);
  const id = el.dataset.id;
  const token = (document.getElementById('tok-' + i) || {}).value ?? '';
  const a = await fetch('/dispatch/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'arm', token }) });
  const ar = await a.json();
  if (!ar.ok) { out.innerHTML = '<span class="err">arm denied: ' + (ar.note ?? '?') + '</span>'; return; }
  const l = await fetch('/dispatch/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'launch' }) });
  const lr = await l.json();
  out.innerHTML = lr.ok ? '<span class="hash">J-BANG! launched ' + (lr.session ?? id) + '</span>' : '<span class="err">launch refused: ' + (lr.note ?? '?') + '</span>';
  if (lr.ok && lr.container) { streamTelemetry(id); out.innerHTML += ' <span class="note">· containerized · telemetry below</span>'; }
}

// Real-time telemetry: the SAME NDJSON event bus the TUI consumes, filtered
// to the launched plan. Read-only — the companion still never executes.
// Hardened (v0.7.7): bounded ring buffer (oldest lines dropped), autoscroll
// only while pinned to the tail, and drop-recovery — on reconnect the /events
// replay refills a cleared buffer so a dropped connection never reads as
// silence.
const TELE_CAP = 200;
let TELE_ID = null, TELE_ES = null, TELE_LINES = [], TELE_DROP = false;
function teleRender() {
  const box = document.getElementById('telelog').parentElement;
  const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  document.getElementById('telelog').textContent = TELE_LINES.join('\\n') + (TELE_LINES.length ? '\\n' : '');
  if (pinned) box.scrollTop = box.scrollHeight;
}
function telePush(line) {
  TELE_LINES.push(line);
  if (TELE_LINES.length > TELE_CAP) TELE_LINES.splice(0, TELE_LINES.length - TELE_CAP);
  teleRender();
}
function streamTelemetry(id) {
  TELE_ID = id;
  TELE_LINES = [];
  document.getElementById('telelog').textContent = '';
  if (!TELE_ES) {
    TELE_ES = new EventSource('/events');
    TELE_ES.onopen = () => {
      if (TELE_DROP) { TELE_LINES = []; telePush('sse.reconnected · replaying event tail'); TELE_DROP = false; }
    };
    TELE_ES.onerror = () => { TELE_DROP = true; telePush('sse.connection-dropped · reconnecting…'); };
    TELE_ES.onmessage = m => {
      const e = JSON.parse(m.data); const p = e.payload || {};
      if (!TELE_ID || p.plan_id !== TELE_ID) return;
      telePush(e.kind + (p.line ? ' · ' + p.line : (p.note ? ' · ' + p.note : (p.receipt ? ' · receipt ' + String(p.receipt).slice(0, 18) + '…' : ''))));
    };
  }
}

// cubic-bézier sampler — MIRROR of src/utils/theatre-runtime.ts bezierSample
function bez(h, x) {
  const [x1, y1, x2, y2] = h;
  const cx = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const cy = u => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  const t = Math.min(1, Math.max(0, x));
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (cx(m) < t) lo = m; else hi = m; }
  return cy((lo + hi) / 2);
}
function sampleKfs(kfs, t) {
  if (!kfs.length) return 0;
  if (t <= kfs[0].position) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].position) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.position && t <= b.position) {
      if (typeof a.value === 'string' || typeof b.value === 'string') return a.value;
      const span = b.position - a.position;
      const x = span <= 0 ? 1 : (t - a.position) / span;
      return a.value + (b.value - a.value) * bez(a.interpolation.config.handles, x);
    }
  }
  return kfs[kfs.length - 1].value;
}
let STATE = null, RAF = 0, T0 = 0, LEN = 5;
async function loadState() {
  const note = document.getElementById('stateNote');
  const res = await fetch('/mission/theatre?folder=' + encodeURIComponent(document.getElementById('folder').value));
  const s = await res.json();
  if (!s.sheets) { note.textContent = 'no theatre state in that folder (save one via theatre-runtime)'; STATE = null; return; }
  STATE = s;
  const sheet = Object.values(s.sheets)[0];
  LEN = sheet.sequence.length;
  note.textContent = 'loaded definition ' + s.definitionVersion + ' · ' + Object.keys(s.sheets)[0] + ' · ' + Object.keys(sheet.sequence.tracks).length + ' tracks · ' + LEN + 's';
}
function apply(t) {
  const actor = document.getElementById('actor');
  let x = 0, y = 0, sc = 1;
  if (STATE) {
    const sheet = Object.values(STATE.sheets)[0];
    for (const [key, tr] of Object.entries(sheet.sequence.tracks)) {
      const v = sampleKfs(tr.keyframes, t);
      if (typeof v !== 'number') continue;
      if (key.endsWith('.position.x')) x = v;
      else if (key.endsWith('.y')) y = v;
      else if (key.endsWith('.scale')) sc = v;
    }
  }
  actor.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + sc + ')';
  document.getElementById('clock').textContent = 't=' + t.toFixed(3) + ' / ' + LEN.toFixed(3);
}
function play() { stop(); T0 = performance.now(); const tick = () => { apply(((performance.now() - T0) / 1000) % LEN); RAF = requestAnimationFrame(tick); }; RAF = requestAnimationFrame(tick); }
function stop() { cancelAnimationFrame(RAF); }
function playVid() {
  const v = document.getElementById('vid');
  v.src = document.getElementById('vsrc').value + '#t=' + document.getElementById('vin').value + ',' + document.getElementById('vout').value;
  v.play();
}
</script></body></html>`;

const DISPATCH_HTML = `
<div style="border-top:1px solid ${theme.surfaceRaised};padding:12px 16px">
  <h2>DISPATCH · COMMAND POST</h2>
  <div id="plans" style="display:flex;flex-direction:column;gap:6px"></div>
</div>
<script>
async function act(id, action) {
  let token;
  if (action === 'arm') { token = prompt('operator approval token (timmy approve <planHash>):'); if (!token) return; }
  const r = await fetch('/dispatch/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, token }) });
  const j = await r.json();
  alert(JSON.stringify(j).slice(0, 300));
  loadPlans();
}
async function loadPlans() {
  const r = await fetch('/dispatch');
  const plans = await r.json();
  document.getElementById('plans').innerHTML = plans.length ? plans.map(p =>
    '<div style="border:1px solid ${theme.surfaceRaised};border-radius:6px;padding:6px 10px;background:${theme.ground}">'
    + '<span style="color:${theme.accent}">' + p.id + '</span> '
    + '<span style="color:${theme.accent}">' + p.lifecycle + '</span> '
    + '<span style="color:${theme.textSecondary}">' + p.harness + ' · ' + p.objective + '</span> '
    + '<span style="color:${theme.textMuted}">hash ' + (p.plan_hash || '').slice(0, 12) + '…</span>'
    + (p.blocked ? ' <span style="color:${theme.danger}">' + p.blocked.state + ': ' + p.blocked.note + '</span>' : '')
    + ' <button onclick="act(\\'' + p.id + '\\',\\'arm\\')">arm</button>'
    + ' <button onclick="act(\\'' + p.id + '\\',\\'launch\\')">launch</button>'
    + ' <button onclick="act(\\'' + p.id + '\\',\\'hold\\')">hold</button>'
    + ' <button onclick="act(\\'' + p.id + '\\',\\'cancel\\')">cancel</button>'
    + ' <button onclick="act(\\'' + p.id + '\\',\\'collect\\')">collect</button>'
    + '</div>').join('') : '<div style="color:${theme.textMuted}">no plans — prepare one from chat (ctrl+d rail) or timmy_plan_dispatch</div>';
}
loadPlans(); setInterval(loadPlans, 3000);
</script>`;

// ---- Receipt browser: timeline over the chain, verify per receipt ----
const BROWSER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY Receipt Browser</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 16px; }
  header { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  header .logo { color: ${theme.accent}; font-weight: 700; letter-spacing: .08em; }
  button { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.accent}; border-radius: 6px; font: inherit; padding: 4px 10px; cursor: pointer; }
  input { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.textPrimary}; border-radius: 6px; font: inherit; padding: 4px 10px; }
  #chainstat { color: ${theme.seal}; }
  .epoch { color: ${theme.accent}; margin: 14px 0 6px; letter-spacing: .12em; }
  .rc { border: 1px solid ${theme.line}; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; background: ${theme.ground}; }
  .rc .row1 { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .rc .sub { color: ${theme.textPrimary}; font-weight: 600; }
  .rc .st-ok { color: ${theme.seal}; } .rc .st-failed { color: ${theme.danger}; } .rc .st-denied { color: ${theme.warn}; }
  .rc .hash { color: ${theme.seal}; } .rc .prev { color: ${theme.textMuted}; }
  .rc .meta { color: ${theme.textSecondary}; font-size: 11px; }
  .rc .vf { color: ${theme.accent}; font-size: 11px; }
</style></head><body>
<header>
  <span class="logo">TIMMY ● RECEIPT BROWSER</span>
  <input id="q" placeholder="filter subject/kind…" size="28" />
  <select id="stream"><option>runs</option><option>gens</option><option>harness</option></select>
  <button id="verify">verify chain</button>
  <span id="chainstat"></span>
</header>
<div id="list"></div>
<script>
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let CHAIN = [];
async function load() {
  const stream = document.getElementById('stream').value;
  CHAIN = await (await fetch('/receipts?stream=' + stream)).json();
  render();
  const v = await (await fetch('/verify?stream=' + stream)).json();
  document.getElementById('chainstat').textContent =
    (v.ok ? '✓ chain intact · ' : '× broken @ ' + (v.brokenAt ?? '?') + ' · ') + v.count + ' receipts · epoch ' + v.current_epoch;
}
function render() {
  const q = document.getElementById('q').value.toLowerCase();
  const list = document.getElementById('list');
  const rows = CHAIN.filter(r => !q || ((r.subject ?? '') + (r.kind ?? '')).toLowerCase().includes(q));
  let html = '', lastEpoch = null;
  for (const r of [...rows].reverse()) {
    const e = r.epoch ?? 1;
    if (e !== lastEpoch) { html += '<div class="epoch">EPOCH ' + e + '</div>'; lastEpoch = e; }
    html += '<div class="rc" id="rc-' + esc(r.id) + '"><div class="row1">'
      + '<span class="sub">' + esc(r.subject ?? r.kind) + '</span>'
      + '<span class="st-' + esc(r.status ?? 'ok') + '">' + esc(r.status ?? 'ok') + '</span>'
      + '<span class="meta">' + esc(r.ts ?? '').slice(11, 19) + ' · ' + esc(r.kind) + (r.cost_usd ? ' · $' + r.cost_usd : '') + (r.tokens ? ' · ' + r.tokens + 'tok' : '') + '</span>'
      + '<button onclick="vf(\\'' + esc(r.id) + '\\')">verify</button><span class="vf" id="vf-' + esc(r.id) + '"></span></div>'
      + '<div><span class="hash">hash ' + esc(String(r.hash ?? '').slice(0, 20)) + '…</span> <span class="prev">prev ' + esc(String(r.prev_hash ?? '').slice(0, 20)) + '…</span></div>'
      + (r.error_class ? '<div class="meta">error_class: ' + esc(r.error_class) + '</div>' : '')
      + '</div>';
  }
  list.innerHTML = html || '<div class="meta">no receipts match</div>';
}
async function vf(id) {
  const stream = document.getElementById('stream').value;
  const v = await (await fetch('/verify-receipt?stream=' + stream + '&id=' + id)).json();
  document.getElementById('vf-' + id).textContent = v.ok ? '✓ body+sig' : '× ' + (v.bodyOk ? 'sig' : 'body');
}
document.getElementById('q').oninput = render;
document.getElementById('stream').onchange = load;
document.getElementById('verify').onclick = load;
load(); setInterval(load, 5000);
</script></body></html>`;

interface SseClient { res: ServerResponse }
let clients: SseClient[] = [];
let tailOffset = 0;

function broadcast(ev: TimmyEvent) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.res.write(data);
}

function tailLoop() {
  setInterval(() => {
    const p = eventsPath();
    if (!existsSync(p)) return;
    const size = statSync(p).size;
    if (size < tailOffset) tailOffset = 0; // truncated — restart
    if (size === tailOffset) return;
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(size - tailOffset);
    readSync(fd, buf, 0, buf.length, tailOffset);
    closeSync(fd);
    tailOffset = size;
    for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
      try { broadcast(JSON.parse(line) as TimmyEvent); } catch { /* partial line */ }
    }
  }, 700);
}

// WALNUT /chat mirror (work order p12 OPTIONAL): left column streams the
// TUI conversation through Vercel streamdown; right column is the receipt
// rain fed by SSE. READ-ONLY (§1): tails .sessions + the chain, writes nothing.
function latestSessionPath(): string | null {
  try {
    const files = readdirSync('.sessions').filter(f => f.endsWith('.jsonl')).map(f => join('.sessions', f));
    if (!files.length) return null;
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}
function readSessionTail(n: number): { role: string; content: string }[] {
  const p = latestSessionPath();
  if (!p) return [];
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n)
      .map(l => JSON.parse(l) as { role: string; content: string });
  } catch { return []; }
}
function sessionSize(): number {
  const p = latestSessionPath();
  try { return p ? statSync(p).size : 0; } catch { return 0; }
}

export function startLogServer(opts: { port?: number; open?: boolean } = {}): Promise<number> {
  const port = opts.port ?? LOGS_PORT();
  let pairSealed = false; // one companion.pair receipt per server process
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, cwd: process.cwd(), port }));
      return;
    }
    if (url.pathname === '/chat') {
      const page = new URL('./chatpage.html', import.meta.url);
      res.setHeader('Content-Type', 'text/html');
      res.end(readFileSync(page));
      return;
    }
    if (url.pathname === '/chat/events') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(': connected\n\n');
      const send = (o: Record<string, unknown>): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
      const pushTurns = (): void => { send({ t: 'turns', turns: readSessionTail(20) }); };
      pushTurns();
      let chainLen = readChain('runs').length;
      for (const r of readChain('runs').slice(-8)) send({ t: 'receipt', hash: String(r.hash).slice(7, 15) + '…', subject: r.subject, kind: r.kind, ts: String(r.ts).slice(11, 19) });
      let sesSize = sessionSize();
      const iv = setInterval(() => {
        const ns = sessionSize();
        if (ns !== sesSize) { sesSize = ns; pushTurns(); }
        const cl = readChain('runs').length;
        if (cl !== chainLen) {
          for (const r of readChain('runs').slice(chainLen)) send({ t: 'receipt', hash: String(r.hash).slice(7, 15) + '…', subject: r.subject, kind: r.kind, ts: String(r.ts).slice(11, 19) });
          chainLen = cl;
        }
      }, 700);
      res.on('close', () => clearInterval(iv));
      return;
    }
    if (url.pathname === '/events') {
      // SPEC §00 journey step 6: the first live companion client to attach is
      // the pair event — sealed once per server process, read by the HOME ladder.
      if (!pairSealed) {
        pairSealed = true;
        try {
          appendReceipt('runs', { kind: 'run', subject: `companion.pair · log companion SSE client · port ${port}`, policy: 'auto', status: 'ok' });
        } catch { /* best-effort */ }
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(': connected\n\n');
      for (const ev of readEvents(50)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const client = { res };
      clients.push(client);
      res.on('close', () => { clients = clients.filter(c => c !== client); });
      return;
    }
    if (url.pathname === '/receipts') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readChain(stream)));
      return;
    }
    if (url.pathname === '/verify') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(verifyChain(stream)));
      return;
    }
    // Receipt browser backend: per-receipt body-hash + signature check.
    if (url.pathname === '/verify-receipt') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      const id = url.searchParams.get('id') ?? '';
      const rec = readChain(stream).find(r => r.id === id);
      res.setHeader('Content-Type', 'application/json');
      if (!rec) { res.end(JSON.stringify({ ok: false, note: 'unknown receipt' })); return; }
      const { hash, ...rest } = rec;
      const bodyOk = hashOf({ ...rest, hash: '' }) === hash;
      const sigOk = verifySignature(rec);
      res.end(JSON.stringify({ ok: bodyOk && sigOk, bodyOk, sigOk }));
      return;
    }
    if (url.pathname === '/browser') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(BROWSER_HTML);
      return;
    }
    // Command Post survey surface: same controller, same allowlist. Browser
    // state is never sufficient — every mutation goes through the controller.
    if (url.pathname === '/dispatch') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(listPlans()));
      return;
    }
    if (url.pathname === '/dispatch/action' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', async () => {
        const { id, action, token } = body;
        let r: unknown = { ok: false, error: 'unknown action' };
        if (action === 'arm' && token) r = armPlan(String(id), String(token));
        else if (action === 'launch') {
          // openhands+docker plans run through the containerized engine with
          // live telemetry; every other harness keeps the tmux lane runner
          const st = getPlan(String(id));
          r = st && st.plan.harnesses[0] === 'openhands' && st.plan.workspace.kind === 'docker'
            ? await dispatchContainerized(String(id))
            : dispatchPlan(String(id));
        }
        else if (action === 'hold') r = pauseOrCancelLane(String(id), 'hold');
        else if (action === 'cancel') r = pauseOrCancelLane(String(id), 'cancel');
        else if (action === 'collect') r = collectRun(String(id));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r));
      });
      return;
    }
    // Mission Studio: survey surface for the compiler + playback. Compiles
    // only — every mutation still goes through the controller.
    if (url.pathname === '/mission') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(MISSION_HTML);
      return;
    }
    if (url.pathname === '/mission/compile' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, errors: ['localhost only'], plans: [] }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(compileMissionMap((body?.doc ?? { nodes: [], edges: [] }) as MissionMapDoc, typeof body?.repo_root === 'string' ? { repoRoot: body.repo_root } : {})));
      });
      return;
    }
    // Arming gateway entry: store a compiled plan in the controller and
    // return its id + immutable hash. Arm/launch still require the operator
    // token via /dispatch/action — the companion never executes.
    if (url.pathname === '/mission/store' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, note: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(createPlan((body?.plan ?? {}) as DispatchPlan)));
      });
      return;
    }
    // v0.7.9 inspectors: Merkle proof tree + USD stage hierarchy. Read-only
    // display aids; localhost-gated like the rest of the gateway.
    if (url.pathname === '/mission/inspect' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, note: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (body?.kind === 'merkle' && body.pass?.leaves) {
          const tree = merkleProofTree((body.pass.leaves as { hash: string }[]).map(l => l.hash));
          res.end(JSON.stringify({ ok: true, ...tree, matches: tree.root === body.pass.merkle_root }));
        } else if (body?.kind === 'stage' && body.scene) {
          const c = composeUnifiedStage(body.scene, body.hero ? { hero: body.hero } : undefined);
          res.end(JSON.stringify({ ok: c.ok, sha256: c.sha256, note: c.note, hierarchy: c.ok ? stageHierarchy(body.scene, body.hero) : undefined, usda: c.usda }));
        } else {
          res.end(JSON.stringify({ ok: false, note: 'kind must be merkle|stage' }));
        }
      });
      return;
    }
    // v0.9.0 escrow ledger: live balance locks / refunds / slashes
    if (url.pathname === '/mission/escrows' && req.method === 'GET') {
      // store-resolved (same path the engine writes), not a hardcoded cwd scan
      const rows: unknown[] = listEscrows()
        .sort((a, b) => String(a.escrow_id).localeCompare(String(b.escrow_id)))
        .map(e => ({
          escrow_id: e.escrow_id, state: e.state, ceiling_usd: e.ceiling_usd, drawn_usd: e.drawn_usd,
          refund_usd: e.refund_usd ?? null, qa_threshold: e.qa_threshold, qa_value: e.qa_value ?? null,
          merkle_root: e.merkle_root ? String(e.merkle_root).slice(0, 16) + '…' : null
        }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, escrows: rows }));
      return;
    }
    if (url.pathname === '/mission/theatre') {
      const folder = String(url.searchParams.get('folder') ?? '');
      const root = process.cwd();
      const abs = resolve(root, folder);
      res.setHeader('Content-Type', 'application/json');
      if (!folder || !abs.startsWith(resolve(root) + '/') || !existsSync(join(abs, 'theatre-state.json'))) {
        res.end(JSON.stringify({ ok: false, error: 'no theatre state in that folder' }));
        return;
      }
      res.end(readFileSync(join(abs, 'theatre-state.json'), 'utf8'));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE + DISPATCH_HTML);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      tailOffset = existsSync(eventsPath()) ? statSync(eventsPath()).size : 0;
      tailLoop();
      if (opts.open) openBrowser(`http://localhost:${port}`);
      resolve(port);
    });
  });
}

export function openBrowser(url: string): void {
  if (process.env.TIMMY_LOGS_OPEN === '0') return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Idempotent: if the companion is already up, reuse it; else spawn detached so
// it outlives short-lived MCP client processes. First starter auto-pops the
// browser (TIMMY_LOGS_OPEN=0 opts out).
export async function ensureLogCompanion(): Promise<{ url: string; started: boolean }> {
  const port = LOGS_PORT();
  const url = `http://localhost:${port}`;
  const alive = async () => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      return r.ok;
    } catch { return false; }
  };
  if (await alive()) return { url, started: false };
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [join(process.cwd(), 'src', 'utils', 'logserver.ts')], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await alive()) {
      openBrowser(url);
      return { url, started: true };
    }
  }
  return { url, started: false };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const open = process.argv.includes('--open') || process.env.TIMMY_LOGS_OPEN === '1';
  startLogServer({ open }).then(port => {
    console.log(`timmy logs companion · http://localhost:${port} · ctrl-c to stop`);
  }).catch(e => {
    console.error(`companion failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
