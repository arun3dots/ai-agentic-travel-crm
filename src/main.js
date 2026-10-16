// The office floor — a Three.js isometric view of the holiday desk.
//
// Seven pods, in the order work moves: CALL DESK → RECORDING VAULT → TRANSCRIPTION → TRIP DESIGN →
// APPROVAL GATE → DESPATCH, with the DIRECTORY in the middle holding the records every desk reads.
// Each agent is a person at a desk; clicking them opens the desk they own. The numbers on the pods
// are the office's real numbers, polled from /api.
import * as THREE from 'three';
import { DEPTS, DEPT_KEYS, AGENTS, LAYOUT, FLOW, POD_LEAD } from './data.js';
import {
  makePlinth, makeDesk, makeChair, makePerson, poseWork, posePerson,
  makePlant, makeServerRack, makeMeetingTable, makeWalkway, makeWarnSprite,
} from './builders.js';
import { api, h } from './api.js';
import { initDesks } from './desks.js';
import { initSoftphone } from './softphone.js';

/* ---------- renderer / scene / camera ---------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
const FR = 42;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);
const ISO = new THREE.Vector3(1, 0.92, 1).normalize();
const CAM_DIST = 220;
const OVERVIEW = { pos: [-9, 0, -9], zoom: 0.8 };

/** The world centre of the pods, so a phone can be shown the whole office. */
const OFFICE_CENTRE = (() => {
  const xs = Object.values(LAYOUT).map(L => L.pos[0]);
  const zs = Object.values(LAYOUT).map(L => L.pos[1]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
})();

const view = { target: new THREE.Vector3(...OVERVIEW.pos), zoom: OVERVIEW.zoom, arc: 0 };
let tween = null;
const UPV = new THREE.Vector3(0, 1, 0);
const isoWork = new THREE.Vector3();
const RIGHT = new THREE.Vector3(1, 0, -1).normalize();
const UPSCREEN = new THREE.Vector3(1, 0, 1).normalize();

function applyCamera() {
  const aspect = innerWidth / innerHeight;
  camera.left = -FR * aspect; camera.right = FR * aspect;
  camera.top = FR; camera.bottom = -FR;
  camera.zoom = view.zoom;
  isoWork.copy(ISO);
  if (view.arc) isoWork.applyAxisAngle(UPV, view.arc);
  camera.position.copy(view.target).addScaledVector(isoWork, CAM_DIST);
  camera.lookAt(view.target);
  camera.updateProjectionMatrix();
}

// the house easing
function bezier(t) {
  const cx = 3 * 0.2, bx = -cx, ax = 1 - cx - bx;
  const cy = 3 * 0.8, by = 3 * 0.2 - cy, ay = 1 - cy - by;
  let u = t;
  for (let i = 0; i < 5; i++) {
    const x = ((ax * u + bx) * u + cx) * u - t;
    const dx = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(dx) < 1e-6) break;
    u -= x / dx;
  }
  return ((ay * u + by) * u + cy) * u;
}

/**
 * The overview a given viewport can actually show.
 *
 * On a wide screen this is the tuned composition the office was designed around. On a phone the
 * office is wider than the screen, so the camera pulls back and centres on the floor instead —
 * every pod card stays on screen and tappable, which is the only way to navigate from a phone.
 */
function fitOverview() {
  const wide = innerWidth / innerHeight >= 1.05 && innerWidth > 900;
  if (wide) return { pos: OVERVIEW.pos.slice(), zoom: OVERVIEW.zoom };

  const pad = 14, topPad = innerWidth <= 900 ? 104 : 58;
  const corners = [];
  for (const L of Object.values(LAYOUT)) {
    for (const dx of [-L.w / 2 - 2, L.w / 2 + 2]) {
      for (const dz of [-L.d / 2 - 8, L.d / 2 + 8]) corners.push([L.pos[0] + dx, 0, L.pos[1] + dz]);
    }
  }
  const centre = [OFFICE_CENTRE.x, 0, OFFICE_CENTRE.z];

  const savedT = view.target.clone(), savedZ = view.zoom;
  view.target.set(centre[0], 0, centre[2]);
  const fitsAt = zoom => {
    view.zoom = zoom;
    applyCamera();
    return corners.every(p => {
      const s = toScreen(new THREE.Vector3(...p));
      return s.x >= pad && s.x <= innerWidth - pad && s.y >= topPad && s.y <= innerHeight - pad;
    });
  };
  let lo = 0.22, hi = 1.2;
  if (fitsAt(lo)) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid; else hi = mid;
    }
  }
  view.target.copy(savedT); view.zoom = savedZ;
  applyCamera();
  return { pos: centre, zoom: Math.max(0.2, Math.min(1.2, lo)) };
}

const overview = () => fitOverview();

function flyTo(targetPos, zoom, dur = 800, opts = {}) {
  tween = {
    t0: performance.now(), dur,
    fromT: view.target.clone(), toT: new THREE.Vector3(...targetPos),
    fromZ: view.zoom, toZ: zoom, arc: opts.arc || 0, onDone: opts.onDone,
  };
}

function tickTween(now) {
  if (!tween) return;
  const k = Math.min(1, (now - tween.t0) / tween.dur);
  const e = bezier(k);
  view.target.lerpVectors(tween.fromT, tween.toT, e);
  view.zoom = tween.fromZ + (tween.toZ - tween.fromZ) * e;
  view.arc = Math.sin(e * Math.PI) * tween.arc;
  if (k >= 1) {
    const cb = tween.onDone;
    view.arc = 0; tween = null;
    if (cb) cb();
  }
}

/* ---------- lights: 3dots studio daylight ---------- */
scene.add(new THREE.HemisphereLight(0xF4F6FB, 0xCBD5E1, 0.95));
const key = new THREE.DirectionalLight(0xFFFFFF, 2.3);
key.position.set(-60, 90, 20);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -110; key.shadow.camera.right = 110;
key.shadow.camera.top = 110; key.shadow.camera.bottom = -110;
key.shadow.camera.far = 400;
key.shadow.radius = 7; key.shadow.blurSamples = 12;
key.shadow.bias = -0.0004;
scene.add(key);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.13 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -7;
ground.receiveShadow = true;
scene.add(ground);

/* ---------- the pods ---------- */
const hud = document.getElementById('hud');
const clickTargets = [];   // plinth meshes -> pod key
const personTargets = [];  // person meshes -> agent id
const R = {};              // per-agent runtime
const deptRT = {};         // per-pod runtime

for (const [podKey, L] of Object.entries(LAYOUT)) {
  const dept = DEPTS[podKey];
  const g = new THREE.Group();
  g.position.set(L.pos[0], 0, L.pos[1]);
  const plinth = makePlinth(L.w, L.d, dept.floor);
  g.add(plinth);
  plinth.traverse(o => { if (o.isMesh) { o.userData.dept = podKey; clickTargets.push(o); } });
  scene.add(g);
  deptRT[podKey] = { group: g, L, dept, vals: [], hover: false };
}

const gatePoint = k => {
  const L = LAYOUT[k];
  const sx = Math.sign(L.pos[0]) || 1, sz = Math.sign(L.pos[1]) || 1;
  return { x: L.pos[0] - sx * (L.w / 2 - 1), z: L.pos[1] - sz * (L.d / 2 - 1) };
};

// The pipeline is drawn pod to pod, then every pod runs back to the directory.
for (let i = 0; i < FLOW.length; i++) {
  const here = gatePoint(FLOW[i]);
  const next = FLOW[i + 1] ? gatePoint(FLOW[i + 1]) : null;
  if (next) scene.add(makeWalkway([here.x, here.z], [next.x, next.z]));
  const centre = gatePoint('desk');
  scene.add(makeWalkway([here.x, here.z], [centre.x, centre.z]));
}

// the directory's own furnishings — the records cabinet and a working table
{
  const records = deptRT.desk.group;
  const rack = makeServerRack(DEPTS.desk.chip);
  rack.position.set(-6.4, 0.12, -6);
  records.add(rack);
  const table = makeMeetingTable();
  table.position.set(0, 0.1, 5.4);
  records.add(table);
  const plant = makePlant();
  plant.position.set(6.2, 0.12, -5.6);
  records.add(plant);
}
for (const k of ['calls', 'design', 'despatch', 'scribe', 'gate']) {
  const L = LAYOUT[k];
  const sx = Math.sign(L.pos[0]), sz = Math.sign(L.pos[1]);
  const p = makePlant();
  p.position.set(L.pos[0] + sx * (L.w / 2 - 1.6), 0.12, L.pos[1] + sz * (L.d / 2 - 1.6));
  scene.add(p);
}

/* ---------- desks + people ---------- */
const POSE_BY_POD = { calls: 'phone', record: 'type', scribe: 'read', design: 'type', gate: 'read', despatch: 'type', desk: 'glance' };
const COLS = { calls: 2, record: 1, scribe: 1, design: 2, gate: 1, despatch: 2, desk: 2 };
const ANG = Math.PI / 4;
const rotate = v => v.applyAxisAngle(new THREE.Vector3(0, 1, 0), ANG);

for (const agent of AGENTS) {
  const rt = deptRT[agent.dept];
  const L = rt.L;
  const cols = COLS[agent.dept] || 1;
  const gx = ((agent.grid[0] - (cols - 1) / 2)) * 8.6;
  const gz = (agent.grid[1] - 1) * 6.4 - 1;
  const base = new THREE.Vector3(L.pos[0] + gx, 0.12, L.pos[1] + gz);

  const station = new THREE.Group();
  station.position.copy(base);
  station.rotation.y = ANG;
  station.add(makeDesk(rt.dept.chip).group);
  const chair = makeChair();
  chair.position.set(0, 0, 1.75);
  station.add(chair);
  scene.add(station);

  const person = makePerson({ hair: agent.hair, skin: agent.skin, chip: rt.dept.chip, lead: agent.lead });
  const seat = base.clone().add(rotate(new THREE.Vector3(0, 0, 1.7)));
  person.position.copy(seat);
  person.rotation.y = ANG + Math.PI;
  person.traverse(o => { if (o.isMesh) { o.userData.agentId = agent.id; o.userData.dept = agent.dept; personTargets.push(o); } });
  scene.add(person);

  const warn = makeWarnSprite();
  warn.visible = false;
  scene.add(warn);

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.innerHTML = (agent.lead ? '<span class="star">★</span>' : '') + agent.name;
  pill.addEventListener('click', () => openAgent(agent.id));
  pill.addEventListener('mouseenter', () => highlightPod(agent.dept, true));
  pill.addEventListener('mouseleave', () => highlightPod(agent.dept, false));
  hud.appendChild(pill);

  R[agent.id] = {
    a: agent, person, warn, pill, seat,
    seatRot: ANG + Math.PI,
    stand: seat.clone().add(rotate(new THREE.Vector3(2.6, 0, 0.2))),
    mode: POSE_BY_POD[agent.dept] || 'type',
    modeUntil: 0,
    walk: null,
    nextStroll: performance.now() + 5000 + Math.random() * 12000,
    hot: false,
  };
}

/* ---------- the live numbers on the pod cards ---------- */
const live = { counts: {}, notTranscribed: 0, transcribable: 0, awaiting: 0, services: [], webhook: null };

function metricsFor(pod) {
  const c = live.counts || {};
  const n = v => (v === undefined || v === null ? '—' : v);
  switch (pod) {
    case 'calls': return [['CALLS ON FILE', n(c.calls)], ['THIS WEEK', n(c.callsThisWeek)]];
    case 'record': return [['RECORDINGS', n(c.recordings)], ['NOT TRANSCRIBED', n(live.notTranscribed)]];
    case 'scribe': return [['TRANSCRIPTS', n(c.transcriptions)], ['AWAITING TEXT', n(live.transcribable)]];
    case 'design': return [['TRIPS DESIGNED', n(c.leads)], ['AWAITING OK', n(c.awaitingApproval)]];
    case 'gate': return [['WAITING OK', n(c.awaitingApproval)], ['POSTED', n(c.posted)]];
    case 'despatch': return [['GUESTS MAILED', n(c.posted)], ['PARTNERS', n(c.suppliers)]];
    default: return [['CONTACTS', n(c.contacts)], ['SUPPLIERS', n(c.suppliers)], ['TRIPS', n(c.leads)], ['STAFF', n(c.staff)]];
  }
}

for (const pod of DEPT_KEYS) {
  const dept = DEPTS[pod];
  const count = AGENTS.filter(a => a.dept === pod).length;
  const card = document.createElement('div');
  card.className = 'badge';
  card.innerHTML = `
    <div class="b-name"><span class="dot" style="background:${dept.chip}"></span>${dept.short}<span class="live"></span></div>
    <div class="b-count"><span class="b-num">${count}</span><span class="b-lab">AGENT${count === 1 ? '' : 'S'}</span></div>
    <div class="b-metrics">${metricsFor(pod).map((row, i) => `
      <div class="m-row"><span class="m-lab">${row[0]}</span><span class="m-val" data-m="${pod}-${i}">—</span></div>`).join('')}
    </div>
    <div class="b-appr" style="display:none">⚠ <span class="ap-n">0</span> WAITING FOR A PERSON</div>
    <div class="b-what">${dept.what}</div>`;
  card.addEventListener('click', e => {
    if (e.target.closest('.b-appr')) { desks.open('approvals'); flyToPod('gate'); e.stopPropagation(); return; }
    openAgent(POD_LEAD[pod]);
  });
  card.addEventListener('mouseenter', () => highlightPod(pod, true));
  card.addEventListener('mouseleave', () => highlightPod(pod, false));
  hud.appendChild(card);
  deptRT[pod].badge = card;
  deptRT[pod].apprRow = card.querySelector('.b-appr');
  deptRT[pod].apprN = card.querySelector('.ap-n');
}

// Anchor points, tuned so a card never covers its own agents.
const ANCHOR = {
  calls: [-42, 10, -34], record: [0, 11, -60], scribe: [42, 11, -34],
  design: [46, 10, 30], gate: [0, 10, 62], despatch: [-46, 10, 34], desk: [0, 13, -4],
};
for (const pod of DEPT_KEYS) deptRT[pod].badgeAnchor = new THREE.Vector3(...ANCHOR[pod]);

function highlightPod(pod, on) {
  const rt = deptRT[pod];
  if (!rt) return;
  rt.hover = !!on;
  rt.badge.classList.toggle('glow', !!on);
  if (rt.badgeAnchorHover) rt.badgeAnchor.copy(on ? rt.badgeAnchorHover : rt.badgeAnchorHome);
}

/* ---------- picking ---------- */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hoveredPod = null;
let atOverview = true;

function pick(ev) {
  ndc.x = (ev.clientX / innerWidth) * 2 - 1;
  ndc.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const people = raycaster.intersectObjects(personTargets, false);
  if (people.length) return { kind: 'agent', id: people[0].object.userData.agentId };
  const pods = raycaster.intersectObjects(clickTargets, false);
  if (pods.length) return { kind: 'pod', id: pods[0].object.userData.dept };
  return null;
}

function openAgent(agentId) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return;
  flyToPod(agent.dept);
  desks.open(agent.desk);
}

function flyToPod(pod) {
  const L = LAYOUT[pod];
  if (!L) return;
  atOverview = false;
  flyTo([L.pos[0], 0, L.pos[1]], innerWidth < 900 ? 1.1 : 1.45, 700);
  for (const b of document.querySelectorAll('#podbar button')) b.classList.toggle('on', b.dataset.pod === pod);
}

/* the pod strip — the phone's way around the floor */
function buildPodBar() {
  const bar = document.getElementById('podbar');
  bar.replaceChildren();
  for (const pod of DEPT_KEYS) {
    const dept = DEPTS[pod];
    const lead = AGENTS.find(a => a.id === POD_LEAD[pod]);
    bar.appendChild(h('button', {
      'data-pod': pod,
      onclick: () => { flyToPod(pod); if (lead) desks.open(lead.desk); },
    }, [
      h('span', { class: 'pd', style: `background:${dept.chip}` }),
      h('span', { text: dept.short }),
      h('span', { class: 'pn', 'data-pod-count': pod }),
    ]));
  }
}

function paintPodBarCounts() {
  for (const pod of DEPT_KEYS) {
    const el = document.querySelector(`#podbar [data-pod-count="${pod}"]`);
    if (!el) continue;
    const rows = metricsFor(pod);
    const n = live.awaiting > 0 && pod === 'gate' ? live.awaiting : (rows[0] ? rows[0][1] : '—');
    el.textContent = String(n ?? '—');
  }
}

function flyHome() {
  const o = overview();
  atOverview = true;
  flyTo(o.pos, o.zoom, 700);
  for (const b of document.querySelectorAll('#podbar button')) b.classList.remove('on');
}

/* ---------- the dotted wires: each service to every pod it feeds ---------- */

const SVC_COLOUR = {
  plivo: '#258C7B', openai: '#8B5CF6', deepseek: '#F59E0B', resend: '#10B981', database: '#0F172A',
};

const svg = document.getElementById('svcLinks');
let wires = [];              // { key, pod, path, d }

function buildWires() {
  svg.replaceChildren();
  wires = [];
  for (const s of live.services) {
    for (const pod of (s.pods || [])) {
      if (!LAYOUT[pod]) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke', SVC_COLOUR[s.key] || '#94A3B8');
      path.dataset.svc = s.key;
      path.dataset.pod = pod;
      path.style.animationDelay = `${(wires.length * 0.07).toFixed(2)}s`;
      svg.appendChild(path);
      wires.push({ key: s.key, pod, path, d: '' });
    }
  }
}

function paintWires() {
  if (!wires.length) return;
  const chips = new Map();
  for (const chip of document.querySelectorAll('#topconn .svc')) chips.set(chip.dataset.svc, chip);
  const focus = hoveredSvc || hoveredPod;

  for (const w of wires) {
    const chip = chips.get(w.key);
    const rt = deptRT[w.pod];
    if (!chip || !rt) { w.path.setAttribute('d', ''); continue; }

    const from = chip.getBoundingClientRect();
    const to = rt.badgeAnchor;
    const s = toScreen(to);
    const x1 = from.left + from.width / 2, y1 = from.bottom - 1;
    const x2 = s.x, y2 = s.y - 6;
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${(y1 + Math.max(24, (y2 - y1) * 0.42)).toFixed(1)} ${x2.toFixed(1)} ${(y2 - Math.max(24, (y2 - y1) * 0.42)).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    if (d !== w.d) { w.path.setAttribute('d', d); w.d = d; }

    const on = !focus || focus === w.key || focus === w.pod;
    w.path.classList.toggle('hot', !!focus && on && (focus === w.key || focus === w.pod));
    w.path.classList.toggle('off', !on);
  }
}

let hoveredSvc = null;
function highlightService(key, on) {
  hoveredSvc = on ? key : (hoveredSvc === key ? null : hoveredSvc);
  for (const pod of DEPT_KEYS) deptRT[pod].badge.classList.toggle('glow', on ? (live.services.find(s => s.key === key)?.pods || []).includes(pod) : (hoveredPod === pod));
}

/* ---------- controls ---------- */
let dragging = false, dragMoved = 0, last = null;
const pointers = new Map();          // every finger down, so a two-finger pinch can be read
let pinch = null;                    // { dist, mid, zoom, target }

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      zoom: view.zoom,
      target: view.target.clone(),
    };
    dragging = false; last = null;
    tween = null;
    return;
  }
  dragging = true; dragMoved = 0; last = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // two fingers: pinch to zoom and drag to pan at the same time
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const next = Math.min(2.6, Math.max(0.25, pinch.zoom * (dist / (pinch.dist || dist))));
    const scale = (2 * FR) / (innerHeight * pinch.zoom);
    view.target.copy(pinch.target)
      .addScaledVector(RIGHT, (mid.x - pinch.mid.x) * scale)
      .addScaledVector(UPSCREEN, (mid.y - pinch.mid.y) * scale * 0.78);
    view.zoom = next;
    dragMoved += 12;
    atOverview = false;
    return;
  }

  if (dragging && last) {
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    const scale = (2 * FR) / (innerHeight * view.zoom);
    view.target.addScaledVector(RIGHT, -dx * scale).addScaledVector(UPSCREEN, -dy * scale * 0.78);
    last = { x: e.clientX, y: e.clientY };
    tween = null;
    atOverview = false;
    return;
  }
  const hit = pick(e);
  const pod = hit?.kind === 'pod' ? hit.id : (hit?.kind === 'agent' ? AGENTS.find(a => a.id === hit.id)?.dept : null);
  if (pod !== hoveredPod) {
    if (hoveredPod) highlightPod(hoveredPod, false);
    hoveredPod = pod;
    if (pod) highlightPod(pod, true);
    canvas.style.cursor = pod ? 'pointer' : 'default';
  }
});

const endPointer = e => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    const wasDrag = dragMoved > 6;
    dragging = false; last = null;
    if (wasDrag) return;
    const hit = pick(e);
    if (!hit) return;
    if (hit.kind === 'agent') openAgent(hit.id);
    else { flyToPod(hit.id); openAgent(POD_LEAD[hit.id]); }
  }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; dragging = false; last = null; });
canvas.addEventListener('pointerleave', () => {
  if (hoveredPod) highlightPod(hoveredPod, false);
  hoveredPod = null;
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const before = view.zoom;
  const next = Math.min(2.6, Math.max(0.45, before * (e.deltaY > 0 ? 0.9 : 1.11)));
  const scale = (2 * FR) / (innerHeight * before);
  const wx = (e.clientX / innerWidth) * 2 - 1, wy = -(e.clientY / innerHeight) * 2 + 1;
  const shift = 1 - before / next;
  view.target
    .addScaledVector(RIGHT, wx * FR * (innerWidth / innerHeight) * scale * shift)
    .addScaledVector(UPSCREEN, wy * FR * scale * shift * 0.78);
  view.zoom = next;
  tween = null;
  atOverview = false;
}, { passive: false });

const zoomBy = factor => {
  view.zoom = Math.min(2.6, Math.max(0.45, view.zoom * factor));
  tween = null;
  atOverview = false;
};
document.getElementById('zIn').onclick = () => zoomBy(1.2);
document.getElementById('zOut').onclick = () => zoomBy(1 / 1.2);
document.getElementById('zHome').onclick = () => flyHome();
document.getElementById('overviewBtn').onclick = () => flyHome();

/* ---------- the phone + the desks ---------- */
const softphone = initSoftphone({ api: '/api' });
const desks = initDesks({ zoomToPod: flyToPod, softphone, refresh: () => refreshLive().catch(() => {}) });
buildPodBar();

/* ---------- live numbers ---------- */
async function refreshLive() {
  const [office, pipeline, recordings, services, followups, bookings] = await Promise.all([
    api.get('/office'),
    api.get('/pipeline'),
    api.get('/recordings?limit=1'),
    api.get('/services').catch(() => ({ services: [] })),
    api.get('/followups').catch(() => ({ followups: [], pendingCount: 0 })),
    api.get('/bookings').catch(() => ({ bookings: [] })),
  ]);
  live.counts = office.counts;
  live.awaiting = pipeline.awaitingApproval;
  live.notTranscribed = recordings.totals.notTranscribed;
  live.transcribable = pipeline.cases.filter(c => c.stations.find(s => s.key === 'transcription')?.state === 'active').length;
  live.services = services.services || [];
  live.webhook = services.webhook || null;
  live.pendingFollowups = followups?.pendingCount || 0;
  live.confirmedBookings = bookings?.bookings?.length || 0;
  paintMetrics();
  paintPodBarCounts();
  paintServiceStrip();
  desks.bump();
}

function paintMetrics() {
  for (const pod of DEPT_KEYS) {
    metricsFor(pod).forEach((row, i) => {
      const rt = deptRT[pod];
      const el = rt.badge.querySelector(`[data-m="${pod}-${i}"]`);
      if (!el) return;
      const value = String(row[1]);
      if (rt.vals[i] === value) return;
      rt.vals[i] = value;
      el.textContent = value;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  const gate = deptRT.gate;
  gate.apprRow.style.display = live.awaiting > 0 ? '' : 'none';
  gate.apprN.textContent = String(live.awaiting);

  const appr = document.getElementById('topAppr');
  if (appr) {
    appr.style.display = live.awaiting ? '' : 'none';
    const an = appr.querySelector('.ap-n') || appr.querySelector('span');
    if (an) an.textContent = String(live.awaiting);
    appr.onclick = () => { desks.open('approvals'); flyToPod('gate'); };
  }

  const topFollow = document.getElementById('topFollow');
  if (topFollow) {
    topFollow.style.display = live.pendingFollowups > 0 ? '' : 'none';
    const n = topFollow.querySelector('.fo-n');
    if (n) n.textContent = String(live.pendingFollowups);
    topFollow.onclick = () => { desks.open('followups'); flyToPod('despatch'); };
  }

  const topBook = document.getElementById('topBook');
  if (topBook) {
    topBook.style.display = live.confirmedBookings > 0 ? '' : 'none';
    const n = topBook.querySelector('.bk-n');
    if (n) n.textContent = String(live.confirmedBookings);
    topBook.onclick = () => { desks.open('bookings'); flyToPod('desk'); };
  }

  // the approval desk waves while a file is waiting on a person
  for (const agent of AGENTS.filter(a => a.dept === 'gate')) {
    const rt = R[agent.id];
    rt.hot = live.awaiting > 0;
    rt.mode = rt.hot ? 'wave' : (POSE_BY_POD.gate);
    rt.warn.visible = rt.hot;
  }
}

const SERVICE_ICON_ASSETS = {
  plivo: '/service-icons/plivo.svg',
  openai: '/service-icons/openai.png',
  deepseek: '/service-icons/deepseek.svg',
  resend: '/service-icons/resend.svg',
  database: '/service-icons/postgresql.svg',
};

function appendServiceIcon(chip, key) {
  const src = SERVICE_ICON_ASSETS[key];
  if (!src) return;
  const icon = document.createElement('img');
  icon.className = 'svc-icon';
  icon.src = src;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  chip.appendChild(icon);
}

function paintServiceStrip() {
  const strip = document.getElementById('topconn');
  strip.innerHTML = '';
  for (const s of live.services) {
    const on = !!(s.live || s.configured);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `svc ${on ? 'on' : 'off'}`;
    chip.dataset.svc = s.key;
    appendServiceIcon(chip, s.key);
    const name = document.createElement('span');
    name.className = 'svc-label';
    name.textContent = s.name;
    chip.appendChild(name);
    const pods = (s.pods || []).map(p => (DEPTS[p]?.short || p)).join(', ');
    chip.title = `${s.what}\nfeeds: ${pods || 'nothing yet'}\n${on ? 'connected' : 'not configured'}`;
    chip.setAttribute('aria-label', `${s.name}, ${on ? 'connected' : 'not configured'}. ${s.what}. Feeds: ${pods || 'nothing yet'}.`);
    // hovering a service traces its wires and lights the pods it feeds
    chip.addEventListener('mouseenter', () => highlightService(s.key, true));
    chip.addEventListener('mouseleave', () => highlightService(s.key, false));
    chip.addEventListener('click', () => {
      const first = (s.pods || []).find(p => LAYOUT[p]);
      if (first) { flyToPod(first); openAgent(POD_LEAD[first]); }
    });
    strip.appendChild(chip);
  }
  if (live.webhook) {
    const hook = document.createElement('button');
    hook.type = 'button';
    hook.className = `svc ${live.webhook.ok ? 'on' : 'off'}`;
    appendServiceIcon(hook, 'plivo');
    hook.setAttribute('aria-label', live.webhook.ok ? 'Plivo webhook reachable' : `Plivo webhook unavailable: ${live.webhook.reason || 'no public URL'}`);
    hook.title = live.webhook.ok ? 'Plivo webhook can reach this office — click to view line' : `Plivo webhook cannot reach this office — ${live.webhook.reason || 'no public URL'}`;
    hook.addEventListener('click', () => { desks.open('phone'); flyToPod('calls'); });
    strip.appendChild(hook);
  }
  buildWires();
}

/* ---------- the clock ---------- */
const tickClock = () => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

/* ---------- HTML projection ---------- */
const projected = new THREE.Vector3();
function toScreen(p) {
  projected.copy(p).project(camera);
  return { x: (projected.x * 0.5 + 0.5) * innerWidth, y: (-projected.y * 0.5 + 0.5) * innerHeight };
}

function layoutHud() {
  for (const pod of DEPT_KEYS) {
    const rt = deptRT[pod];
    const s = toScreen(rt.badgeAnchor);
    rt.badge.style.transform = `translate(-50%,-50%) translate(${s.x}px,${s.y}px) scale(${Math.max(0.6, Math.min(1.02, view.zoom * 0.7))})`;
    rt.badge.style.opacity = view.zoom < 0.52 ? '0.3' : '1';
  }
  const showPills = view.zoom > 0.58;
  for (const id of Object.keys(R)) {
    const rt = R[id];
    // the back row's pill floats a little higher, so an iso view never stacks two pills on each other
    const lift = rt.a.grid[1] === 0 ? 2.4 : 0;
    const s = toScreen(rt.person.position.clone().setY(rt.person.position.y + 4.1 + lift));
    rt.pill.style.transform = `translate(-50%,-100%) translate(${s.x}px,${s.y}px)`;
    rt.pill.style.opacity = showPills ? '1' : '0';
    rt.pill.style.pointerEvents = showPills ? 'auto' : 'none';
  }
  paintWires();
}

/* ---------- the floor at work ---------- */
function tickFloor(now, dt) {
  for (const id of Object.keys(R)) {
    const rt = R[id];

    if (!rt.walk && now > rt.nextStroll && !rt.hot) {
      rt.walk = { t0: now, dur: 2800, from: rt.seat.clone(), to: rt.stand.clone(), back: false };
      rt.nextStroll = now + 18000 + Math.random() * 24000;
    }
    if (rt.walk) {
      const k = Math.min(1, (now - rt.walk.t0) / rt.walk.dur);
      const from = rt.walk.back ? rt.walk.to : rt.walk.from;
      const to = rt.walk.back ? rt.walk.from : rt.walk.to;
      rt.person.position.lerpVectors(from, to, bezier(k));
      rt.person.rotation.y = rt.seatRot + (rt.walk.back ? -1 : 1) * k * Math.PI * 0.5;
      posePerson(rt.person, 'walk', now);
      if (k >= 1) {
        if (!rt.walk.back) rt.walk = { ...rt.walk, t0: now, back: true };
        else { rt.walk = null; rt.person.position.copy(rt.seat); rt.person.rotation.y = rt.seatRot; }
      }
      continue;
    }

    rt.person.rotation.y = rt.seatRot;
    rt.person.position.copy(rt.seat);
    poseWork(rt.person, rt.mode, now + rt.a.grid[0] * 900, dt);
    rt.warn.position.copy(rt.person.position).setY(rt.person.position.y + 5.2);
  }
}

/* ---------- loop ---------- */
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  tickTween(now);
  applyCamera();
  tickFloor(now, dt);
  layoutHud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  svg.setAttribute('width', String(innerWidth));
  svg.setAttribute('height', String(innerHeight));
  if (atOverview) {
    const o = overview();
    view.target.set(o.pos[0], 0, o.pos[2]);
    view.zoom = o.zoom;
    tween = null;
  }
  applyCamera();
  renderer.render(scene, camera);
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 250));
resize();
requestAnimationFrame(frame);

/* ---------- boot ---------- */
tickClock();
setInterval(tickClock, 1000);
refreshLive().catch(e => console.warn('[office] live numbers unavailable:', e.message));
setInterval(() => refreshLive().catch(() => {}), 6000);

// a first-run nudge, so a phone user knows the floor moves
(() => {
  const hint = document.getElementById('hint');
  const touch = matchMedia('(hover: none)').matches || 'ontouchstart' in window;
  hint.innerHTML = touch
    ? 'Tap a pod to open its desk · <b>pinch to zoom</b>'
    : 'Click a pod to open its desk · scroll to zoom · hover a service to trace its wires';  hint.classList.add('on');
  setTimeout(() => hint.classList.remove('on'), 7000);
  if (touch) document.getElementById('zoomCtl').style.display = '';
})();

console.log('[office] 3dots Travel — the holiday desk is open');
