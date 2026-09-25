# Gym log

A static, mobile-first exercise log. Start a visit from a trainer plan, log weight/reps per set (tap ✓ to accept the target), and let the rest timer run. Afterwards, look at the progress charts and bump targets when you've hit all sets.

- `catalog.js` holds the exercise library and trainer plans (Training A/B). **Add new exercises here** (plus a photo in `img/ex/`), keeping ids stable.
- All user data (sessions, target tweaks, notes) lives in `localStorage` under `gym.v1`. You can export/import it from the 💾 Data tab. Everything goes through the `store` object in `app.js`, which is where to swap in server-side storage later.
- `./deploy.sh` rsyncs to `~/WWW/gym` and cache-busts asset URLs.
- `python3 test/smoke.py` runs a headless Playwright smoke test (screenshots go to `/tmp/gym-*.png`).

## Trainer sheet review (Sep 2026)

Issues found on the two sheets (`img/sheets/`). The corrected muscle lists are in `catalog.js` and each exercise page shows its notes:

- **Body diagrams are often wrong.** The seated row and lat pulldown highlight the *front abdomen* instead of the lats/back. The face pull highlights the *chest and front delts*. The cable trunk twist highlights the *hips/upper thighs* instead of the obliques. The deadbug highlights the *front thighs* instead of the abs. The Bulgarian split squat and isometric lunge leave the glutes unhighlighted.
- **Muscle lists.** The step-up lists calves (only minor). The curl→press omits triceps. The Bulgarian split squat lists hamstrings as main (they're secondary). The isometric lunge lists adductors, but its ankle cue really targets the foot arch / tibialis posterior.
- **Parameters.** The row + face pull superset has no rest (assumed ~90 s after the face pull). The Bulgarian split squat and isometric lunge omit "each side". It's unclear whether chest press 5 kg is per cable, what the trunk-twist med ball weighs, or whether the deadbug is 10 reps total or per side.
- **Photos / cues.** The isometric lunge photo shows the rear knee resting on the floor. The deadbug's 2nd photo shows a moving leg extension, not a hold. "Drive through your heels" (box squat) is a dated cue.
