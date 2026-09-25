'use strict';
// Gym log: state in localStorage (see store below), optionally synced to a GitHub repo (sync.js).
// Exercises come from catalog.js.

const $ = (s, r = document) => r.querySelector(s);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => (v === '' || v == null || isNaN(+String(v).replace(',', '.'))) ? null : +String(v).replace(',', '.');
const fmtN = n => n == null ? '' : String(Math.round(n * 100) / 100);
const fmtD = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDs = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric' });
const fmtT = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const dur = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

// ---------- store ----------
const KEY = 'gym.v1';
const store = {
  load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* ignore */ }
    return migrate(Object.assign(emptyState(), s || {}));
  },
  save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (e) { alert('Could not save to browser storage!\n' + e); }
  },
};
function emptyState() { return { v: 3, sessions: [], active: null, targets: {}, targetLog: [], notes: {}, deleted: {} }; }
function migrate(s) {
  if ((s.v || 1) < 2) { // v1 keyed targets by `${planId}:${exId}`; v2 keys by exercise id
    const strip = k => k.includes(':') ? k.split(':')[1] : k;
    s.targets = Object.fromEntries(Object.entries(s.targets || {}).map(([k, v]) => [strip(k), v]));
    (s.targetLog || []).forEach(l => { l.ex = strip(l.key || ''); delete l.key; });
    s.v = 2;
  }
  if (s.v < 3) { // v3: modification times for merging (sessions.u, targets[].u, notes {t, u}), tombstones
    s.notes = Object.fromEntries(Object.entries(s.notes || {}).map(([k, v]) => [k, typeof v === 'string' ? { t: v, u: 0 } : v]));
    s.v = 3;
  }
  return sanitizeState(s);
}
let S = store.load();
let VIEW = null;   // read-only view of someone else's log: { repo, path, at }; S then holds their data

// Sessions get `u` (last modified) bumped automatically: save() diffs them against the last snapshot.
let snap = new Map();
const sessJSON = x => JSON.stringify({ ...x, u: 0 });
function resnap() { snap = new Map(S.sessions.map(x => [x.id, sessJSON(x)])); }
resnap();
function save() {
  if (VIEW) return;
  for (const x of S.sessions) {
    const j = sessJSON(x);
    if (snap.get(x.id) !== j) { x.u = nextU(sessU(x)); snap.set(x.id, j); }
  }
  store.save(S);
  markDirty();
}
function deleteSession(x) {
  S.sessions = S.sessions.filter(y => y !== x);
  S.deleted[x.id] = nextU(Math.max(x.u || 0, x.end || 0, x.start || 0));
  if (S.active === x.id) S.active = null;
}

// ---------- catalog access ----------
const EX = Object.fromEntries(CATALOG.exercises.map(e => [e.id, e]));
const exOf = id => EX[id] || { id, name: id + ' (removed)', primary: [], secondary: [], tips: [], kind: 'reps', loadType: 'kg', step: 2.5 };
const groupName = id => CATALOG.groups.find(g => g.id === id)?.name || 'Other';
const targetOf = exId => { const { u, ...o } = S.targets[exId] || {}; return { sets: 3, reps: 10, load: null, rest: 90, ...(EX[exId]?.target || {}), ...o }; };
const hasOverride = exId => Object.keys(S.targets[exId] || {}).some(k => k !== 'u');
const noteOf = exId => S.notes[exId]?.t || '';
function setTarget(exId, k, v) {
  const cur = targetOf(exId);
  if (cur[k] === v) return;
  S.targets[exId] = { ...(S.targets[exId] || {}), [k]: v, u: nextU(S.targets[exId]?.u) };
  S.targetLog.push({ t: Date.now(), ex: exId, k, from: cur[k], to: v });
}
// exercises bucketed by muscle group, in catalog order
function byGroup() {
  const gs = CATALOG.groups.map(g => ({ ...g, ex: CATALOG.exercises.filter(e => e.group === g.id) }));
  const other = CATALOG.exercises.filter(e => !CATALOG.groups.some(g => g.id === e.group));
  return other.length ? [...gs, { id: 'other', name: 'Other', ex: other }] : gs;
}
function exSelect(id) {
  return `<select id="${id}"><option value="">choose…</option>${byGroup().map(g => `<optgroup label="${h(g.name)}">
    ${g.ex.map(e => `<option value="${e.id}">${h(e.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}
const sess = id => S.sessions.find(s => s.id === id);

// ---------- stats ----------
const doneSets = it => it.sets.filter(x => x.done);
function exHistory(exId, exceptSid) {
  return S.sessions.filter(s => s.end && s.id !== exceptSid).sort((a, b) => a.start - b.start)
    .flatMap(s => s.items.filter(i => i.ex === exId).map(i => ({ s, it: i, sets: doneSets(i) })))
    .filter(x => x.sets.length);
}
const lastPerf = (exId, exceptSid) => exHistory(exId, exceptSid).at(-1);
function fmtSets(sets, ex) {
  // group consecutive sets with the same weight: "6 kg × 8, 8 · 8 kg × 7"
  const unit = ex.kind === 'hold' ? 's' : '';
  const groups = [];
  for (const x of sets) {
    const g = groups.at(-1);
    if (g && g.w === x.w) g.r.push(x.r); else groups.push({ w: x.w, r: [x.r] });
  }
  return groups.map(g => (g.w ? `${fmtN(g.w)} kg × ` : '') + g.r.map(r => (r ?? '?') + unit).join(', ')).join(' · ');
}
function hitTarget(sets, t) {
  return sets.filter(x => (x.r ?? 0) >= t.reps && (x.w ?? 0) >= (t.load ?? 0)).length >= t.sets;
}
// Weight you managed for all target sets at target reps (can exceed the target if you went heavier).
function achievedLoad(sets, t) {
  const ws = sets.filter(x => (x.r ?? 0) >= t.reps).map(x => x.w ?? 0).sort((a, b) => b - a);
  return Math.max(t.load ?? 0, ws[t.sets - 1] ?? 0);
}
function progressOptions(ex, t, sets) {
  if (ex.kind === 'hold') return [{ k: 'reps', v: t.reps + (ex.step || 5), label: `→ ${t.reps + (ex.step || 5)} s` }];
  const o = [], base = achievedLoad(sets, t), step = ex.step || 2.5;
  if (ex.loadType !== 'none') o.push({ k: 'load', v: Math.round((base + step) * 100) / 100, label: `→ ${fmtN(base + step)} kg` });
  o.push({ k: 'reps', v: t.reps + 1, label: `→ ${t.reps + 1} reps` });
  return o;
}
// Metric for charts: top weight if the exercise was ever loaded, else total reps/seconds.
function metricKind(allSets) {
  return allSets.some(x => x.w > 0) ? { unit: 'kg', label: 'Top weight' } : { unit: '', label: 'Total reps' };
}
const metricOf = (sets, m) => m.unit === 'kg' ? Math.max(0, ...sets.map(x => x.w || 0)) : sets.reduce((a, x) => a + (x.r || 0), 0);

// ---------- sessions ----------
function mkItem(exId) {
  const t = targetOf(exId);
  return {
    ex: exId, ss: EX[exId]?.ss || '',
    target: { sets: t.sets, reps: t.reps, load: t.load ?? null, rest: t.rest ?? 90 },
    sets: Array.from({ length: t.sets }, () => ({ w: null, r: null, done: false })), note: '',
  };
}
function newSession() {
  const s = { id: uid(), start: Date.now(), end: null, note: '', items: [] };
  S.sessions.push(s); S.active = s.id;
  return s;
}
// add an exercise to the running visit (starting one if needed) and jump to it
function pickExercise(exId) {
  let s = S.active && sess(S.active);
  if (!s) s = newSession();
  let i = s.items.findIndex(it => it.ex === exId);
  if (i < 0) { s.items.push(mkItem(exId)); i = s.items.length - 1; }
  save();
  pendingScroll = 'item-' + i;
  go('#/s/' + s.id);
}
// visit title from the muscle groups it touched
function sessName(s) {
  const gs = [...new Set(s.items.map(i => exOf(i.ex).group).filter(Boolean))];
  return gs.length ? gs.map(g => groupName(g).split(' ')[0]).join(' · ') : (s.name || 'Visit');
}
// when an exercise / muscle group was last trained, and how many sets recently
function lastDone(exId) {
  return Math.max(0, ...S.sessions.filter(s => s.items.some(i => i.ex === exId && doneSets(i).length)).map(s => s.start));
}
function groupStats() {
  const now = Date.now(), st = {};
  for (const s of S.sessions) for (const it of s.items) {
    const n = doneSets(it).length, g = exOf(it.ex).group || 'other';
    if (!n) continue;
    st[g] ||= { w: 0, m: 0, last: 0 };
    if (now - s.start < 7 * 864e5) st[g].w += n;
    if (now - s.start < 28 * 864e5) st[g].m += n;
    st[g].last = Math.max(st[g].last, s.start);
  }
  return st;
}
const ago = t => {
  if (!t) return 'never';
  const d = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} d ago`;
};
// ---------- rest timer ----------
let rest = null, restIv = null, audio = null;
function beep() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(d => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.3, audio.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + d + 0.2);
      o.start(audio.currentTime + d); o.stop(audio.currentTime + d + 0.2);
    });
  } catch (e) { /* no audio */ }
}
function startRest(sec) {
  if (!sec) return;
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* ignore */ }
  rest = { end: Date.now() + sec * 1000, total: sec };
  clearInterval(restIv); restIv = setInterval(tickRest, 250); tickRest();
}
function tickRest() {
  const el = $('#rest');
  if (!rest) { el.hidden = true; clearInterval(restIv); return; }
  const left = Math.ceil((rest.end - Date.now()) / 1000);
  if (left <= 0) {
    rest = null; el.hidden = true; clearInterval(restIv);
    beep(); navigator.vibrate?.([200, 100, 200]); toast('Rest over. Next set!');
    return;
  }
  el.hidden = false;
  $('.t', el).textContent = mmss(left);
  $('.bar', el).style.width = (100 * left / rest.total) + '%';
}

let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2500);
}

let wakeLock = null;
async function wantWake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* ignore */ }
}

// ---------- sync (GitHub repo, see sync.js) ----------
const SYNC_KEY = 'gym.sync', VIEW_KEY = 'gym.view', VTOKEN_KEY = 'gym.viewtoken';
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
// cfg: { repo, path, token, sha?, last? } (device-local: never exported or synced)
const SY = { cfg: lsGet(SYNC_KEY), busy: false, err: null, again: false, timer: null, gen: 0 };
// bumped on anything that changes what S means or where it syncs (view enter/exit, connect,
// disconnect, copy): an in-flight sync then drops its result instead of mixing logs
const bumpGen = () => { SY.gen++; };
const editing = () => !!document.activeElement?.closest?.('#main') && document.activeElement.matches('input:not([readonly]),textarea');
const syncCfgSave = () => lsSet(SYNC_KEY, SY.cfg);
const normalize = data => { const x = migrate(Object.assign(emptyState(), { v: 1 }, JSON.parse(JSON.stringify(data)))); x.active = null; return x; };
const appUrl = () => location.origin + location.pathname;
const repoPath = cfg => cfg.repo + (cfg.path !== 'gym.json' ? '/' + cfg.path : '');
function device() {
  let d = lsGet('gym.device');
  if (!d) {
    const ua = navigator.userAgent;
    d = (/Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : /Mac/.test(ua) ? 'mac' : /Win/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : 'device')
      + '-' + Math.random().toString(36).slice(2, 6);
    lsSet('gym.device', d);
  }
  return d;
}
// Uploads make commits, so they're rare: on Finish, on app start with unsynced changes, after
// IDLE_MS without edits, or on demand. Downloads (no commits) happen on start and on resume.
const IDLE_MS = 10 * 60 * 1000;
function scheduleSync(ms, push = false) {
  if (!SY.cfg || VIEW) return;
  clearTimeout(SY.timer);
  SY.timer = setTimeout(() => syncNow(push), ms);
}
// local changes not uploaded yet: cfg.dirty counts edits, persisted so a restart still knows
function markDirty() {
  if (!SY.cfg || VIEW) return;
  SY.cfg.dirty = (SY.cfg.dirty || 0) + 1;
  SY.cfg.lastEdit = Date.now();
  syncCfgSave();
  scheduleSync(SY.idleMs ?? IDLE_MS, true);
  if (SY.cfg.dirty === 1) syncBadge();
}
const idleLongEnough = () => SY.cfg?.dirty && Date.now() - (SY.cfg.lastEdit || 0) >= (SY.idleMs ?? IDLE_MS);
function applyMerged(merged) {
  if (VIEW) return;
  const before = canon(syncPart(S));
  const active = S.active;
  S = merged;
  S.active = active && sess(active) && !sess(active).end ? active : null;   // finished elsewhere -> not running here
  resnap();
  store.save(S);
  if (canon(syncPart(S)) !== before) rerender();
}
// pull and merge; with push, also upload if the merged log differs from GitHub's.
// Uploads are retried on concurrent writes (GitHub rejects writes based on a stale sha).
async function syncNow(push = true) {
  if (!SY.cfg || VIEW) return;
  if (SY.busy) { SY.again = true; SY.againPush ||= push; return; }
  clearTimeout(SY.timer);
  const cfg = SY.cfg, gen = SY.gen, seq = cfg.dirty || 0;
  const stale = () => VIEW || SY.cfg !== cfg || SY.gen !== gen;
  SY.busy = true; syncBadge();
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 4) throw new SyncError('The log keeps changing elsewhere; will retry', 0);
      const remote = await ghRead(cfg);
      if (stale()) return;
      const rs = remote && normalize(remote.data);
      const merged = rs ? mergeStates(S, rs) : S;
      // Don't swap state under a field being edited (DOM indices would point into the new state):
      // still upload the merge, but apply it locally once the field loses focus.
      const defer = editing();
      if (defer) SY.pendingApply = true; else { SY.pendingApply = false; applyMerged(merged); }
      const out = defer ? merged : S;
      if (rs && canon(syncPart(out)) === canon(syncPart(rs))) { cfg.sha = remote.sha; if (cfg.dirty === seq) cfg.dirty = 0; break; }
      if (!push) { if (cfg.dirty) scheduleSync(Math.max(0, (cfg.lastEdit || 0) + (SY.idleMs ?? IDLE_MS) - Date.now()), true); break; }
      const w = await ghWrite(cfg, syncPart(out), remote?.sha, `gym: sync from ${device()}`);
      if (stale()) return;
      if (w.conflict) continue;
      cfg.sha = w.sha;
      if (cfg.dirty === seq) cfg.dirty = 0;   // edits made during the upload stay dirty
      break;
    }
    cfg.last = Date.now(); SY.err = null;
  } catch (e) {
    if (stale()) return;
    SY.err = e.message || String(e);
    if (![401, 403, 404].includes(e.status)) scheduleSync(60000, push);   // transient: retry later
  } finally {
    SY.busy = false;
    if (SY.cfg) syncCfgSave();
    syncBadge();
    if (SY.again) { const p = SY.againPush; SY.again = SY.againPush = false; scheduleSync(1000, p); }
  }
}
function syncBadge() {
  const el = $('#syncst');
  if (!el) return;
  el.textContent = VIEW ? '👀' : !SY.cfg ? '' : SY.busy ? '⟳' : SY.err ? '⚠️ sync' : SY.cfg.dirty ? '☁️•' : '☁️';
  el.title = VIEW ? `Viewing ${VIEW.repo}` : !SY.cfg ? '' : SY.err ? SY.err : SY.cfg.dirty ? 'Changes not uploaded yet' : `Synced ${SY.cfg.last ? fmtT(SY.cfg.last) : ''}`;
  if ((location.hash || '').startsWith('#/data') && !document.activeElement?.matches('input,textarea')) { const st = $('#syncstatus'); if (st) st.innerHTML = syncStatusHtml(); }
}
function syncStatusHtml() {
  if (!SY.cfg) return '';
  const last = SY.cfg.last ? `Last synced ${fmtD(SY.cfg.last)} ${fmtT(SY.cfg.last)}` : 'Not synced yet';
  return SY.busy ? 'Syncing…' : SY.err ? `<span class="down">⚠️ ${h(SY.err)}</span>`
    : SY.cfg.dirty ? `${last}. Newer changes upload when you finish a visit, after 10 min without edits, or on "Sync now".` : `${last} ✓`;
}
// #/connect/<owner>/<repo>/<token>[/<path>]: a link from the trainer (or yourself) to set up sync
function connectFromHash(parts) {
  const [owner = '', repo = '', token = '', ...pp] = parts.map(decodeURIComponent);
  history.replaceState(null, '', location.pathname + location.search + '#/data');   // drop the token from the URL
  connectTo({ repo: `${owner}/${repo}`, token, path: pp.join('/') || 'gym.json' });
}
function connectTo(cfg) {
  if (!validRepo(cfg.repo) || !validPath(cfg.path) || !/^[A-Za-z0-9_]{20,255}$/.test(cfg.token)) { render(); toast('Invalid repo, file or token'); return; }
  if (SY.cfg && (SY.cfg.repo !== cfg.repo || SY.cfg.path !== cfg.path)
    && !confirm(`This browser syncs with ${repoPath(SY.cfg)}. Switch to ${repoPath(cfg)}?\nThe log in this browser will be merged into it.`)) { render(); return; }
  bumpGen(); SY.cfg = cfg; SY.err = null; syncCfgSave();
  render();
  toast('Connecting…');
  syncNow().then(() => toast(SY.err ? 'Sync failed: ' + SY.err : 'Connected and synced ✓'));
}
// #/view/<owner>/<repo>[/<path>]: read-only view of someone's log
async function enterView(parts) {
  const [owner = '', repo = '', ...pp] = parts.map(decodeURIComponent);
  const cfg = { repo: `${owner}/${repo}`, path: pp.join('/') || 'gym.json' };
  const main = $('#main');
  if (!validRepo(cfg.repo) || !validPath(cfg.path)) { main.innerHTML = '<div class="card warn">Invalid view link.</div>'; return; }
  main.innerHTML = `<p class="muted">Loading ${h(repoPath(cfg))}…</p>`;
  try {
    let r;
    try { r = await ghRead(cfg); }
    catch (e) {   // private repo? try this browser's tokens
      const tk = lsGet(VTOKEN_KEY) || (SY.cfg?.repo === cfg.repo ? SY.cfg.token : null);
      if (e.status === 404 && tk) r = await ghRead({ ...cfg, token: tk }); else throw e;
    }
    if (!r) throw new Error('there is no gym log in that repo yet');
    bumpGen(); clearTimeout(SY.timer);
    VIEW = { repo: cfg.repo, path: cfg.path, at: Date.now() };
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ ...VIEW, data: r.data })); } catch (e) { /* ignore */ }
    S = normalize(r.data);
    rest = null; tickRest();
    location.replace('#/');
  } catch (e) {
    main.innerHTML = `<div class="card warn"><b>Could not load ${h(repoPath(cfg))}</b><p>${h(e.message)}</p>
      <p><small>If it's a private repo, add a GitHub token with read access under Sync → View someone's log.</small></p></div><p><a href="#/">Back</a></p>`;
  }
}
function exitView() {
  try { sessionStorage.removeItem(VIEW_KEY); } catch (e) { /* ignore */ }
  bumpGen(); VIEW = null; S = store.load(); resnap();
  scheduleSync(500, false);
}
(function restoreView() {   // a reload keeps the view (per tab)
  let v = null;
  try { v = JSON.parse(sessionStorage.getItem(VIEW_KEY)); } catch (e) { /* ignore */ }
  if (v && v.data) { VIEW = { repo: v.repo, path: v.path, at: v.at }; S = normalize(v.data); }
})();
// QR codes for connect links (so a long token gets to a phone by scanning). The encoder
// (vendor/qrcode.js, MIT) is loaded only when needed.
let qrLib = null;
function loadQr() {
  qrLib ||= new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/qrcode.js'; sc.onload = () => ok(window.qrcode); sc.onerror = () => { qrLib = null; fail(new Error('could not load the QR encoder')); };
    document.head.appendChild(sc);
  });
  return qrLib;
}
async function showQr(el, text, note) {
  try {
    const qrcode = await loadQr();
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    el.innerHTML = `<div class="qr">${q.createSvgTag({ cellSize: 4, margin: 3, scalable: true })}</div>
      <p><small>${note}</small></p>
      <p><button class="btn sm ghost" data-a="copy" data-text="${h(text)}" data-what="Link">Copy link instead</button>
      <button class="btn sm ghost" data-a="hide-qr">Hide</button></p>`;
  } catch (e) { el.innerHTML = `<p class="down">${h(e.message)}</p>`; }
}
const connectLink = cfg => `${appUrl()}#/connect/${cfg.repo}/${cfg.token}${cfg.path !== 'gym.json' ? '/' + cfg.path : ''}`;
const SECRET_NOTE = '🔒 Contains the token: whoever scans or gets this can edit the log. Don\'t screenshot or share it.';

function copyText(t, what) {
  (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast(`${what} copied`), () => prompt(`Copy the ${what.toLowerCase()}:`, t));
}

// ---------- views ----------
const chips = arr => arr.map(m => `<span class="chip">${h(m)}</span>`).join('');
function targetText(ex, t) {
  const bits = [`${t.sets} × ${t.reps}${ex.kind === 'hold' ? ' s' : ''}${ex.perSide ? ' /side' : ''}`];
  if (t.load) bits.push(`${fmtN(t.load)} kg`); else if (ex.loadType === 'bw') bits.push('bodyweight');
  if (t.rest) bits.push(`rest ${t.rest} s`);
  return bits.join(' · ');
}

function vHome() {
  const a = S.active && sess(S.active);
  const past = S.sessions.filter(s => s.end || VIEW).sort((x, y) => y.start - x.start);
  let o = '';
  if (a) {
    const all = a.items.flatMap(i => i.sets), d = all.filter(x => x.done).length;
    o += `<a class="card active" href="#/s/${a.id}"><div class="row"><div><b>${h(sessName(a))}</b> in progress<br>
      <small>started ${fmtT(a.start)} · ${d}/${all.length} sets</small></div><span class="btn">Resume ›</span></div></a>`;
  } else if (!VIEW) o += `<h2>Pick an exercise to start a visit</h2>` + vPicker(null);
  o += `<h2>${VIEW ? 'Visits' : 'Past visits'}</h2>`;
  o += past.length ? `<div class="list">${past.slice(0, 30).map(s => {
    const n = s.items.reduce((a, i) => a + doneSets(i).length, 0);
    return `<a href="#/s/${s.id}"><span>${fmtD(s.start)}</span><b>${h(sessName(s))}</b><small>${n} sets · ${s.end ? dur(s.end - s.start) : 'in progress'}</small></a>`;
  }).join('')}</div>` : '<p class="muted">Nothing yet.</p>';
  if (VIEW) o += `<h2>Muscle groups</h2>` + vPicker(null);
  return o;
}

// exercise library grouped by muscle group, with how much/recently each group was trained
function vPicker(s) {
  const st = groupStats();
  return byGroup().map(g => {
    const gs = st[g.id] || { w: 0, m: 0, last: 0 };
    const stale = !gs.last || Date.now() - gs.last > 7 * 864e5;
    return `<div class="card grp ${stale ? 'stale' : ''}">
      <b>${h(g.name)}</b>
      <small class="gstat">${gs.w} sets this week · ${Math.round(gs.m / 4 * 10) / 10}/wk avg · last ${ago(gs.last)}${stale ? ' · <b>due</b>' : ''}</small>
      ${g.ex.map(e => {
        const on = s?.items.some(i => i.ex === e.id);
        return `<button class="pick ${on ? 'on' : ''}" data-a="pick" data-ex="${e.id}">
          ${e.img ? `<img src="${h(e.img)}" alt="" loading="lazy">` : '<span></span>'}
          <span><b>${h(e.name)}</b><br><small>${h(targetText(e, targetOf(e.id)))} · ${ago(lastDone(e.id))}</small></span>
          <span class="go">${on ? '✓' : '+'}</span></button>`;
      }).join('')}
    </div>`;
  }).join('');
}

function vSession(id) {
  const s = sess(id);
  if (!s) return '<p>Session not found.</p>';
  const live = !s.end && !VIEW;
  let o = `<div class="shead"><h1>${h(sessName(s))}</h1><small>${fmtD(s.start)} · ${fmtT(s.start)}${s.end ? '–' + fmtT(s.end) + ' · ' + dur(s.end - s.start) : ' · <span id="elapsed"></span>'}</small></div>`;
  s.items.forEach((it, i) => { o += itemCard(s, it, i); });
  if (!s.items.length) o += '<p class="muted">Pick your first exercise below.</p>';
  if (live) o += `<h2>${s.items.length ? 'Next exercise' : 'Exercises'}</h2>` + vPicker(s);
  else if (!VIEW) o += `<div class="card"><label>Add a forgotten exercise ${exSelect('addex')}</label></div>`;
  o += `<div class="card"><label>Session notes<textarea data-f="snote" rows="2" placeholder="How did it feel? Energy, sleep, pain…">${h(s.note)}</textarea></label></div>`;
  o += live
    ? `<p><button class="btn big" data-a="finish">Finish visit</button></p><p><button class="btn ghost danger" data-a="del">Discard session</button></p>`
    : VIEW ? '' : `<p><button class="btn ghost danger" data-a="del">Delete session</button></p>`;
  return o;
}

function itemCard(s, it, i) {
  const ex = exOf(it.ex), t = it.target, live = !s.end && !VIEW;
  const prev = s.items[i - 1], next = s.items[i + 1];
  const inSS = it.ss && (prev?.ss === it.ss || next?.ss === it.ss);
  const ssTag = inSS ? `<span class="chip ss">Superset ${prev?.ss === it.ss ? 'B' : 'A'}</span>` : '';
  const lp = lastPerf(it.ex, s.id);
  let sug = '';
  const pi = EX[it.ex] ? targetOf(it.ex) : null;
  if (live && lp && hitTarget(lp.sets, t)) {
    sug = `<div class="sug">📈 Last time you hit all ${t.sets}×${t.reps}. Time to progress?
      ${progressOptions(ex, t, lp.sets).map(op => `<button class="btn sm" data-a="apply" data-i="${i}" data-k="${op.k}" data-v="${op.v}">${op.label}</button>`).join('')}</div>`;
  } else if (!live && !VIEW && pi && doneSets(it).length && hitTarget(doneSets(it), pi)) {
    sug = `<div class="sug">✅ All targets hit. Raise the target for next time?
      ${progressOptions(ex, pi, doneSets(it)).map(op => `<button class="btn sm" data-a="apply" data-i="${i}" data-k="${op.k}" data-v="${op.v}">${op.label}</button>`).join('')}</div>`;
  }
  const unit = ex.kind === 'hold' ? 'sec' : (ex.perSide ? 'reps/side' : 'reps');
  const rows = it.sets.map((x, j) => `<div class="set ${x.done ? 'done' : ''}">
      <span class="n">${j + 1}</span>
      <label><input type="text" inputmode="decimal" data-f="set" data-i="${i}" data-j="${j}" data-k="w" value="${fmtN(x.w)}" placeholder="${t.load != null ? fmtN(t.load) : (ex.loadType === 'none' ? '–' : 'BW')}" aria-label="kg"></label>
      <label><input type="text" inputmode="numeric" data-f="set" data-i="${i}" data-j="${j}" data-k="r" value="${x.r ?? ''}" placeholder="${t.reps}" aria-label="${unit}"></label>
      <button class="tick" data-a="tick" data-i="${i}" data-j="${j}" aria-label="done">✓</button></div>`).join('');
  const partner = live && it.ss && !inSS && CATALOG.exercises.find(e => e.ss === it.ss && e.id !== it.ex && !s.items.some(x => x.ex === e.id));
  const ssHint = partner ? `<div class="sug">🔗 Trainer pairs this as a superset with <b>${h(partner.name)}</b>
    <button class="btn sm" data-a="addpartner" data-i="${i}" data-ex="${partner.id}">Add it</button></div>` : '';
  return `<div class="card ex ${inSS ? 'inss' : ''} ${next?.ss && next.ss === it.ss ? 'ssfirst' : ''}" id="item-${i}">
    <div class="exhead">
      ${ex.img ? `<a href="#/ex/${ex.id}"><img src="${h(ex.img)}" alt="" loading="lazy"></a>` : ''}
      <div><a href="#/ex/${ex.id}"><b>${h(ex.name)}</b></a> ${ssTag}<br>
      <small>${h(ex.detail || '')}</small><br>
      <span class="target">🎯 ${h(targetText(ex, t))}</span></div>
    </div>
    ${ex.breath || ex.tips?.length ? `<div class="tips">${ex.breath ? `<div class="breath">🫁 ${h(ex.breath)}</div>` : ''}
      ${ex.tips?.length ? `<ul>${ex.tips.map(t => `<li>${h(t)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${lp ? `<div class="last">Last (${fmtDs(lp.s.start)}): ${h(fmtSets(lp.sets, ex))}${lp.it.note ? ` · <i>${h(lp.it.note)}</i>` : ''}</div>` : ''}
    ${noteOf(ex.id) ? `<div class="last">📝 ${h(noteOf(ex.id))}</div>` : ''}
    ${sug}${ssHint}
    <div class="sets"><div class="set hdr"><span></span><small>kg</small><small>${unit}</small><span></span></div>${rows}</div>
    <div class="row tools">
      <span><button class="btn sm ghost" data-a="addset" data-i="${i}">+ set</button>
      <button class="btn sm ghost" data-a="rmset" data-i="${i}">− set</button></span>
      <span><button class="btn sm ghost" data-a="up" data-i="${i}" title="move up">↑</button>
      <button class="btn sm ghost danger" data-a="rmitem" data-i="${i}" title="remove">✕</button></span>
    </div>
    <input type="text" class="note" data-f="inote" data-i="${i}" value="${h(it.note)}" placeholder="Note (e.g. left knee, seat pos 4…)">
  </div>`;
}

function chart(pts, unit) {
  if (pts.length < 2) return '<p class="muted">Log at least two visits to see a chart.</p>';
  const W = 340, H = 150, L = 34, R = 10, T = 14, B = 24;
  const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo;
  const x = i => L + (W - L - R) * i / (pts.length - 1), y = v => T + (H - T - B) * (span ? 1 - (v - lo) / span : 0.5);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const every = Math.ceil(pts.length / 6);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <line x1="${L}" y1="${y(hi)}" x2="${W - R}" y2="${y(hi)}" class="grid"/><line x1="${L}" y1="${y(lo)}" x2="${W - R}" y2="${y(lo)}" class="grid"/>
    <text x="${L - 4}" y="${y(hi) + 4}" text-anchor="end">${fmtN(hi)}</text><text x="${L - 4}" y="${y(lo) + 4}" text-anchor="end">${fmtN(lo)}</text>
    <polyline points="${line}"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="3.5"><title>${fmtD(p.t)}: ${fmtN(p.v)} ${unit}</title></circle>`).join('')}
    ${pts.map((p, i) => (i % every === 0 || i === pts.length - 1) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtDs(p.t)}</text>` : '').join('')}
  </svg>`;
}

function vExercise(id) {
  const ex = EX[id];
  if (!ex) return '<p>Unknown exercise.</p>';
  const hist = exHistory(id);
  const m = hist.length ? metricKind(hist.flatMap(x => x.sets)) : null;
  if (m && ex.kind === 'hold') m.label = 'Total seconds';
  const pts = hist.map(x => ({ t: x.s.start, v: metricOf(x.sets, m) }));
  const vol = hist.map(x => ({ t: x.s.start, v: x.sets.reduce((a, s) => a + (s.w || 0) * (s.r || 0), 0) }));

  return `${ex.img ? `<img class="hero" src="${h(ex.img)}" alt="">` : ''}
    <h1>${h(ex.name)}</h1><p class="muted">${h(ex.detail || '')}</p>
    <p>🎯 <a href="#/targets/${ex.id}">Target</a>: ${h(targetText(ex, targetOf(id)))} · <span class="chip">${h(groupName(ex.group))}</span></p>
    <div class="card"><b>Primary</b><div>${chips(ex.primary || [])}</div>
      ${ex.secondary?.length ? `<b>Secondary</b><div class="sec">${chips(ex.secondary)}</div>` : ''}</div>
    ${ex.review ? `<div class="card warn"><b>⚠️ Trainer sheet check</b><p><small>Sheet says: ${h(ex.sheet)}</small></p><p>${h(ex.review)}</p></div>` : ''}
    ${ex.breath ? `<div class="card"><b>🫁 Breathing</b><p>${h(ex.breath)}</p>
      <p><small>Rule of thumb: breathe out on the effort, in on the way back. Never hold your breath through a rep. If you lose the rhythm, slow the rep down to match your breath.</small></p></div>` : ''}
    ${ex.tips?.length ? `<div class="card"><b>Coaching tips</b><ul>${ex.tips.map(t => `<li>${h(t)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><label><b>My notes</b><textarea data-f="exnote" data-ex="${id}" rows="2" placeholder="Machine settings, seat height, what to watch…">${h(noteOf(id))}</textarea></label></div>
    <h2>Progress</h2>
    ${m ? `<div class="card"><b>${m.label}${m.unit ? ` (${m.unit})` : ''}</b>${chart(pts, m.unit)}
      ${m.unit === 'kg' ? `<b>Volume (kg × reps)</b>${chart(vol, 'kg')}` : ''}</div>
    <div class="list">${[...hist].reverse().map(x => `<a href="#/s/${x.s.id}"><span>${fmtD(x.s.start)}</span><b>${h(fmtSets(x.sets, ex))}</b>${x.it.note ? `<small>${h(x.it.note)}</small>` : ''}</a>`).join('')}</div>`
      : '<p class="muted">No history yet.</p>'}`;
}

function vProgress() {
  const rows = CATALOG.exercises.map(ex => ({ ex, hist: exHistory(ex.id) })).filter(r => r.hist.length)
    .sort((a, b) => b.hist.at(-1).s.start - a.hist.at(-1).s.start);
  const visits = S.sessions.filter(s => s.end);
  const weekAgo = Date.now() - 7 * 864e5, monthAgo = Date.now() - 30 * 864e5;
  let o = `<h1>Progress</h1><div class="stats">
    <div><b>${visits.length}</b><small>visits</small></div>
    <div><b>${visits.filter(s => s.start > weekAgo).length}</b><small>last 7 days</small></div>
    <div><b>${visits.filter(s => s.start > monthAgo).length}</b><small>last 30 days</small></div></div>`;
  if (!rows.length) return o + '<p class="muted">No logged sets yet.</p>';
  o += vBalance();
  o += '<div class="list">';
  for (const { ex, hist } of rows) {
    const m = metricKind(hist.flatMap(x => x.sets));
    const f = metricOf(hist[0].sets, m), l = metricOf(hist.at(-1).sets, m), d = l - f;
    o += `<a href="#/ex/${ex.id}"><b>${h(ex.name)}</b><span>${fmtN(f)} → ${fmtN(l)} ${m.unit || (ex.kind === 'hold' ? 's total' : 'reps total')}
      ${d ? `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmtN(Math.abs(d))}</span>` : ''}</span>
      <small>${hist.length} visit${hist.length > 1 ? "s" : ""} · last ${fmtD(hist.at(-1).s.start)}</small></a>`;
  }
  return o + '</div>';
}

// sets per muscle over the last 4 weeks: primary muscles count 1 per set, secondary 0.5
function vBalance() {
  const st = groupStats(), since = Date.now() - 28 * 864e5, mus = {};
  for (const s of S.sessions) if (s.start > since) for (const it of s.items) {
    const n = doneSets(it).length, ex = exOf(it.ex);
    (ex.primary || []).forEach(m => { mus[m] = (mus[m] || 0) + n; });
    (ex.secondary || []).forEach(m => { mus[m] = (mus[m] || 0) + n / 2; });
  }
  const gmax = Math.max(1, ...Object.values(st).map(x => x.m));
  const ms = Object.entries(mus).sort((a, b) => b[1] - a[1]), mmax = Math.max(1, ...ms.map(x => x[1]));
  const bar = (label, v, max, extra = '') => `<div class="bar"><span>${h(label)}</span><i style="width:${100 * v / max}%"></i><b>${fmtN(v)}</b>${extra}</div>`;
  return `<h2>Balance (last 4 weeks)</h2><div class="card bars"><small>Sets per muscle group</small>
    ${CATALOG.groups.map(g => bar(g.name.replace(/ \(.*/, ''), st[g.id]?.m || 0, gmax)).join('')}
    <details><summary><small>Per muscle (secondary = ½ set)</small></summary>${ms.map(([m, v]) => bar(m, v, mmax)).join('')}</details></div>`;
}

function vTargets() {
  const log = S.targetLog.slice(-20).reverse();
  return `<h1>Targets</h1>
    <p class="muted">Your current prescription per exercise. Bump it as you progress (or accept the 📈 suggestions during a visit).</p>
    ${byGroup().map(g => `<h2>${h(g.name)}</h2>${g.ex.map(ex => {
      const t = targetOf(ex.id);
      const f = (k, label, v) => `<label><small>${label}</small><input type="text" inputmode="decimal" data-f="target" data-ex="${ex.id}" data-k="${k}" value="${v ?? ''}" placeholder="–"></label>`;
      return `<div class="card" id="t-${ex.id}"><div class="row"><a href="#/ex/${ex.id}"><b>${h(ex.name)}</b></a>
        ${hasOverride(ex.id) ? `<button class="btn sm ghost" data-a="resettarget" data-ex="${ex.id}">reset to trainer's</button>` : ''}</div>
        <div class="tgrid">${f('sets', 'sets', t.sets)}${f('reps', ex.kind === 'hold' ? 'seconds' : (ex.perSide ? 'reps/side' : 'reps'), t.reps)}${f('load', 'kg', fmtN(t.load))}${f('rest', 'rest s', t.rest)}</div></div>`;
    }).join('')}`).join('')}
    ${log.length ? `<h2>Target changes</h2><div class="list">${log.map(l => `<div><span>${fmtD(l.t)}</span><b>${h(exOf(l.ex).name)}</b><small>${h(l.k)}: ${fmtN(l.from) || '–'} → ${fmtN(l.to) || '–'}</small></div>`).join('')}</div>` : ''}`;
}

const TOKEN_HELP = `<li>Create a <b>fine-grained token</b> at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>:
      Repository access → <i>Only select repositories</i> → just that repo; Permissions → Repository → <i>Contents: Read and write</i>. Nothing else.
      Pick an expiration (when it expires, sync stops until you paste a new token).</li>`;

function vSettings() {
  if (VIEW) return `<h1>Data</h1><p class="muted">You're viewing someone else's log. Exit the view (banner above) to get back to your own data and sync settings.</p>`;
  const bytes = JSON.stringify(S).length, c = SY.cfg;
  const shareUrl = c ? `${appUrl()}#/view/${repoPath(c)}` : '';
  return `<h1>Data & sync</h1>
    <div class="card"><h3>☁️ Sync</h3>
    ${c ? `<p>Syncing with <a href="https://github.com/${h(c.repo)}/blob/HEAD/${h(c.path)}" target="_blank" rel="noopener">${h(repoPath(c))}</a> on GitHub.<br>
        <small id="syncstatus">${syncStatusHtml()}</small></p>
        <p><button class="btn sm" data-a="sync-now">Sync now</button>
        <button class="btn sm ghost danger" data-a="disconnect">Disconnect</button></p>
        <p><b>📱 Add another device:</b> <button class="btn sm" data-a="device-qr">Show QR code</button><br>
        <small>Scan it with the other device's camera to connect it to the same log.</small></p>
        <div id="qr-out"></div>
        <p><b>Share read-only</b> (e.g. with your trainer):<br><input type="text" readonly value="${h(shareUrl)}" class="note">
        <button class="btn sm" data-a="copy" data-text="${h(shareUrl)}" data-what="Share link">Copy share link</button><br>
        <small>Works for anyone if the repo is public. For a private repo, the viewer needs their own GitHub access to it.</small></p>`
      : `<p>Keep your log in a GitHub repo: syncs between your devices, keeps full history, and lets you share a read-only link (e.g. with your trainer).
        <b>Got a link from your trainer?</b> Just open it on this device.</p>
        <p><small>📱 Tip: do the setup below on a computer (easy to paste the token). Then this tab there shows <i>Add another device</i> with a QR code for your phone.</small></p>
        <details><summary>Set it up yourself (≈2 min, needs a GitHub account)</summary><ol>
          <li>Create a repo, e.g. <i>gym-data</i> at <a href="https://github.com/new" target="_blank" rel="noopener">github.com/new</a>: <b>public</b> to share without logins, <b>private</b> otherwise.</li>
          ${TOKEN_HELP}
          <li>Fill in:</li></ol>
          <label>Repo <input id="c-repo" class="note" placeholder="yourname/gym-data" autocapitalize="off" autocomplete="off"></label>
          <label>Token <input id="c-token" class="note" type="password" placeholder="github_pat_…" autocomplete="off"></label>
          <label>File <input id="c-path" class="note" value="gym.json" autocapitalize="off"></label>
          <p><button class="btn" data-a="connect-form">Connect</button></p></details>`}
    </div>
    <div class="card"><h3>👀 View someone's log</h3>
      <label><input id="v-repo" class="note" placeholder="share link, or owner/repo" autocapitalize="off"></label>
      <p><button class="btn sm" data-a="view-open">Open read-only</button></p>
      <details><summary><small>Private repos</small></summary>
        <label><small>GitHub token with read access (e.g. a trainer's token covering all client repos). Stored in this browser.</small>
        <input id="v-token" class="note" type="password" placeholder="${lsGet(VTOKEN_KEY) ? '(saved; paste to replace, clear to remove)' : 'github_pat_…'}" autocomplete="off"></label>
        <p><button class="btn sm ghost" data-a="vtoken-save">Save viewing token</button></p></details></div>
    <div class="card"><h3>🏋️ Trainer: set up a client</h3>
      <details><summary>Give a client sync without them needing GitHub</summary><ol>
        <li>Create one <b>private</b> repo per client, e.g. <i>gym-anna</i>, at <a href="https://github.com/new" target="_blank" rel="noopener">github.com/new</a>.</li>
        ${TOKEN_HELP.replace('just that repo', "just that client's repo")}
        <li>Generate the client's link here and send it privately (anyone with it can edit that client's log). They open it once on each device.</li></ol>
        <label>Client repo <input id="t-repo" class="note" placeholder="you/gym-anna" autocapitalize="off" autocomplete="off"></label>
        <label>Token <input id="t-token" class="note" type="password" placeholder="github_pat_…" autocomplete="off"></label>
        <p><button class="btn sm" data-a="client-link">Make link</button></p>
        <div id="t-out"></div></details></div>
    <div class="card"><h3>💾 Backup</h3><p><small>This browser holds ${(bytes / 1024).toFixed(1)} kB of log data.</small></p>
      <p><button class="btn sm" data-a="export">Export backup (JSON)</button>
      <label class="btn sm ghost">Import backup<input type="file" accept="application/json,.json" id="import" hidden></label></p>
      <p><button class="btn sm ghost danger" data-a="reset">Erase all data in this browser</button></p></div>
    <h2>Trainer sheets</h2>
    ${CATALOG.plans.filter(p => p.sheet).map(p => `<a href="${h(p.sheet)}" target="_blank"><img class="hero" src="${h(p.sheet)}" alt="${h(p.name)}"></a>`).join('')}`;
}

function validateBackup(d) {
  const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
  const bad = m => { throw new Error('not a valid gym backup: ' + m); };
  if (!isObj(d) || !Array.isArray(d.sessions)) bad('missing sessions');
  for (const s of d.sessions) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.start !== 'number' || !Array.isArray(s.items)) bad('bad session');
    for (const it of s.items) {
      if (!isObj(it) || typeof it.ex !== 'string' || !isObj(it.target) || !Array.isArray(it.sets)) bad('bad session item');
      if (!it.sets.every(isObj)) bad('bad set');
    }
  }
  for (const k of ['targets', 'notes', 'deleted']) if (d[k] != null && !isObj(d[k])) bad(k);
  if (d.targetLog != null && !Array.isArray(d.targetLog)) bad('targetLog');
}

// ---------- router ----------
let elapsedIv, pendingScroll = null;
function render() {
  const parts = (location.hash || '#/').slice(2).split('/');
  if (parts[0] === 'connect') { connectFromHash(parts.slice(1)); return; }
  if (parts[0] === 'view') { enterView(parts.slice(1)); return; }
  const [, route, arg] = (location.hash || '#/').split('/');
  const main = $('#main');
  let html, sid = null;
  if (route === 's') { html = vSession(arg); sid = arg; }
  else if (route === 'ex') html = vExercise(arg);
  else if (route === 'targets') html = vTargets();
  else if (route === 'progress') html = vProgress();
  else if (route === 'data') html = vSettings();
  else html = vHome();
  main.dataset.sid = sid || '';
  if (VIEW) html = `<div class="card viewbar">👀 Viewing <b>${h(repoPath(VIEW))}</b> (read-only)<br><small>loaded ${fmtT(VIEW.at)}</small>
    <div><button class="btn sm" data-a="view-refresh" data-ro>Refresh</button>
    <button class="btn sm ghost" data-a="view-copy" data-ro>Copy into my browser</button>
    <button class="btn sm ghost" data-a="view-exit" data-ro>Exit</button></div></div>` + html;
  main.innerHTML = html;
  document.body.classList.toggle('ro', !!VIEW);
  if (VIEW) main.querySelectorAll('input, textarea, select, button').forEach(el => { if (!el.hasAttribute('data-ro')) el.disabled = true; });
  syncBadge();
  if (route === 'targets' && arg) document.getElementById('t-' + arg)?.scrollIntoView();
  if (pendingScroll) { document.getElementById(pendingScroll)?.scrollIntoView({ block: 'start' }); pendingScroll = null; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + (route || '')));
  $('#nav .dot').hidden = !S.active;
  const s = sid && sess(sid);
  wantWake(!!(s && !s.end && !VIEW));
  clearInterval(elapsedIv);
  if (s && !s.end) {
    const upd = () => { const e = $('#elapsed'); if (e) e.textContent = dur(Date.now() - s.start); };
    upd(); elapsedIv = setInterval(upd, 30000);
  }
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function rerender() { const y = scrollY; render(); scrollTo(0, y); }

// ---------- actions ----------
const cur = () => sess($('#main').dataset.sid);
const actions = {
  pick: b => pickExercise(b.dataset.ex),
  addpartner: b => {
    const s = cur(), i = +b.dataset.i;
    const tagOrder = CATALOG.exercises.filter(e => e.ss === s.items[i].ss).map(e => e.id);
    const at = tagOrder.indexOf(b.dataset.ex) < tagOrder.indexOf(s.items[i].ex) ? i : i + 1;
    s.items.splice(at, 0, mkItem(b.dataset.ex));
    save(); rerender(); toast('Superset: no rest between the two');
  },
  tick: b => {
    const s = cur(), i = +b.dataset.i, it = s.items[i], x = it.sets[+b.dataset.j];
    x.done = !x.done;
    if (x.done) {
      if (x.w == null && it.target.load != null) x.w = it.target.load;
      if (x.r == null) x.r = it.target.reps;
      x.at = Date.now();
      const nx = s.items[i + 1];
      if (!s.end) {
        // superset: go straight to the partner while it still owes a set for this round
        if (it.ss && nx?.ss === it.ss && doneSets(nx).length < doneSets(it).length && nx.sets.some(y => !y.done)) toast(`Superset → ${exOf(nx.ex).name}`);
        else if (x === it.sets.at(-1) || it.sets.every(y => y.done)) { toast('Exercise done 💪'); startRest(it.target.rest); }
        else startRest(it.target.rest);
      }
    }
    save(); rerender();
  },
  addset: b => {
    const it = cur().items[+b.dataset.i], last = it.sets.at(-1);
    it.sets.push({ w: last?.w ?? null, r: null, done: false }); save(); rerender();
  },
  rmset: b => { const it = cur().items[+b.dataset.i]; if (it.sets.length) it.sets.pop(); save(); rerender(); },
  up: b => {
    const s = cur(), i = +b.dataset.i;
    if (i > 0) { [s.items[i - 1], s.items[i]] = [s.items[i], s.items[i - 1]]; save(); rerender(); }
  },
  rmitem: b => {
    const s = cur(), i = +b.dataset.i;
    if (confirm(`Remove ${exOf(s.items[i].ex).name} from this session?`)) { s.items.splice(i, 1); save(); rerender(); }
  },
  apply: b => {
    const s = cur(), it = s.items[+b.dataset.i], k = b.dataset.k, v = +b.dataset.v;
    if (EX[it.ex]) setTarget(it.ex, k, v);
    if (!s.end) it.target[k] = v;
    save(); rerender(); toast('Target updated');
  },
  finish: () => {
    const s = cur();
    if (!s.items.some(i => doneSets(i).length)) {
      if (confirm('Nothing logged in this visit. Discard it?')) {
        deleteSession(s); rest = null; tickRest(); save(); go('#/');
      }
      return;
    }
    const open = s.items.flatMap(i => i.sets).filter(x => !x.done).length;
    if (open && !confirm(`${open} set(s) not ticked. They won't count. Finish anyway?`)) return;
    s.end = Date.now(); S.active = null; rest = null; tickRest();
    save(); syncNow(true); scrollTo(0, 0); render(); toast('Visit saved. Nice work!');
  },
  del: () => {
    const s = cur();
    if (!confirm('Delete this session permanently?')) return;
    if (S.active === s.id) { rest = null; tickRest(); }
    deleteSession(s);
    save(); go('#/');
  },
  'sync-now': () => { SY.err = null; syncNow(); },
  disconnect: () => {
    if (!confirm(`Stop syncing with ${repoPath(SY.cfg)}? Your data stays in this browser and on GitHub.`)) return;
    bumpGen(); clearTimeout(SY.timer); SY.cfg = null; SY.err = null; syncCfgSave(); render();
  },
  'connect-form': () => connectTo({ repo: $('#c-repo').value.trim(), token: $('#c-token').value.trim(), path: $('#c-path').value.trim() || 'gym.json' }),
  copy: b => copyText(b.dataset.text, b.dataset.what),
  'view-open': () => {
    const v = $('#v-repo').value.trim(), m = v.match(/#\/view\/(.+)$/);
    const rp = (m ? m[1] : v.replace(/^https:\/\/github\.com\//, '')).replace(/\/+$/, '');
    location.hash = '#/view/' + rp;
  },
  'vtoken-save': () => {
    const t = $('#v-token').value.trim();
    if (t && !/^[A-Za-z0-9_]{20,255}$/.test(t)) { toast("That doesn't look like a GitHub token"); return; }
    lsSet(VTOKEN_KEY, t || null); toast(t ? 'Viewing token saved' : 'Viewing token removed'); render();
  },
  'client-link': () => {
    const repo = $('#t-repo').value.trim(), token = $('#t-token').value.trim();
    if (!validRepo(repo) || !/^[A-Za-z0-9_]{20,255}$/.test(token)) { toast('Enter owner/repo and a GitHub token'); return; }
    const link = connectLink({ repo, token, path: 'gym.json' });
    $('#t-out').innerHTML = `<p><input type="text" readonly class="note" value="${h(link)}">
      <button class="btn sm" data-a="copy" data-text="${h(link)}" data-what="Client link">Copy client link</button>
      <button class="btn sm ghost" data-a="client-qr" data-text="${h(link)}">Show QR</button><br>
      <small>Secret: whoever has it can edit this client's log. Send it privately, or let the client scan the QR in person.</small></p>
      <div id="t-qr"></div>`;
  },
  'device-qr': () => showQr($('#qr-out'), connectLink(SY.cfg), SECRET_NOTE),
  'client-qr': b => showQr($('#t-qr'), b.dataset.text, SECRET_NOTE),
  'hide-qr': b => { b.closest('#qr-out, #t-qr').innerHTML = ''; },
  'view-refresh': () => { location.hash = '#/view/' + repoPath(VIEW); },
  'view-exit': () => { exitView(); go('#/'); },
  'view-copy': () => {
    const who = repoPath(VIEW);
    if (!confirm(SY.cfg ? `Replace this browser's own log with a copy of ${who}?\nThis browser syncs with ${repoPath(SY.cfg)}, so the copy will be merged into that log.`
      : `Replace this browser's own log with a copy of ${who}?\n(Export a backup first if you need your current data.)`)) return;
    const copy = normalize(syncPart(S));
    exitView();
    bumpGen(); S = copy; S.active = null; resnap(); store.save(S); markDirty();
    go('#/'); toast(`Copied ${who} into this browser`);
  },
  resettarget: b => { S.targets[b.dataset.ex] = { u: nextU(S.targets[b.dataset.ex]?.u) }; save(); rerender(); },
  'rest-add': () => { if (rest) { rest.end += 15000; rest.total += 15; tickRest(); } },
  'rest-skip': () => { rest = null; tickRest(); },
  export: () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `gym-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  reset: () => {
    if (confirm('Erase ALL sessions and settings from this browser?') && confirm('Really? This cannot be undone.')) {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } S = store.load(); resnap(); go('#/');
    }
  },
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (b && actions[b.dataset.a]) { e.preventDefault(); actions[b.dataset.a](b, e); }
});
document.addEventListener('input', e => {
  const el = e.target, f = el.dataset.f;
  if (f === 'set') {
    const x = cur().items[+el.dataset.i].sets[+el.dataset.j];
    x[el.dataset.k] = num(el.value);
  } else if (f === 'inote') cur().items[+el.dataset.i].note = el.value;
  else if (f === 'snote') cur().note = el.value;
  else if (f === 'exnote') S.notes[el.dataset.ex] = { t: el.value, u: nextU(S.notes[el.dataset.ex]?.u) };
  else return;
  save();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.f === 'target') {
    const v = num(el.value), k = el.dataset.k;
    const ok = k === 'load' ? (v == null || (isFinite(v) && v >= 0 && v < 1000))
      : Number.isInteger(v) && v >= (k === 'rest' ? 0 : 1) && v <= { sets: 20, reps: 999, rest: 900 }[k];
    if (!ok) { toast(k === 'load' ? 'Enter a weight in kg (or leave empty)' : `Enter a whole number for ${k}`); rerender(); return; }
    setTarget(el.dataset.ex, k, v); save(); toast('Target saved');
  } else if (el.id === 'addex' && el.value) {
    const s = cur(), ex = exOf(el.value);
    s.items.push(mkItem(ex.id));
    save(); rerender(); toast(`${ex.name} added`);
  } else if (el.id === 'import' && el.files[0]) {
    el.files[0].text().then(t => {
      const d = JSON.parse(t);
      validateBackup(d);
      if (!confirm(`Replace current data with backup (${d.sessions.length} sessions)?`)) return;
      S = migrate(Object.assign(emptyState(), { v: 1 }, d));
      if (S.active && typeof S.active !== 'string') S.active = null;
      if (S.active && !sess(S.active)) S.active = null;
      resnap(); save(); go('#/');
      toast('Backup imported');
    }).catch(err => alert('Import failed: ' + err.message));
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    tickRest();
    if (!document.activeElement?.matches('input,textarea')) rerender();
    // pick up other devices' changes (a download: no commit); upload only if edits have idled long enough
    if (SY.cfg && (Date.now() - (SY.cfg.last || 0) > 60000 || idleLongEnough())) syncNow(!!idleLongEnough());
  }
});
window.addEventListener('online', () => syncNow(!!idleLongEnough()));
document.addEventListener('focusout', () => { if (SY.pendingApply) scheduleSync(300, false); });
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });  // render() applies pendingScroll
window.addEventListener('storage', e => { if (e.key === KEY && !VIEW) { S = store.load(); resnap(); rerender(); } });
render();
if (SY.cfg && !VIEW) syncNow(!!SY.cfg.dirty);
// fresh app files when online, cached copy when offline (see sw.js)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* e.g. file:// */ });   // on start: download; upload what an earlier run left unsynced
