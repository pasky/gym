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

function mergeStates(a, b) {
  const deleted = { ...(a.deleted || {}) };
  for (const [id, t] of Object.entries(b.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, t);
  const byId = new Map();
  for (const s of [...(a.sessions || []), ...(b.sessions || [])]) {
    const cur = byId.get(s.id);
    if (!cur || sessU(s) > sessU(cur)) byId.set(s.id, s);
  }
  const sessions = [...byId.values()].filter(s => !((deleted[s.id] || 0) >= sessU(s))).sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1));
  const lww = (x = {}, y = {}) => {
    const r = { ...x };
    for (const [k, v] of Object.entries(y)) if (!r[k] || (v.u || 0) > (r[k].u || 0)) r[k] = v;
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
