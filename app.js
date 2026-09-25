'use strict';
// Gym log: all state in localStorage (see store below). Exercises and plans come from catalog.js.

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
function emptyState() { return { v: 2, sessions: [], active: null, targets: {}, targetLog: [], notes: {}, draft: [] }; }
function migrate(s) {
  if ((s.v || 1) < 2) { // v1 keyed targets by `${planId}:${exId}`; v2 keys by exercise id
    const strip = k => k.includes(':') ? k.split(':')[1] : k;
    s.targets = Object.fromEntries(Object.entries(s.targets || {}).map(([k, v]) => [strip(k), v]));
    (s.targetLog || []).forEach(l => { l.ex = strip(l.key || ''); delete l.key; });
    s.v = 2;
  }
  s.draft ||= [];
  return s;
}
let S = store.load();
const save = () => store.save(S);

// ---------- catalog access ----------
const EX = Object.fromEntries(CATALOG.exercises.map(e => [e.id, e]));
const exOf = id => EX[id] || { id, name: id + ' (removed)', primary: [], secondary: [], tips: [], kind: 'reps', loadType: 'kg', step: 2.5 };
const plan = id => CATALOG.plans.find(p => p.id === id);
const groupName = id => CATALOG.groups.find(g => g.id === id)?.name || 'Other';
const targetOf = exId => ({ sets: 3, reps: 10, load: null, rest: 90, ...(EX[exId]?.target || {}), ...(S.targets[exId] || {}) });
function setTarget(exId, k, v) {
  const cur = targetOf(exId);
  if (cur[k] === v) return;
  S.targets[exId] = { ...(S.targets[exId] || {}), [k]: v };
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
function history(exId, exceptSid) {
  return S.sessions.filter(s => s.end && s.id !== exceptSid).sort((a, b) => a.start - b.start)
    .flatMap(s => s.items.filter(i => i.ex === exId).map(i => ({ s, it: i, sets: doneSets(i) })))
    .filter(x => x.sets.length);
}
const lastPerf = (exId, exceptSid) => history(exId, exceptSid).at(-1);
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
function startSession(exIds) {
  if (S.active && sess(S.active)) { go('#/s/' + S.active); return; }
  exIds = exIds.filter(id => EX[id]);
  // keep superset partners adjacent
  const order = [];
  for (const id of exIds) {
    if (order.includes(id)) continue;
    const tag = EX[id].ss; // whole superset group goes here, in catalog order
    if (tag) CATALOG.exercises.filter(e => e.ss === tag && exIds.includes(e.id)).forEach(e => order.push(e.id));
    else order.push(id);
  }
  const p = CATALOG.plans.find(p => p.ex.length === order.length && p.ex.every(e => order.includes(e)));
  const groups = [...new Set(order.map(id => EX[id].group))].map(g => groupName(g).split(' ')[0]);
  const s = {
    id: uid(), planId: p?.id || null, name: p ? p.name : (groups.join(' · ') || 'Visit'),
    start: Date.now(), end: null, note: '', items: order.map(mkItem),
  };
  S.sessions.push(s); S.active = s.id; S.draft = []; save(); go('#/s/' + s.id);
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
// balanced pick: least recently done exercise(s) per group; legs get two
function balancedPick() {
  const pick = [];
  for (const g of byGroup()) {
    const n = g.id === 'legs' ? 2 : 1;
    [...g.ex].sort((a, b) => lastDone(a.id) - lastDone(b.id)).slice(0, n).forEach(e => pick.push(e.id));
  }
  return pick;
}

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
  const past = S.sessions.filter(s => s.end).sort((x, y) => y.start - x.start);
  let o = '';
  if (a) {
    const all = a.items.flatMap(i => i.sets), d = all.filter(x => x.done).length;
    o += `<a class="card active" href="#/s/${a.id}"><div class="row"><div><b>${h(a.name)}</b> in progress<br>
      <small>started ${fmtT(a.start)} · ${d}/${all.length} sets</small></div><span class="btn">Resume ›</span></div></a>`;
  } else o += vBuilder();
  o += `<h2>Past visits</h2>`;
  o += past.length ? `<div class="list">${past.slice(0, 30).map(s => {
    const n = s.items.reduce((a, i) => a + doneSets(i).length, 0);
    return `<a href="#/s/${s.id}"><span>${fmtD(s.start)}</span><b>${h(s.name)}</b><small>${n} sets · ${dur(s.end - s.start)}</small></a>`;
  }).join('')}</div>` : '<p class="muted">Nothing yet. Pick some exercises above and start your first visit.</p>';
  return o;
}

function vBuilder() {
  const st = groupStats(), draft = S.draft;
  let o = `<h2>Plan today's visit</h2>
    <div class="presets"><small>Quick fill:</small>
      <button class="btn sm" data-a="balanced" title="least recently done exercises from every muscle group">⚖️ Balanced</button>
      ${CATALOG.plans.map(p => `<button class="btn sm ghost" data-a="preset" data-p="${p.id}">${h(p.name)}</button>`).join('')}
      ${draft.length ? '<button class="btn sm ghost danger" data-a="clear">Clear</button>' : ''}</div>`;
  for (const g of byGroup()) {
    const gs = st[g.id] || { w: 0, m: 0, last: 0 };
    const picked = g.ex.filter(e => draft.includes(e.id)).length;
    const stale = !gs.last || Date.now() - gs.last > 7 * 864e5;
    o += `<div class="card grp ${stale ? 'stale' : ''}">
      <div class="row"><b>${h(g.name)}</b>${picked ? `<span class="chip hi">${picked} picked</span>` : ''}</div>
      <small class="gstat">${gs.w} sets this week · ${Math.round(gs.m / 4 * 10) / 10}/wk avg (4 wk) · last ${ago(gs.last)}${stale ? ' · <b>due</b>' : ''}</small>
      ${g.ex.map(e => {
        const on = draft.includes(e.id);
        return `<label class="pick ${on ? 'on' : ''}"><input type="checkbox" data-f="pick" value="${e.id}" ${on ? 'checked' : ''}>
          ${e.img ? `<img src="${h(e.img)}" alt="" loading="lazy">` : '<span></span>'}
          <span><b>${h(e.name)}</b>${e.ss ? ' <span class="chip ss">superset</span>' : ''}<br>
          <small>${h(targetText(e, targetOf(e.id)))} · ${ago(lastDone(e.id))}</small></span>
          ${on ? `<span class="ord">${draft.indexOf(e.id) + 1}</span>` : ''}</label>`;
      }).join('')}
    </div>`;
  }
  o += `<p><a href="#/targets">🎯 Tweak targets ›</a></p>
    <div class="startbar"><button class="btn big" data-a="start" ${draft.length ? '' : 'disabled'}>
      ${draft.length ? `Start visit · ${draft.length} exercise${draft.length > 1 ? 's' : ''}` : 'Pick exercises to start'}</button></div>`;
  return o;
}

function vSession(id) {
  const s = sess(id);
  if (!s) return '<p>Session not found.</p>';
  const live = !s.end;
  let o = `<div class="shead"><h1>${h(s.name)}</h1><small>${fmtD(s.start)} · ${fmtT(s.start)}${s.end ? '–' + fmtT(s.end) + ' · ' + dur(s.end - s.start) : ' · <span id="elapsed"></span>'}</small></div>`;
  s.items.forEach((it, i) => { o += itemCard(s, it, i); });
  o += `<div class="card"><label>Add exercise ${exSelect('addex')}</label></div>
    <div class="card"><label>Session notes<textarea data-f="snote" rows="2" placeholder="How did it feel? Energy, sleep, pain…">${h(s.note)}</textarea></label></div>`;
  o += live
    ? `<p><button class="btn big" data-a="finish">Finish visit</button></p><p><button class="btn ghost danger" data-a="del">Discard session</button></p>`
    : `<p><button class="btn ghost danger" data-a="del">Delete session</button></p>`;
  return o;
}

function itemCard(s, it, i) {
  const ex = exOf(it.ex), t = it.target, live = !s.end;
  const prev = s.items[i - 1], next = s.items[i + 1];
  const inSS = it.ss && (prev?.ss === it.ss || next?.ss === it.ss);
  const ssTag = inSS ? `<span class="chip ss">Superset ${prev?.ss === it.ss ? 'B' : 'A'}</span>` : '';
  const lp = lastPerf(it.ex, s.id);
  let sug = '';
  const pi = EX[it.ex] ? targetOf(it.ex) : null;
  if (live && lp && hitTarget(lp.sets, t)) {
    sug = `<div class="sug">📈 Last time you hit all ${t.sets}×${t.reps}. Time to progress?
      ${progressOptions(ex, t, lp.sets).map(op => `<button class="btn sm" data-a="apply" data-i="${i}" data-k="${op.k}" data-v="${op.v}">${op.label}</button>`).join('')}</div>`;
  } else if (!live && pi && doneSets(it).length && hitTarget(doneSets(it), pi)) {
    sug = `<div class="sug">✅ All targets hit. Raise the target for next time?
      ${progressOptions(ex, pi, doneSets(it)).map(op => `<button class="btn sm" data-a="apply" data-i="${i}" data-k="${op.k}" data-v="${op.v}">${op.label}</button>`).join('')}</div>`;
  }
  const unit = ex.kind === 'hold' ? 'sec' : (ex.perSide ? 'reps/side' : 'reps');
  const rows = it.sets.map((x, j) => `<div class="set ${x.done ? 'done' : ''}">
      <span class="n">${j + 1}</span>
      <label><input type="text" inputmode="decimal" data-f="set" data-i="${i}" data-j="${j}" data-k="w" value="${fmtN(x.w)}" placeholder="${t.load != null ? fmtN(t.load) : (ex.loadType === 'none' ? '–' : 'BW')}" aria-label="kg"></label>
      <label><input type="text" inputmode="numeric" data-f="set" data-i="${i}" data-j="${j}" data-k="r" value="${x.r ?? ''}" placeholder="${t.reps}" aria-label="${unit}"></label>
      <button class="tick" data-a="tick" data-i="${i}" data-j="${j}" aria-label="done">✓</button></div>`).join('');
  return `<div class="card ex ${inSS ? 'inss' : ''} ${next?.ss && next.ss === it.ss ? 'ssfirst' : ''}">
    <div class="exhead">
      ${ex.img ? `<a href="#/ex/${ex.id}"><img src="${h(ex.img)}" alt="" loading="lazy"></a>` : ''}
      <div><a href="#/ex/${ex.id}"><b>${h(ex.name)}</b></a> ${ssTag}<br>
      <small>${h(ex.detail || '')}</small><br>
      <span class="target">🎯 ${h(targetText(ex, t))}</span></div>
    </div>
    ${lp ? `<div class="last">Last (${fmtDs(lp.s.start)}): ${h(fmtSets(lp.sets, ex))}${lp.it.note ? ` · <i>${h(lp.it.note)}</i>` : ''}</div>` : ''}
    ${S.notes[ex.id] ? `<div class="last">📝 ${h(S.notes[ex.id])}</div>` : ''}
    ${sug}
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
  const hist = history(id);
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
    ${ex.tips?.length ? `<div class="card"><b>Coaching tips</b><ul>${ex.tips.map(t => `<li>${h(t)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><label><b>My notes</b><textarea data-f="exnote" data-ex="${id}" rows="2" placeholder="Machine settings, seat height, what to watch…">${h(S.notes[id] || '')}</textarea></label></div>
    <h2>Progress</h2>
    ${m ? `<div class="card"><b>${m.label}${m.unit ? ` (${m.unit})` : ''}</b>${chart(pts, m.unit)}
      ${m.unit === 'kg' ? `<b>Volume (kg × reps)</b>${chart(vol, 'kg')}` : ''}</div>
    <div class="list">${[...hist].reverse().map(x => `<a href="#/s/${x.s.id}"><span>${fmtD(x.s.start)}</span><b>${h(fmtSets(x.sets, ex))}</b>${x.it.note ? `<small>${h(x.it.note)}</small>` : ''}</a>`).join('')}</div>`
      : '<p class="muted">No history yet.</p>'}`;
}

function vProgress() {
  const rows = CATALOG.exercises.map(ex => ({ ex, hist: history(ex.id) })).filter(r => r.hist.length)
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
    ${CATALOG.groups.map(g => bar(g.name, st[g.id]?.m || 0, gmax)).join('')}
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
        ${S.targets[ex.id] ? `<button class="btn sm ghost" data-a="resettarget" data-ex="${ex.id}">reset to trainer's</button>` : ''}</div>
        <div class="tgrid">${f('sets', 'sets', t.sets)}${f('reps', ex.kind === 'hold' ? 'seconds' : (ex.perSide ? 'reps/side' : 'reps'), t.reps)}${f('load', 'kg', fmtN(t.load))}${f('rest', 'rest s', t.rest)}</div></div>`;
    }).join('')}`).join('')}
    ${log.length ? `<h2>Target changes</h2><div class="list">${log.map(l => `<div><span>${fmtD(l.t)}</span><b>${h(exOf(l.ex).name)}</b><small>${h(l.k)}: ${fmtN(l.from) || '–'} → ${fmtN(l.to) || '–'}</small></div>`).join('')}</div>` : ''}`;
}

function vSettings() {
  const bytes = JSON.stringify(S).length;
  return `<h1>Data</h1>
    <div class="card"><p>Everything is stored in this browser only (${(bytes / 1024).toFixed(1)} kB). Export a backup now and then!</p>
      <p><button class="btn" data-a="export">Export backup (JSON)</button></p>
      <p><label class="btn ghost">Import backup<input type="file" accept="application/json,.json" id="import" hidden></label></p></div>
    <div class="card"><p><button class="btn ghost danger" data-a="reset">Erase all data</button></p></div>
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
  for (const k of ['targets', 'notes']) if (d[k] != null && !isObj(d[k])) bad(k);
  if (d.targetLog != null && !Array.isArray(d.targetLog)) bad('targetLog');
}

// ---------- router ----------
let elapsedIv;
function render() {
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
  main.innerHTML = html;
  if (route === 'targets' && arg) document.getElementById('t-' + arg)?.scrollIntoView();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + (route || '')));
  $('#nav .dot').hidden = !S.active;
  const s = sid && sess(sid);
  wantWake(!!(s && !s.end));
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
  start: () => startSession(S.draft),
  preset: b => { S.draft = [...plan(b.dataset.p).ex]; save(); rerender(); },
  balanced: () => { S.draft = balancedPick(); save(); rerender(); toast('Picked the least recently done per group'); },
  clear: () => { S.draft = []; save(); rerender(); },
  tick: b => {
    const s = cur(), i = +b.dataset.i, it = s.items[i], x = it.sets[+b.dataset.j];
    x.done = !x.done;
    if (x.done) {
      if (x.w == null && it.target.load != null) x.w = it.target.load;
      if (x.r == null) x.r = it.target.reps;
      x.at = Date.now();
      const nx = s.items[i + 1];
      if (!s.end) {
        if (it.ss && nx && nx.ss === it.ss) toast(`Superset → ${exOf(nx.ex).name}`);
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
    const open = s.items.flatMap(i => i.sets).filter(x => !x.done).length;
    if (open && !confirm(`${open} set(s) not ticked. They won't count. Finish anyway?`)) return;
    s.end = Date.now(); S.active = null; rest = null; tickRest();
    save(); scrollTo(0, 0); render(); toast('Visit saved. Nice work!');
  },
  del: () => {
    const s = cur();
    if (!confirm('Delete this session permanently?')) return;
    S.sessions = S.sessions.filter(x => x !== s);
    if (S.active === s.id) S.active = null;
    save(); go('#/');
  },
  resettarget: b => { delete S.targets[b.dataset.ex]; save(); rerender(); },
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
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } S = store.load(); go('#/');
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
  else if (f === 'exnote') { if (el.value.trim()) S.notes[el.dataset.ex] = el.value; else delete S.notes[el.dataset.ex]; }
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
  } else if (el.dataset.f === 'pick') {
    S.draft = S.draft.filter(x => x !== el.value);
    if (el.checked) S.draft.push(el.value);
    save(); rerender();
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
      if (S.active && !sess(S.active)) S.active = null;
      save(); go('#/');
      toast('Backup imported');
    }).catch(err => alert('Import failed: ' + err.message));
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tickRest(); if (!document.activeElement?.matches('input,textarea')) rerender(); }
});
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
window.addEventListener('storage', e => { if (e.key === KEY) { S = store.load(); rerender(); } });
render();
