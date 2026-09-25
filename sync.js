'use strict';
// Sync building blocks, no UI: state merging + a tiny GitHub "contents API" client.
//
// Data model for merging (see mergeStates):
//  - sessions: union by id; the copy with the larger `u` (last-modified ms) wins.
//  - deleted: tombstones {sessionId: deletedAt}; a session is dropped if deleted at/after its `u`.
//  - targets / notes: per exercise id, the entry with the larger `u` wins.
//  - targetLog: append-only, union.
//  - `active` (the visit running on this device) is device-local and never synced.
//
// Remote storage: one JSON file in a GitHub repo, written through the contents API. Writes carry
// the sha of the version they replace; GitHub rejects stale writes (409), so we re-read, merge and
// retry: concurrent devices never overwrite each other.

const SYNC_FORMAT = 'gym-log';

// the part of the state that is shared between devices
function syncPart(s) {
  return { format: SYNC_FORMAT, v: s.v, sessions: s.sessions, deleted: s.deleted, targets: s.targets, targetLog: s.targetLog, notes: s.notes };
}

const sessU = s => s.u || s.end || s.start || 0;
// deterministic winner: newer revision, ties broken by content, so merge(a,b) == merge(b,a)
function newer(x, y, ux, uy) {
  if (ux !== uy) return ux > uy;
  return canon(x) > canon(y);
}
// next revision for something last revised at `prev`: never goes backwards, even if `prev` came
// from a device whose clock runs ahead
const nextU = prev => Math.max(Date.now(), (prev || 0) + 1);

function mergeStates(a, b) {
  const deleted = { ...(a.deleted || {}) };
  for (const [id, t] of Object.entries(b.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, t);
  const byId = new Map();
  for (const s of [...(a.sessions || []), ...(b.sessions || [])]) {
    const cur = byId.get(s.id);
    if (!cur || newer(s, cur, sessU(s), sessU(cur))) byId.set(s.id, s);
  }
  const sessions = [...byId.values()].filter(s => !((deleted[s.id] || 0) >= sessU(s))).sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1));
  const lww = (x = {}, y = {}) => {
    const r = { ...x };
    for (const [k, v] of Object.entries(y)) if (!r[k] || newer(v, r[k], v.u || 0, r[k].u || 0)) r[k] = v;
    return r;
  };
  const seen = new Set();
  const targetLog = [...(a.targetLog || []), ...(b.targetLog || [])].filter(l => {
    const k = `${l.t}|${l.ex}|${l.k}|${l.to}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((x, y) => x.t - y.t);
  return { ...a, sessions, deleted, targets: lww(a.targets, b.targets), notes: lww(a.notes, b.notes), targetLog };
}

// JSON with sorted object keys: stable text for comparisons and readable git diffs
function canon(x, indent) {
  return JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : v, indent);
}

function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

// ---------- GitHub contents API ----------
// cfg: { repo: 'owner/name', path: 'gym.json', token?: string }
const GH_API = 'https://api.github.com';
const validRepo = r => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r || '');
const validPath = p => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p || '') && !/(^|\/)\.\.?(\/|$)/.test(p);

class SyncError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

function ghHeaders(token) {
  const hd = { Accept: 'application/vnd.github+json' };
  if (token) hd.Authorization = `Bearer ${token}`;
  return hd;
}
const ghUrl = cfg => `${GH_API}/repos/${cfg.repo}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;

async function ghError(r, what) {
  let msg = '';
  try { msg = (await r.json()).message || ''; } catch (e) { /* ignore */ }
  if (r.status === 401) return new SyncError(`${what}: the token is invalid or expired`, 401);
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') return new SyncError(`${what}: GitHub rate limit hit, try again later`, 403);
  if (r.status === 403) return new SyncError(`${what}: the token has no write access to this repo (${msg})`, 403);
  if (r.status === 404) return new SyncError(`${what}: repo not found, or no access with this token`, 404);
  return new SyncError(`${what}: GitHub said ${r.status} ${msg}`, r.status);
}

// -> { sha, data } or null if the file doesn't exist yet
async function ghRead(cfg) {
  let r;
  try { r = await fetch(ghUrl(cfg), { headers: ghHeaders(cfg.token), cache: 'no-store' }); }
  catch (e) { throw new SyncError('Offline or GitHub unreachable', 0); }
  if (r.status === 404) {
    // missing file vs. missing repo/access: ask about the repo itself
    const rr = await fetch(`${GH_API}/repos/${cfg.repo}`, { headers: ghHeaders(cfg.token), cache: 'no-store' }).catch(() => null);
    if (rr && rr.ok) return null;
    throw await ghError(r, 'Read');
  }
  if (!r.ok) throw await ghError(r, 'Read');
  const j = await r.json();
  let b64 = j.content;
  if (!b64 && j.encoding === 'none' && j.git_url) { // > 1 MB: fetch the blob instead
    const br = await fetch(j.git_url, { headers: ghHeaders(cfg.token), cache: 'no-store' });
    if (!br.ok) throw await ghError(br, 'Read');
    b64 = (await br.json()).content;
  }
  let data;
  try { data = JSON.parse(b64dec(b64 || '')); } catch (e) { throw new SyncError('The file on GitHub is not valid JSON', 0); }
  if (!data || data.format !== SYNC_FORMAT) throw new SyncError(`${cfg.path} in ${cfg.repo} is not a gym log`, 0);
  return { sha: j.sha, data };
}

// -> { sha } on success, { conflict: true } if the file changed since `sha`
async function ghWrite(cfg, data, sha, message) {
  const body = { message, content: b64enc(canon(data, 1) + '\n') };
  if (sha) body.sha = sha;
  let r;
  try {
    r = await fetch(ghUrl(cfg), { method: 'PUT', headers: { ...ghHeaders(cfg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new SyncError('Offline or GitHub unreachable', 0); }
  if (r.status === 409 || (r.status === 422 && !sha)) return { conflict: true };
  if (!r.ok) throw await ghError(r, 'Write');
  return { sha: (await r.json()).content.sha };
}

// ---------- schema sanitizer ----------
// Everything loaded from outside (GitHub, someone's shared log, backup files, even our own storage)
// goes through this: unknown fields are dropped, ids must be plain tokens, numbers must be numbers.
// Together with HTML escaping at render time this keeps a malicious log from injecting markup.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const numOr = (v, d = null) => (typeof v === 'number' && isFinite(v) ? v : d);
const strOr = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
function sanitizeTarget(t) {
  const o = {};
  if (!isObj(t)) return o;
  for (const k of ['sets', 'reps', 'load', 'rest', 'u']) if (k in t) o[k] = numOr(t[k]);
  return o;
}
function sanitizeState(x) {
  const out = { v: numOr(x.v, 3), active: typeof x.active === 'string' && ID_RE.test(x.active) ? x.active : null };
  out.sessions = (Array.isArray(x.sessions) ? x.sessions : []).filter(s => isObj(s) && ID_RE.test(s.id) && numOr(s.start) !== null).map(s => {
    const o = { id: s.id, start: s.start, end: numOr(s.end), note: strOr(s.note), items: [] };
    if (numOr(s.u) !== null) o.u = s.u;
    if (typeof s.name === 'string') o.name = strOr(s.name, 100);
    o.items = (Array.isArray(s.items) ? s.items : []).filter(it => isObj(it) && ID_RE.test(it.ex)).map(it => ({
      ex: it.ex, ss: typeof it.ss === 'string' && ID_RE.test(it.ss) ? it.ss : '', note: strOr(it.note),
      target: { sets: 3, reps: 10, load: null, rest: 90, ...sanitizeTarget(it.target) },
      sets: (Array.isArray(it.sets) ? it.sets : []).filter(isObj).slice(0, 50).map(z => {
        const q = { w: numOr(z.w), r: numOr(z.r), done: z.done === true };
        if (numOr(z.at) !== null) q.at = z.at;
        return q;
      }),
    }));
    return o;
  });
  const idMap = (m, f) => Object.fromEntries(Object.entries(isObj(m) ? m : {}).filter(([k]) => ID_RE.test(k)).map(([k, v]) => [k, f(v)]).filter(([, v]) => v !== undefined));
  out.deleted = idMap(x.deleted, v => numOr(v) ?? undefined);
  out.targets = idMap(x.targets, v => (isObj(v) ? sanitizeTarget(v) : undefined));
  out.notes = idMap(x.notes, v => (typeof v === 'string' ? { t: strOr(v), u: 0 } : isObj(v) ? { t: strOr(v.t), u: numOr(v.u, 0) } : undefined));
  out.targetLog = (Array.isArray(x.targetLog) ? x.targetLog : []).filter(l => isObj(l) && ID_RE.test(l.ex) && ['sets', 'reps', 'load', 'rest'].includes(l.k) && numOr(l.t) !== null)
    .map(l => ({ t: l.t, ex: l.ex, k: l.k, from: numOr(l.from), to: numOr(l.to) }));
  return out;
}
