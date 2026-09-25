"""Headless smoke test: python3 test/smoke.py  (serves the repo on :8765, drives a few visits, screenshots to /tmp/gym-*.png)"""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
URL = 'http://localhost:8765/'
errors = []
state = lambda pg: pg.evaluate("JSON.parse(localStorage['gym.v1'])")
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 400, 'height': 860}, device_scale_factor=2)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        pg.on('dialog', lambda d: d.accept())

        # v1 -> v2 migration of plan-keyed targets
        pg.goto(URL)
        pg.evaluate("""localStorage['gym.v1'] = JSON.stringify({v: 1, sessions: [], active: null, draft: [],
            targets: {'B:lat-pulldown': {load: 40}}, targetLog: [{t: 1, key: 'B:lat-pulldown', k: 'load', from: 35, to: 40}], notes: {}})""")
        pg.reload()
        pg.click('[data-a=pick][data-ex=goblet-box-squat]')  # triggers a save
        st = state(pg)
        assert st['targets'] == {'lat-pulldown': {'load': 40}}, st['targets']
        assert st['targetLog'][0]['ex'] == 'lat-pulldown' and 'draft' not in st, st
        pg.evaluate("localStorage.clear()"); pg.goto(URL); pg.reload()
        pg.screenshot(path='/tmp/gym-home.png', full_page=True)

        # visit 1: pick exercises one by one, straight from home
        pg.click('[data-a=pick][data-ex=goblet-step-up]')
        pg.wait_for_selector('#item-0')
        pg.fill('[data-f=set][data-i="0"][data-j="0"][data-k=w]', '8')
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="0"][data-j="{j}"]')
        pg.click('[data-a=pick][data-ex=seated-cable-row]')
        pg.click('[data-a=addpartner]')  # superset partner suggestion
        pg.click('[data-a=pick][data-ex=deadbug-hold]')
        items = [i['ex'] for i in state(pg)['sessions'][0]['items']]
        print('visit 1:', items)
        assert items == ['goblet-step-up', 'seated-cable-row', 'face-pull', 'deadbug-hold'], items
        for i in range(1, 4):
            pg.click(f'[data-a=tick][data-i="{i}"][data-j="0"]')
        pg.screenshot(path='/tmp/gym-session.png', full_page=True)
        pg.click('[data-a=finish]')
        pg.screenshot(path='/tmp/gym-finished.png', full_page=True)

        # age it, then visit 2 should suggest progression for the step-up
        pg.evaluate("""() => { const s = JSON.parse(localStorage['gym.v1']); s.sessions[0].start -= 3*864e5; s.sessions[0].end -= 3*864e5; localStorage['gym.v1'] = JSON.stringify(s); }""")
        pg.goto(URL); pg.reload()
        pg.click('[data-a=pick][data-ex=goblet-step-up]')
        pg.wait_for_selector('.sug')
        pg.screenshot(path='/tmp/gym-session2.png', full_page=True)
        pg.click('.sug [data-k=load]')
        pg.wait_for_timeout(200)
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="0"][data-j="{j}"]')
        pg.click('[data-a=finish]')
        print('targets:', state(pg)['targets'])
        tg = state(pg)['targets']; assert tg['goblet-step-up']['load'] == 8 and set(tg) == {'goblet-step-up'}, tg

        # superset rest: partner added after its sets are done must not suppress rest on the other
        pg.goto(URL); pg.click('[data-a=pick][data-ex=face-pull]'); pg.wait_for_selector('#item-0')
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="0"][data-j="{j}"]')
        pg.click('[data-a=addpartner]')
        assert [i['ex'] for i in state(pg)['sessions'][-1]['items']] == ['seated-cable-row', 'face-pull']
        pg.click('[data-a=tick][data-i="0"][data-j="0"]')
        assert pg.is_visible('#rest'), 'row should rest when face pull is already done'
        # untick everything, finish => discard, timer must stop
        pg.click('[data-a=tick][data-i="0"][data-j="0"]')
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="1"][data-j="{j}"]')
        pg.click('[data-a=finish]')
        assert len(state(pg)['sessions']) == 2 and not pg.is_visible('#rest')
        # finishing an empty visit discards it
        pg.goto(URL); pg.click('[data-a=pick][data-ex=lat-pulldown]'); pg.click('[data-a=finish]')
        assert len(state(pg)['sessions']) == 2 and state(pg)['active'] is None

        pg.goto(URL + '#/ex/goblet-step-up'); pg.screenshot(path='/tmp/gym-ex.png', full_page=True)
        pg.goto(URL + '#/progress'); pg.screenshot(path='/tmp/gym-progress.png', full_page=True)
        pg.goto(URL + '#/targets/face-pull'); pg.screenshot(path='/tmp/gym-targets.png')

        # narrow phone: reps input must fit two digits
        pg.set_viewport_size({'width': 320, 'height': 700})
        pg.goto(URL); pg.click('[data-a=pick][data-ex=cable-trunk-twist]'); pg.wait_for_selector('#item-0')
        w = pg.eval_on_selector('[data-f=set][data-i="0"][data-j="0"][data-k=r]', 'e => e.clientWidth')
        print('reps input width @320px:', w); assert w >= 30, w
        pg.screenshot(path='/tmp/gym-narrow.png')
        # invalid import must not clobber data
        before = pg.evaluate("localStorage['gym.v1']")
        pg.goto(URL + '#/data')
        pg.set_input_files('#import', files=[{'name': 'b.json', 'mimeType': 'application/json', 'buffer': b'{"sessions":[null]}'}])
        pg.wait_for_timeout(300)
        assert pg.evaluate("localStorage['gym.v1']") == before, 'import clobbered data'
        b.close()
finally:
    srv.terminate()
print('errors:', errors)
sys.exit(1 if errors else 0)
