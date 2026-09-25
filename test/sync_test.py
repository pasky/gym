"""End-to-end sync test against a fake GitHub contents API (no network): python3 test/sync_test.py

Devices are separate browser contexts (separate localStorage). The fake implements what the app
relies on: sha-checked PUTs (409 on stale sha, 422 on missing sha), public vs private repos,
per-token write access, 404s for missing files/repos.
"""
import base64, hashlib, json, os, subprocess, sys, time
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8767
BASE = f'http://localhost:{PORT}/'
TOK = 'github_pat_' + 'A' * 40          # write access to pasky/gym-data
TOK_ANNA = 'github_pat_' + 'B' * 40     # write access to coach/gym-anna (private)
TOK_COACH_RO = 'github_pat_' + 'C' * 40 # read access to coach/gym-anna
BAD = 'github_pat_' + 'Z' * 40


class FakeGitHub:
    def __init__(self):
        self.repos = {'pasky/gym-data': {'private': False, 'files': {}},
                      'coach/gym-anna': {'private': True, 'files': {}}}
        self.write = {TOK: {'pasky/gym-data'}, TOK_ANNA: {'coach/gym-anna'}}
        self.read = {TOK_COACH_RO: {'coach/gym-anna'}}
        self.commits = []
        self.before_put = None   # hook to simulate a concurrent writer

    def file(self, repo, path='gym.json'):
        f = self.repos[repo]['files'].get(path)
        return json.loads(f[1]) if f else None

    def put_raw(self, repo, path, data):   # a "concurrent device" writes behind the app's back
        txt = json.dumps(data)
        self.repos[repo]['files'][path] = (hashlib.sha1(txt.encode()).hexdigest(), txt)

    def handle(self, route):
        req = route.request
        cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, accept',
                'access-control-allow-methods': 'GET, PUT, OPTIONS', 'content-type': 'application/json'}
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=cors)
        def reply(status, obj):
            route.fulfill(status=status, headers=cors, body=json.dumps(obj))
        auth = req.headers.get('authorization', '')
        tok = auth[len('Bearer '):] if auth.startswith('Bearer ') else None
        if tok and tok not in self.write and tok not in self.read:
            return reply(401, {'message': 'Bad credentials'})
        parts = [unquote(p) for p in urlparse(req.url).path.split('/')[1:]]   # repos, o, r, contents, ...
        if parts[0] != 'repos' or len(parts) < 3:
            return reply(404, {'message': 'Not Found'})
        repo = f'{parts[1]}/{parts[2]}'
        r = self.repos.get(repo)
        can_read = r and (not r['private'] or repo in self.write.get(tok, set()) | self.read.get(tok, set()))
        if not can_read:
            return reply(404, {'message': 'Not Found'})
        if len(parts) == 3:
            return reply(200, {'full_name': repo, 'private': r['private']})
        path = '/'.join(parts[4:])
        cur = r['files'].get(path)
        if req.method == 'GET':
            if not cur:
                return reply(404, {'message': 'Not Found'})
            return reply(200, {'sha': cur[0], 'encoding': 'base64', 'content': base64.encodebytes(cur[1].encode()).decode()})
        if req.method == 'PUT':
            if repo not in self.write.get(tok, set()):
                return reply(403 if tok else 401, {'message': 'Resource not accessible'})
            if self.before_put:
                hook, self.before_put = self.before_put, None
                hook()
                cur = r['files'].get(path)
            body = json.loads(req.post_data)
            if cur and not body.get('sha'):
                return reply(422, {'message': '"sha" wasn\'t supplied.'})
            if cur and body['sha'] != cur[0]:
                return reply(409, {'message': f'{path} does not match {body["sha"]}'})
            txt = base64.b64decode(body['content']).decode()
            sha = hashlib.sha1(txt.encode()).hexdigest()
            r['files'][path] = (sha, txt)
            self.commits.append((repo, body['message']))
            return reply(200 if cur else 201, {'content': {'sha': sha}})
        reply(405, {'message': 'nope'})


gh = FakeGitHub()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors, fails = [], []

def check(cond, msg):
    print(('ok    ' if cond else 'FAIL  ') + msg)
    if not cond:
        fails.append(msg)

def device(browser, name):
    ctx = browser.new_context(viewport={'width': 400, 'height': 860})
    ctx.route('https://api.github.com/**', gh.handle)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    pg.on('dialog', lambda d: d.accept())
    return pg

def sync(pg):   # wait for any running sync, run one more, return the error (or None)
    return pg.evaluate("""async () => {
        const idle = async () => { while (SY.busy) await new Promise(r => setTimeout(r, 30)); };
        await idle(); await syncNow(); await idle(); return SY.err; }""")

def state(pg):
    return pg.evaluate("JSON.parse(localStorage['gym.v1'] || 'null')")

def log_visit(pg, ex):
    pg.goto(BASE + '#/'); pg.click(f'[data-a=pick][data-ex={ex}]'); pg.wait_for_selector('#item-0')
    pg.click('[data-a=tick][data-i="0"][data-j="0"]')
    pg.click('[data-a=finish]')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        A, B = device(browser, 'A'), device(browser, 'B')

        print('== connect link')
        A.goto(BASE + f'#/connect/pasky/gym-data/{TOK}')
        A.wait_for_selector('#syncstatus')
        check(TOK not in A.url and A.url.endswith('#/data'), f'token removed from URL ({A.url})')
        check(sync(A) is None, 'A synced without error')
        check(gh.file('pasky/gym-data') is not None, 'log file created in the (empty) repo')
        check(json.loads(A.evaluate("localStorage['gym.sync']"))['token'] == TOK, 'token stored locally')
        check('gym.sync' not in A.evaluate("JSON.stringify(JSON.parse(localStorage['gym.v1']))"), 'token not part of the log data')

        print('== two devices')
        log_visit(A, 'goblet-step-up')
        check(sync(A) is None and len(gh.file('pasky/gym-data')['sessions']) == 1, "A's visit pushed on finish")
        B.goto(BASE + f'#/connect/pasky/gym-data/{TOK}')
        check(sync(B) is None and len(state(B)['sessions']) == 1, "B pulled A's visit")
        log_visit(B, 'lat-pulldown')
        sync(B)
        check(len(gh.file('pasky/gym-data')['sessions']) == 2, 'remote has both visits')
        sync(A)
        check(len(state(A)['sessions']) == 2, 'A merged B\'s visit')
        B.goto(BASE + '#/'); B.wait_for_selector('.list a')
        check(B.locator('.list a').count() == 2, 'B lists both visits')

        print('== concurrent write (409) is merged, not lost')
        def other_device_writes():
            d = gh.file('pasky/gym-data')
            d['sessions'].append({'id': 'zzother', 'start': int(time.time() * 1000) - 5000, 'end': int(time.time() * 1000),
                                  'u': int(time.time() * 1000), 'note': '', 'items': [{'ex': 'face-pull', 'ss': '', 'note': '',
                                  'target': {'sets': 3, 'reps': 12, 'load': 10, 'rest': 90}, 'sets': [{'w': 10, 'r': 12, 'done': True}]}]})
            gh.put_raw('pasky/gym-data', 'gym.json', d)
        gh.before_put = other_device_writes
        log_visit(A, 'kinesis-chest-press')
        check(sync(A) is None, 'A synced despite the conflict')
        ids = [x['id'] for x in gh.file('pasky/gym-data')['sessions']]
        check(len(ids) == 4 and 'zzother' in ids, f'remote has all 4 visits after conflict ({len(ids)})')
        check('zzother' in [x['id'] for x in state(A)['sessions']], 'A got the concurrent visit')

        print('== deletion propagates')
        A.goto(BASE + '#/s/zzother'); A.click('[data-a=del]')
        sync(A); sync(B)
        check('zzother' not in [x['id'] for x in state(B)['sessions']], 'deleted on A -> gone on B')
        check('zzother' in gh.file('pasky/gym-data')['deleted'], 'tombstone stored remotely')
        n_before = len(gh.commits); sync(B)
        check(len(gh.commits) == n_before, 'no-op sync makes no commit')

        print('== targets and notes propagate')
        A.goto(BASE + '#/targets/lat-pulldown')
        A.fill('[data-f=target][data-ex=lat-pulldown][data-k=load]', '40'); A.press('[data-f=target][data-ex=lat-pulldown][data-k=load]', 'Tab')
        A.goto(BASE + '#/ex/lat-pulldown'); A.fill('[data-f=exnote]', 'seat 4')
        A.evaluate('document.activeElement.blur()')
        sync(A); sync(B)
        check(state(B)['targets'].get('lat-pulldown', {}).get('load') == 40, 'target reached B')
        check(state(B)['notes'].get('lat-pulldown', {}).get('t') == 'seat 4', 'note reached B')
        B.goto(BASE + '#/targets'); B.click('[data-a=resettarget][data-ex=lat-pulldown]')
        sync(B); sync(A)
        check('load' not in state(A)['targets'].get('lat-pulldown', {}), 'target reset reached A')

        print('== share link: read-only view')
        V = device(browser, 'V')
        V.goto(BASE + '#/view/pasky/gym-data'); V.wait_for_selector('.viewbar')
        check(V.locator('.list a').count() == 3, 'viewer sees 3 visits')
        V.locator('.list a').first.click(); V.wait_for_selector('.card.ex')
        check(V.locator('.card.ex input:not([disabled])').count() == 0 and V.locator('[data-a=tick]:not([disabled])').count() == 0, 'inputs disabled in view')
        V.reload(); V.wait_for_selector('.viewbar')
        check(True, 'view survives reload')
        check(state(V) is None or not state(V)['sessions'], "viewer's own log untouched")
        V.click('[data-a=view-copy]'); V.wait_for_selector('.list a')
        check(V.locator('.viewbar').count() == 0 and len(state(V)['sessions']) == 3, 'copy into my browser')

        print('== private repo (trainer client)')
        C = device(browser, 'C')   # the client: only has the connect link
        C.goto(BASE + f'#/connect/coach/gym-anna/{TOK_ANNA}')
        check(sync(C) is None, 'client synced to private repo')
        log_visit(C, 'deadbug-hold'); sync(C)
        check(len(gh.file('coach/gym-anna')['sessions']) == 1, "client's visit in their repo")
        V.goto(BASE + '#/view/coach/gym-anna'); V.wait_for_selector('.card.warn')
        check('Could not load' in V.inner_text('.card.warn'), 'private repo not viewable without token')
        V.goto(BASE + '#/data'); V.click('text=Private repos'); V.fill('#v-token', TOK_COACH_RO); V.click('[data-a=vtoken-save]')
        V.goto(BASE + '#/view/coach/gym-anna'); V.wait_for_selector('.viewbar')
        check(V.locator('.list a').count() == 1, 'trainer views client log with read token')
        V.click('[data-a=view-exit]')

        print('== client link generator + bad token')
        V.goto(BASE + '#/data'); V.click('text=Give a client sync'); V.fill('#t-repo', 'coach/gym-anna'); V.fill('#t-token', TOK_ANNA)
        V.click('[data-a=client-link]')
        link = V.input_value('#t-out input')
        check(link == f'{BASE}#/connect/coach/gym-anna/{TOK_ANNA}', 'client link generated')
        X = device(browser, 'X')
        X.goto(BASE + f'#/connect/pasky/gym-data/{BAD}')
        err = sync(X)
        check(err and 'invalid or expired' in err, f'bad token reported ({err})')
        X.goto(BASE + '#/'); X.wait_for_selector('#syncst')
        check('⚠' in X.inner_text('#syncst'), 'sync warning badge shown')
        X.screenshot(path='/tmp/gym-sync-bad.png')
        A.goto(BASE + '#/data'); A.wait_for_selector('#syncstatus'); A.screenshot(path='/tmp/gym-sync-data.png', full_page=True)
        V.goto(BASE + '#/view/pasky/gym-data'); V.wait_for_selector('.viewbar'); V.screenshot(path='/tmp/gym-sync-view.png')

        print('== hostile shared log (XSS)')
        now = int(time.time() * 1000)
        P = '<img src=x onerror="window.pwned=1">'
        gh.repos['evil/log'] = {'private': False, 'files': {}}
        gh.put_raw('evil/log', 'gym.json', {'format': 'gym-log', 'v': 3, 'deleted': {P: 1}, 'targetLog': [{'t': 1, 'ex': P, 'k': 'load', 'from': P, 'to': 1}],
            'targets': {'lat-pulldown': {'load': P, 'sets': P}, P: {'load': 1}}, 'notes': {'lat-pulldown': {'t': P, 'u': 1}, P: {'t': 'x', 'u': 1}},
            'sessions': [{'id': P, 'start': now, 'end': now, 'items': []},
                         {'id': 'evilsess', 'start': now, 'end': now + 1000, 'note': P, 'name': P, 'items': [
                             {'ex': P, 'target': {}, 'sets': []},
                             {'ex': 'lat-pulldown', 'ss': P, 'note': P, 'target': {'sets': P, 'reps': P, 'load': P, 'rest': P},
                              'sets': [{'w': P, 'r': P, 'done': True}, {'w': 30, 'r': 10, 'done': True}]}]}]})
        E = device(browser, 'E')
        E.goto(BASE + '#/view/evil/log'); E.wait_for_selector('.viewbar')
        for route in ['#/', '#/s/evilsess', '#/ex/lat-pulldown', '#/targets', '#/progress']:
            E.goto(BASE + route); E.wait_for_timeout(150)
        check(E.evaluate('window.pwned') is None, 'no script ran from hostile log')
        E.goto(BASE + '#/s/evilsess'); E.wait_for_selector('.card.ex')
        check(E.locator('.card.ex').count() == 1, 'invalid exercise id dropped, valid one kept')

        print('== viewing while own sync is in flight')
        own_before = state(A)['sessions']
        remote_before = gh.file('pasky/gym-data')
        A.evaluate("() => { const f = window.fetch; window.fetch = (...a) => new Promise(r => setTimeout(() => r(f(...a)), 800)); syncNow(); }")
        A.goto(BASE + '#/view/evil/log')   # same page, hash change
        A.wait_for_selector('.viewbar'); A.wait_for_timeout(2500)
        check('evilsess' not in A.evaluate("localStorage['gym.v1']"), "viewed log didn't leak into own storage")
        check(gh.file('pasky/gym-data') == remote_before, "viewed log didn't get uploaded")
        A.click('[data-a=view-exit]'); A.reload(); A.wait_for_selector('#main')
        check(state(A)['sessions'] == own_before, 'own log intact after exiting view')

        print('== clock skew: remote revision from a clock 2 min ahead')
        d = gh.file('pasky/gym-data'); sk = d['sessions'][0]; sk['u'] = now + 120000; sk['note'] = 'from fast clock'
        gh.put_raw('pasky/gym-data', 'gym.json', d)
        sync(A)
        A.goto(BASE + f"#/s/{sk['id']}"); A.fill('[data-f=snote]', 'edited here'); A.locator('[data-f=snote]').blur()
        sync(A)
        got = [x for x in gh.file('pasky/gym-data')['sessions'] if x['id'] == sk['id']][0]
        check(got['note'] == 'edited here', 'local edit wins over a revision from a fast clock')
        A.goto(BASE + f"#/s/{sk['id']}"); A.click('[data-a=del]'); sync(A); sync(B)
        check(sk['id'] not in [x['id'] for x in state(B)['sessions']], 'deletion wins over a fast-clock revision')

        print('== merge is order-independent on ties')
        same = A.evaluate("""() => {
            const mk = (note) => ({ v: 3, sessions: [{ id: 'tie', start: 1, end: 2, u: 5, note, items: [] }], deleted: {}, targets: { x: { load: note.length, u: 7 } }, notes: { x: { t: note, u: 9 } }, targetLog: [] });
            const a = mk('aaa'), b = mk('bbbb');
            return canon(syncPart(mergeStates(a, b))) === canon(syncPart(mergeStates(b, a)));
        }""")
        check(same, 'mergeStates(a,b) == mergeStates(b,a)')

        print('== visit finished on another device')
        A.goto(BASE + '#/'); A.click('[data-a=pick][data-ex=face-pull]'); A.wait_for_selector('#item-0')
        A.click('[data-a=tick][data-i="0"][data-j="0"]'); A.goto(BASE + '#/'); sync(A)
        aid = state(A)['active']
        d = gh.file('pasky/gym-data'); x = [z for z in d['sessions'] if z['id'] == aid][0]
        x['end'] = now + 5000; x['u'] = x['u'] + 10; gh.put_raw('pasky/gym-data', 'gym.json', d)
        sync(A)
        check(state(A)['active'] is None, 'active visit cleared when finished elsewhere')

        print('== no state swap under a focused field')
        A.goto(BASE + '#/'); A.click('[data-a=pick][data-ex=goblet-step-up]'); A.wait_for_selector('#item-0'); sync(A)
        d = gh.file('pasky/gym-data'); d['sessions'].append({'id': 'focusx', 'start': now, 'end': now + 1, 'u': now + 1, 'note': '', 'items': []})
        gh.put_raw('pasky/gym-data', 'gym.json', d)
        A.focus('[data-f=set][data-i="0"][data-j="0"][data-k=w]')
        sync(A)
        check('focusx' not in [z['id'] for z in state(A)['sessions']], 'sync postponed while editing')
        A.locator('[data-f=set][data-i="0"][data-j="0"][data-k=w]').blur(); A.wait_for_timeout(3500); sync(A)
        check('focusx' in [z['id'] for z in state(A)['sessions']], 'applied after editing stops')

        print('commits:', len(gh.commits), set(m for _, m in gh.commits))
        browser.close()
finally:
    srv.terminate()
print('page errors:', errors)
ok = not errors and not fails
print('SYNC TEST: ' + ('ALL OK' if ok else f'{len(fails)} FAILED'))
sys.exit(0 if ok else 1)
