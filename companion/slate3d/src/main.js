// Slate 3D — a tldraw mission board as a scene. Frames are slabs, capsules are
// capsules, harness nodes are lane pods lit from the event bus. The viewer
// spawns nothing; it reads the board and the bus and draws.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { layoutBoard, layoutSheets, sheetsSpan, SLAB, SHEET } from './board.js';
import { connectBus, laneOf, classOf } from './bus.js';
import { capsuleState, frameStatus } from './state.js';

const T = {
  navy: 0x0a1628, raised: 0x12233d, slab: 0x0f1e36, line: 0x1c3358, grid: 0x11223c,
  phosphor: 0x33ff66, orange: 0xff8c1a, red: 0xff3b3b, text: 0xe6edf3, muted: 0x6b7a90,
};
const CLASS_COLOR = { chain: T.phosphor, human: T.orange, refusal: T.red, other: T.phosphor, slate: T.phosphor };
const DECAY_MS = 20 * 60 * 1000;
const FLOOR_GLOW = 0.12;

const q = new URLSearchParams(location.search);
const BOARD = q.get('board') ?? 'ledger';
const STILL = q.get('still') === '1';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || STILL;

// ---------- renderer, scene, camera ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(T.navy);
scene.fog = new THREE.Fog(T.navy, 60, 160);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = !reduced;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 8;
controls.maxDistance = 220;

const labels = new CSS2DRenderer({ element: document.getElementById('labels') });
labels.setSize(innerWidth, innerHeight);

const hemi = new THREE.HemisphereLight(0x2a4a7a, 0x05080f, 0.9);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
key.position.set(-30, 50, 35);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
scene.add(key);
scene.add(new THREE.AmbientLight(0x0a1628, 1.2));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 1.05);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- materials ----------
const matSlab = new THREE.MeshStandardMaterial({ color: T.slab, roughness: 0.92, metalness: 0.0 });
const matFloor = new THREE.MeshStandardMaterial({ color: T.navy, roughness: 1.0, metalness: 0.0 });
const matCard = new THREE.MeshStandardMaterial({ color: T.raised, roughness: 0.8, metalness: 0.0 });
const matTrace = new THREE.LineBasicMaterial({ color: T.phosphor, transparent: true, opacity: 0.35 });
const matEdgeQuiet = new THREE.LineBasicMaterial({ color: T.line });
const mkEdge = (color) => new THREE.LineBasicMaterial({ color });

const label = (html, cls) => {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = html;
  return new CSS2DObject(el);
};

// ---------- state ----------
const podsByLane = new Map(); // lane id → [pod]
const allPods = [];
const capsuleMeshes = []; // clickable: opens the capsule panel (emits controller calls, never spawns)
const boardPulse = { until: 0 };
const ticker = document.getElementById('ticker');
const busEl = document.getElementById('bus');
const busText = document.getElementById('bus-text');
let lanes = new Set();

function addPod(x, y, z, laneId, text, cls) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.62, 1.0, 6),
    new THREE.MeshStandardMaterial({ color: T.raised, roughness: 0.7, metalness: 0.1, emissive: T.phosphor, emissiveIntensity: FLOOR_GLOW })
  );
  core.position.y = 0.5;
  core.castShadow = true;
  g.add(core);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.82, 0.045, 10, 48),
    new THREE.MeshStandardMaterial({ color: T.line, roughness: 0.6, emissive: T.phosphor, emissiveIntensity: 0.0 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);
  const lbl = label(text, cls);
  lbl.position.set(0, 1.45, 0);
  g.add(lbl);
  scene.add(g);
  const pod = { lane: laneId, group: g, core, ring, lbl, lastTs: 0, cls: 'quiet', kind: '' };
  allPods.push(pod);
  if (!podsByLane.has(laneId)) podsByLane.set(laneId, []);
  podsByLane.get(laneId).push(pod);
  return pod;
}

function hit(pod, ev, cls) {
  const ts = Date.parse(ev.ts) || Date.now();
  if (ts < pod.lastTs) return;
  pod.lastTs = ts;
  pod.cls = cls;
  pod.kind = ev.kind === 'receipt.sealed' ? `${ev.kind} · ${ev.payload?.subject ?? ''}` : ev.kind;
  const color = cls === 'failed' ? T.line : (CLASS_COLOR[cls] ?? T.phosphor);
  pod.core.material.emissive.setHex(color);
  pod.ring.material.emissive.setHex(color);
}

function fmtAge(ms) {
  if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1e3))}s ago`;
  if (ms < 3600e3) return `${Math.round(ms / 60e3)}m ago`;
  if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h ago`;
  return `${Math.round(ms / 86400e3)}d ago`;
}

function tickPods(now) {
  for (const p of allPods) {
    if (!p.lastTs) continue;
    const age = now - p.lastTs;
    const lit = p.cls === 'failed' ? 0 : Math.exp(-age / DECAY_MS);
    p.core.material.emissiveIntensity = FLOOR_GLOW + lit * 2.6;
    p.ring.material.emissiveIntensity = lit * 1.8;
    const el = p.lbl.element;
    el.classList.toggle('lit', p.cls === 'chain' || p.cls === 'other');
    el.classList.toggle('human', p.cls === 'human');
    el.classList.toggle('refusal', p.cls === 'refusal');
    if (!el.dataset.base) el.dataset.base = el.innerHTML;
    el.innerHTML = `${el.dataset.base}<span class="age">${p.cls === 'failed' ? 'failed · ' : ''}${fmtAge(age)}</span>`;
  }
}

function pushTicker(ev, cls, lane) {
  const li = document.createElement('li');
  li.className = cls;
  const t = new Date(ev.ts || Date.now());
  const hh = t.toTimeString().slice(0, 8);
  const what = ev.kind === 'receipt.sealed' ? `${ev.kind} · ${ev.payload?.subject ?? ''}` : ev.kind;
  li.innerHTML = `<time>${hh}</time><span>${what}${lane ? ` · ${lane}` : ''}</span>`;
  ticker.appendChild(li);
  while (ticker.children.length > 7) ticker.removeChild(ticker.firstChild);
}

// ---------- build the scene from the board ----------
async function build() {
  const [board, laneList, receiptsRes] = await Promise.all([
    fetch(`./boards/${BOARD}.mission.json`).then((r) => r.json()),
    fetch('./lanes.json').then((r) => r.json()).catch(() => []),
    fetch('./receipts?limit=2000').then((r) => r.json()).catch(() => ({ receipts: [] })),
  ]);
  // blueprint boards the mission cites render as sheets beside the slabs
  // a cited board is <name>.blueprint.json or, for evidence boards written by
  // lanes, <name>.board.json
  const loadBoard = async (n) => {
    for (const f of [`${n}.blueprint.json`, `${n}.board.json`]) {
      try { const r = await fetch(`./boards/${f}`); if (r.ok) return await r.json(); } catch { /* next */ }
    }
    return null;
  };
  const blueprints = (await Promise.all((board.blueprints ?? []).map(loadBoard))).filter(Boolean);

  // State from receipts, computed by the shared rules in state.js: the same
  // module the state-table lane runs for the dossier, so the scene and the
  // table can never disagree.
  const receipts = receiptsRes.receipts ?? [];
  for (const f of board.frames) { const st = frameStatus(f, receipts); f.status = st.status; f.state = st; }
  const WORKER = (q.get('worker') ?? board.worker ?? 'https://<hostname>').replace(/\/$/, '');
  const ROOM = q.get('room') ?? board.room ?? null;
  const head = await fetch(`${WORKER}/head`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const edge = new Map((head?.heads ?? []).map((h) => [h.subject, h]));
  for (const n of board.nodes) if (n.kind === 'capsule') n.state = capsuleState(n, receipts, edge);

  document.getElementById('board-name').textContent = `${board.name} · kind ${board.kind} · ${board.frames.length} frames · ${board.nodes.length} nodes · ${blueprints.length} blueprint${blueprints.length === 1 ? '' : 's'} · state from ${receipts.length} receipts`;
  document.title = `Slate 3D · ${board.name}`;
  lanes = new Set(laneList.map((l) => l.id));
  const L = layoutBoard(board, laneList);
  const sheets = layoutSheets(blueprints, L.totalW);
  const spanW = Math.max(L.totalW, sheetsSpan(sheets));

  // floor + grid
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(L.center.x, -0.01, L.center.z);
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(600, 75, T.grid, T.grid);
  grid.position.set(L.center.x, 0, L.center.z);
  scene.add(grid);

  // slabs
  const STATUS_COLOR = { done: T.phosphor, active: T.orange, blocked: T.line, next: T.line };
  const slabEdges = [];
  for (const f of L.frames) {
    const slab = new THREE.Mesh(new RoundedBoxGeometry(SLAB.w, SLAB.h, SLAB.d, 2, 0.12), matSlab);
    slab.position.set(f.cx, SLAB.h / 2, f.cz);
    slab.receiveShadow = true;
    slab.castShadow = true;
    scene.add(slab);
    const edgeColor = STATUS_COLOR[f.status] ?? T.line;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(SLAB.w, SLAB.h, SLAB.d)), f.status ? mkEdge(edgeColor) : matEdgeQuiet);
    edges.position.copy(slab.position);
    scene.add(edges);
    slabEdges.push({ edges, base: edgeColor });
    const st = f.state ?? { total: 0 };
    const orders = st.total ? `<span class="orders ${f.status}">${st.sealed}/${st.total} orders sealed${st.attested ? ' · attested' : ''}${f.status === 'blocked' ? ' · blocked' : ''}</span> · ` : '';
    const l = label(`${f.title}<small>${orders}${f.status ?? ''}${f.paths ? ` · ${f.paths.join(' ')}` : ''}</small>`, 'frame');
    l.element.title = st.why ?? '';
    l.position.set(f.cx, 0.1, f.cz + SLAB.d / 2 + 1.3);
    scene.add(l);
  }

  // nodes
  for (const n of L.nodes) {
    if (n.kind === 'capsule') {
      // the capsule's own state comes from its evidence rules, not the frame
      const cs = n.state ?? { status: 'next', held: 0, total: 0 };
      const done = cs.status === 'done';
      const active = cs.status === 'active';
      const m = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.42, 1.5, 6, 14),
        new THREE.MeshStandardMaterial({ color: done ? 0x163a2a : active ? 0x3a2a14 : T.raised, roughness: 0.55, metalness: 0.05, emissive: done ? T.phosphor : active ? T.orange : 0x000000, emissiveIntensity: done ? 0.55 : active ? 0.35 : 0 })
      );
      m.rotation.z = Math.PI / 2;
      m.position.set(n.x, n.y + 0.5, n.z);
      m.castShadow = true;
      scene.add(m);
      capsuleMeshes.push({ mesh: m, node: n });
      const ev = cs.total ? ` · <span class="orders ${cs.status}">evidence ${cs.held}/${cs.total}${cs.status === 'blocked' ? ' · blocked' : ''}</span>` : '';
      const l = label(`<b>${n.id}</b>${ev}<br>${(n.objective ?? '').slice(0, 42)}${(n.objective ?? '').length > 42 ? '…' : ''}`, 'node');
      l.element.title = `${n.objective ?? ''}\n${cs.checks.map((c) => `${c.held === true ? '✓' : c.rule ? '✗' : '–'} ${c.line}`).join('\n')}`;
      l.position.set(n.x, n.y + 1.35, n.z);
      scene.add(l);
    } else if (n.kind === 'harness') {
      addPod(n.x, n.y, n.z, n.harness, `<b>${n.harness}</b>`, 'lane');
    } else if (n.kind === 'gate') {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.08, 12, 40),
        new THREE.MeshStandardMaterial({ color: 0x3a2a14, roughness: 0.5, emissive: T.orange, emissiveIntensity: 0.5 })
      );
      ring.position.set(n.x, n.y + 0.75, n.z);
      ring.castShadow = true;
      scene.add(ring);
      const l = label(`gate · ${n.approval ?? 'manual'}`, 'node');
      l.position.set(n.x, n.y + 1.6, n.z);
      scene.add(l);
    } else if (n.kind === 'artifact') {
      const card = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.08, 1.1, 2, 0.04), matCard);
      card.position.set(n.x, n.y + 0.42, n.z);
      card.rotation.z = -0.35;
      card.castShadow = true;
      scene.add(card);
      const l = label(`artifact · ${n.path ?? ''}`, 'node');
      l.position.set(n.x, n.y + 1.1, n.z);
      scene.add(l);
    } else {
      const chip = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.12, 0.6, 2, 0.05), matCard);
      chip.position.set(n.x, n.y + 0.1, n.z);
      scene.add(chip);
      const l = label(`${n.kind} · ${n.id}`, 'node');
      l.position.set(n.x, n.y + 0.6, n.z);
      scene.add(l);
    }
  }

  // traces on the slab + dependency arcs between capsules
  const tracePts = [];
  for (const e of L.edges) {
    if (e.kind === 'depends') {
      const a = new THREE.Vector3(e.a.x, e.a.y + 0.6, e.a.z);
      const b = new THREE.Vector3(e.b.x, e.b.y + 0.6, e.b.z);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += Math.min(9, a.distanceTo(b) * 0.35);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, 0.045, 8, false),
        new THREE.MeshStandardMaterial({ color: 0x163a2a, roughness: 0.6, emissive: T.phosphor, emissiveIntensity: 0.45 })
      );
      scene.add(tube);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 10), new THREE.MeshStandardMaterial({ color: T.phosphor, emissive: T.phosphor, emissiveIntensity: 0.8 }));
      tip.position.copy(b);
      const dir = curve.getTangent(1).normalize();
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      scene.add(tip);
    } else {
      tracePts.push(new THREE.Vector3(e.a.x, e.a.y + 0.02, e.a.z), new THREE.Vector3(e.b.x, e.b.y + 0.02, e.b.z));
    }
  }
  if (tracePts.length) scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tracePts), matTrace));

  // the lane rail: every known lane, so any bus event has a pod to light
  for (const l of L.rail) addPod(l.x, l.y, l.z, l.id, `<b>${l.id}</b>`, 'lane');
  const railLabel = label('lane rail · every LANE_RUNNERS id and fleet entry', 'node');
  railLabel.position.set(L.center.x, 0.2, L.rail[0]?.z - 2.4);
  scene.add(railLabel);

  // blueprint sheets: flat reference cards standing beside the slabs
  for (const s of sheets) {
    const card = new THREE.Mesh(new RoundedBoxGeometry(SHEET.w, SHEET.h, 0.08, 2, 0.06), new THREE.MeshStandardMaterial({ color: T.raised, roughness: 0.85, metalness: 0 }));
    card.position.set(s.x, s.y + 0.4, s.z);
    card.rotation.y = -0.3;
    card.castShadow = true;
    scene.add(card);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(SHEET.w, SHEET.h, 0.08)), mkEdge(T.phosphor));
    edges.position.copy(card.position);
    edges.rotation.copy(card.rotation);
    scene.add(edges);
    // the front row carries full sheets; rows behind show a compact head so
    // their screen labels do not bury the row in front
    const compact = s.row > 0;
    const rows = (s.rows ?? []).slice(0, compact ? 2 : 8).map((r) => `<dt>${r.label}</dt><dd>${/^#[0-9a-f]{6}$/i.test(String(r.value)) ? `<i style="background:${r.value}"></i>` : ''}${r.value}${!compact && r.note ? ` <span>· ${r.note}</span>` : ''}</dd>`).join('') + (compact && (s.rows ?? []).length > 2 ? `<dt></dt><dd><span>+${(s.rows ?? []).length - 2} more</span></dd>` : '');
    const l = label(`<h4>${s.title}<small>${s.kind ?? 'blueprint'} · ${s.board}${s.source ? ` · ${s.source}` : ''}${s.more ? ` · +${s.more} more in the board file` : ''}</small></h4><dl>${rows}</dl>`, 'sheet');
    l.position.set(s.x, s.y + 0.4, s.z + 0.3);
    scene.add(l);
  }

  // frame the whole floor, sheets included
  const target = new THREE.Vector3(spanW / 2, 0.2, L.center.z + 0.5);
  const fit = (spanW / 2) / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) * 1.08;
  const dir = new THREE.Vector3(0.3, 0.46, 0.84).normalize();
  camera.position.copy(target).add(dir.multiplyScalar(Math.max(fit, 30)));
  controls.target.copy(target);
  controls.update();

  // Capsule panel: click a capsule to read its acceptance lines with their
  // evidence, and to emit controller calls. Compile is a dry run through the
  // controller's gateway; store returns a plan id and its hash. Nothing here
  // arms or launches: that stays behind the operator token in the controller.
  const panel = document.getElementById('capsule-panel');
  const cpOut = document.getElementById('cp-out');
  let openCapsule = null;
  const frameDoc = (n) => {
    const ids = new Set(board.nodes.filter((x) => x.frame === n.frame).map((x) => x.id));
    return { nodes: board.nodes.filter((x) => ids.has(x.id)).map(({ acceptance_evidence, state, blocked_by, ...rest }) => rest), edges: board.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  };
  const emit = async (action, extra = {}) => {
    cpOut.hidden = false;
    cpOut.textContent = `${action} → controller…`;
    try {
      const r = await fetch('./emit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, capsule: openCapsule?.id, ...extra }) });
      const j = await r.json();
      cpOut.textContent = JSON.stringify(j, null, 1).slice(0, 3000);
      return j;
    } catch (e) { cpOut.textContent = `emit failed: ${e}`; return null; }
  };
  const openPanel = (n) => {
    openCapsule = n;
    const cs = n.state ?? { status: 'next', checks: [], held: 0, total: 0 };
    document.getElementById('cp-id').textContent = n.id;
    const st = document.getElementById('cp-state');
    st.textContent = `${cs.status} · evidence ${cs.held}/${cs.total}${cs.unreceipted ? ` · ${cs.unreceipted} not receipted` : ''}`;
    st.className = `state ${cs.status}`;
    document.getElementById('cp-objective').textContent = n.objective ?? '';
    const ol = document.getElementById('cp-lines');
    ol.innerHTML = cs.checks.map((c) => `<li class="${c.held === true ? 'held' : c.rule ? 'missed' : 'none'}"><i>${c.held === true ? '✓' : c.rule ? '✗' : '–'}</i><span>${c.line}<small>${c.why ?? 'no receipt maps to this line yet'}</small></span></li>`).join('');
    cpOut.hidden = true;
    panel.hidden = false;
  };
  document.getElementById('cp-close').onclick = () => { panel.hidden = true; openCapsule = null; };
  document.getElementById('cp-compile').onclick = () => { if (openCapsule) emit('compile', { doc: frameDoc(openCapsule) }); };
  document.getElementById('cp-store').onclick = async () => {
    if (!openCapsule) return;
    const c = await emit('compile', { doc: frameDoc(openCapsule) });
    const plan = c?.plans?.find((p) => p.node_id === openCapsule.id)?.plan ?? c?.plans?.[0]?.plan;
    if (!plan) { cpOut.textContent += '\n\nno plan compiled for this capsule; nothing sent'; return; }
    await emit('store', { plan });
  };
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hitObj = ray.intersectObjects(capsuleMeshes.map((c) => c.mesh))[0];
    if (hitObj) openPanel(capsuleMeshes.find((c) => c.mesh === hitObj.object).node);
  });
  if (q.get('open')) { const n = board.nodes.find((x) => x.id === q.get('open')); if (n) openPanel(n); }

  // the bus
  // the room is the default source when the board names one and a worker is
  // configured; the companion socket stays available with ?source=ws
  const source = q.get('source') ?? (q.get('sse') ? 'sse' : (ROOM && WORKER) ? 'room' : 'ws');
  document.getElementById('bus-source').textContent = source === 'ws' ? 'source · companion websocket' : source === 'sse' ? `source · ${q.get('sse')}` : `source · room ${ROOM} @ ${WORKER.replace(/^https?:\/\//, '')}`;
  connectBus({ source, sse: q.get('sse'), room: ROOM, worker: WORKER, poll: q.get('poll') === '1' }, (ev, meta) => {
    const cls = classOf(ev);
    const lane = laneOf(ev, lanes);
    if (lane) for (const p of podsByLane.get(lane) ?? []) hit(p, ev, cls);
    if (cls === 'slate') boardPulse.until = Date.now() + 4000;
    if (!meta.tail || lane || cls === 'slate' || cls === 'human' || cls === 'refusal') pushTicker(ev, cls, lane);
  }, (s) => {
    busEl.classList.toggle('live', s.live);
    busText.textContent = s.text;
  });

  // idle drift only when motion is welcome
  let t0 = performance.now();
  const loop = (now) => {
    requestAnimationFrame(loop);
    if (!reduced) {
      const t = (now - t0) / 1000;
      controls.autoRotate = false;
      camera.position.y += Math.sin(t * 0.25) * 0.002;
    }
    controls.update();
    tickPods(Date.now());
    const pulse = boardPulse.until > Date.now() ? 0.5 + 0.5 * Math.sin(now / 120) : 0;
    for (const s of slabEdges) s.edges.material.color.setHex(pulse > 0 ? T.phosphor : s.base);
    composer.render();
    labels.render(scene, camera);
  };
  requestAnimationFrame(loop);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});

build().catch((e) => {
  document.getElementById('board-name').textContent = `board failed to load: ${e}`;
});
