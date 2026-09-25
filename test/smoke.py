"""Headless smoke test: python3 test/smoke.py  (serves the repo on :8765, drives two visits, screenshots to /tmp/gym-*.png)"""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 400, 'height': 860}, device_scale_factor=2)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        pg.on('dialog', lambda d: d.accept())
        pg.goto('http://localhost:8765/')
        pg.screenshot(path='/tmp/gym-home.png', full_page=True)
        pg.click('[data-a=start][data-p=A]')
        # tick every set of first exercise, change weight on first set
        pg.fill('[data-f=set][data-i="0"][data-j="0"][data-k=w]', '8')
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="0"][data-j="{j}"]')
        for i in range(1, 6):
            pg.click(f'[data-a=tick][data-i="{i}"][data-j="0"]')
        pg.screenshot(path='/tmp/gym-session.png', full_page=True)
        pg.click('[data-a=finish]')
        pg.screenshot(path='/tmp/gym-finished.png', full_page=True)
        # fake it being an older session, then do another visit of A
        pg.evaluate("""() => { const s = JSON.parse(localStorage['gym.v1']); s.sessions[0].start -= 3*864e5; s.sessions[0].end -= 3*864e5; localStorage['gym.v1'] = JSON.stringify(s); }""")
        pg.goto('http://localhost:8765/#/'); pg.reload()
        pg.click('[data-a=start][data-p=A]')
        pg.screenshot(path='/tmp/gym-session2.png', full_page=True)
        n = pg.locator('.sug').count()
        print('suggestions shown:', n)
        pg.click('.sug [data-k=load]')
        pg.wait_for_timeout(300)
        for j in range(3):
            pg.click(f'[data-a=tick][data-i="0"][data-j="{j}"]')
        pg.click('[data-a=finish]')
        pg.goto('http://localhost:8765/#/ex/goblet-step-up')
        pg.screenshot(path='/tmp/gym-ex.png', full_page=True)
        pg.goto('http://localhost:8765/#/progress'); pg.screenshot(path='/tmp/gym-progress.png', full_page=True)
        pg.goto('http://localhost:8765/#/plan/A'); pg.screenshot(path='/tmp/gym-plan.png', full_page=True)
        print('targets:', pg.evaluate("localStorage['gym.v1'] && JSON.parse(localStorage['gym.v1']).targets"))
        # narrow phone: reps input must fit two digits
        pg.set_viewport_size({'width': 320, 'height': 700})
        pg.goto('http://localhost:8765/#/'); pg.click('[data-a=start][data-p=A]')
        pg.wait_for_selector('.card.ex'); print(pg.url, pg.locator('.card.ex').count())
        w = pg.eval_on_selector('[data-f=set][data-i="5"][data-j="0"][data-k=r]', 'e => e.clientWidth')
        print('reps input width @320px:', w); assert w >= 30, w
        pg.screenshot(path='/tmp/gym-narrow.png')
        # invalid import must not clobber data
        before = pg.evaluate("localStorage['gym.v1']")
        pg.goto('http://localhost:8765/#/data')
        pg.set_input_files('#import', files=[{'name': 'b.json', 'mimeType': 'application/json', 'buffer': b'{"sessions":[null]}'}])
        pg.wait_for_timeout(300)
        assert pg.evaluate("localStorage['gym.v1']") == before, 'import clobbered data'
        b.close()
finally:
    srv.terminate()
print('errors:', errors)
sys.exit(1 if errors else 0)
