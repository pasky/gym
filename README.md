# Gym log

A static, mobile-first exercise log.

1. Tap ＋ on any exercise and log it; the first tap starts the visit. Exercises are grouped by muscle group, and each group shows sets this week, a 4-week average and when it was last trained. Groups untouched for a week are flagged *due*, so you can spread the work evenly. The list stays under your logged exercises for picking the next one.
2. Log weight/reps per set (tap ✓ to accept the target) and let the rest timer run. For the trainer's supersets (row + face pull) the app offers to add the partner, and skips the rest between them.
3. When you've hit all sets, a 📈 prompt offers to raise the target (weight or reps). The Progress tab has per-exercise charts and a muscle-balance breakdown.

- `catalog.js` holds the exercise library (with muscle group + default target) and the trainer's sheets. **Add new exercises here** (plus a photo in `img/ex/`), keeping ids stable.
- All user data (sessions, target tweaks, notes) lives in `localStorage` under `gym.v1`. You can export/import it from the 💾 Data tab. Everything goes through the `store` object in `app.js`, which is where to swap in server-side storage later.
- `./deploy.sh` rsyncs to `~/WWW/gym` and cache-busts asset URLs.
- `python3 test/smoke.py` runs a headless Playwright smoke test (screenshots go to `/tmp/gym-*.png`).

## Trainer sheet review (Sep 2026)

Issues found on the two sheets (`img/sheets/`). The corrected muscle lists are in `catalog.js` and each exercise page shows its notes:

- **Body diagrams are often wrong.** The seated row and lat pulldown highlight the *front abdomen* instead of the lats/back. The face pull highlights the *chest and front delts*. The cable trunk twist highlights the *hips/upper thighs* instead of the obliques. The deadbug highlights the *front thighs* instead of the abs. The Bulgarian split squat and isometric lunge leave the glutes unhighlighted.
- **Muscle lists.** The step-up lists calves (only minor). The curl→press omits triceps. The Bulgarian split squat lists hamstrings as main (they're secondary). The isometric lunge lists adductors, but its ankle cue really targets the foot arch / tibialis posterior.
- **Parameters.** The row + face pull superset has no rest (assumed ~90 s after the face pull). The Bulgarian split squat and isometric lunge omit "each side". It's unclear whether chest press 5 kg is per cable, what the trunk-twist med ball weighs, or whether the deadbug is 10 reps total or per side.
- **Photos / cues.** The isometric lunge photo shows the rear knee resting on the floor. The deadbug's 2nd photo shows a moving leg extension, not a hold. "Drive through your heels" (box squat) is a dated cue.

## Server sync storage (WebDAV)

`server/` sets up `https://pasky.or.cz/gym-sync/`, a password-protected file store for the app's JSON state. It uses Apache's WebDAV module, allows only GET/PUT, and runs no application code on the server.

- `sudo sh server/setup-webdav.sh` installs it (idempotent) and prints the generated password once. It also accepts `--reset-password` and `--uninstall`.
- `sh server/test-local.sh` tests the same config template on a throwaway unprivileged Apache (port 18080). No root needed.
- `GYM_SYNC_PASS=... sh server/check-webdav.sh URL [USER]` verifies a live endpoint: unauthenticated requests get 401/403; DAV/XML methods, DELETE/MOVE/COPY/MKCOL, directory listing, non-`name.json` filenames (e.g. `x.php`, `.htaccess`) and oversized uploads are refused.
