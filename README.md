# Gym log

A small, mobile-first workout log that runs entirely in the browser. It's a static site with no backend, and syncing and sharing optionally go through a GitHub repo.

**Live:** https://pasky.github.io/gym/

1. Tap ＋ on any exercise and log it; the first tap starts the visit. Exercises are grouped by muscle group, and each group shows sets this week, a 4-week average and when it was last trained. Groups untouched for a week are flagged *due*, so you can spread the work evenly.
2. Log weight/reps per set (tap ✓ to accept the target) and let the rest timer run. Each card shows the coaching tips, a breathing cue and your last performance. For the trainer's supersets the app offers to add the partner, and skips the rest between them.
3. When you've hit all sets, a 📈 prompt offers to raise the target. The Progress tab has per-exercise charts and a muscle-balance breakdown, and the Targets tab lets you tweak prescriptions.

Everything is saved in the browser on every change. Syncing is optional.

## Sync & sharing (GitHub repo as storage)

The log can live as one JSON file (`gym.json`) in a GitHub repo, written through GitHub's API straight from the browser:

- **Several devices:** the app *downloads* other devices' changes when it opens or resumes, which makes no commits. It *uploads*, making one commit, only when you finish a visit, when it starts with unsynced changes, after 10 minutes without edits, or on *Sync now*. Devices merge rather than overwrite each other: every visit, target and note carries a modification time, and deletions leave a marker. GitHub rejects writes based on a stale version (409), so the app re-reads, merges and retries.
- **History:** every sync is a commit.
- **Sharing:** *Sync → Copy share link* gives `…/#/view/owner/repo`, a read-only view for anyone if the repo is public. A viewer can also *Copy into my browser* to play with a copy.
- **Least privilege:** use a *fine-grained token* limited to that one repo with only *Contents: read and write*. It can't touch anything else in the account. The token stays in the browser's localStorage and is never part of the log data or exports.

Setup: create a repo (e.g. `gym-data`) and a token as described in the app under Sync, then paste them in on a computer. To add your phone, use *Sync → Add another device → Show QR code* and scan it with the phone's camera. (The QR encoder is `vendor/qrcode.js`, MIT, by Kazuhiko Arase.)

## For trainers: your own copy for your clients

1. **Fork** this repo and enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main`, `/`). Your copy lives at `https://<you>.github.io/gym/`.
2. **Customize the exercises** in `catalog.js` (the GitHub web editor is fine): names, muscle groups, default targets, tips, breathing cues, photos in `img/ex/`. Keep `id`s stable once clients use them.
3. **Per client:** create one **private** repo (e.g. `gym-anna`) and a fine-grained token limited to *that repo* with *Contents: read and write*. In the app, *Sync → Trainer: set up a client* turns them into a link like `…/#/connect/you/gym-anna/<token>`, plus a QR code the client can scan in person.
   - **Client side:** the client opens the link once on each device. They need no GitHub account; the app stores the token and removes it from the address bar.
   - **The link is a secret:** it lets whoever has it edit that client's log. Send it privately. If it leaks, revoke the token on GitHub and send a new link.
   - **Token expiry:** when a token expires, sync shows a warning until the client gets a new link. Their local data is unaffected.
4. **Viewing clients:** open `…/#/view/you/gym-anna`. For private repos, save a token with read access to your client repos under *Sync → View someone's log → Private repos*.

## Development

Plain HTML/CSS/JS with no build step: `index.html`, `style.css`, `catalog.js` (exercise data), `sync.js` (merge + GitHub API client), `app.js` (UI), `sw.js` (service worker: always-fresh app files when online, cached copy offline).

- `python3 test/smoke.py` runs a headless Playwright test of the logging flows.
- `python3 test/sync_test.py` runs an end-to-end sync test against a fake GitHub API: multiple devices, 409 conflicts, deletions, targets/notes, share view, private client repos, bad tokens.
- `./deploy.sh [DEST]` copies the site elsewhere (default `~/WWW/gym`).

## Trainer sheet review (Sep 2026)

Issues found on the two sheets (`img/sheets/`). The corrected muscle lists are in `catalog.js` and each exercise page shows its notes:

- **Body diagrams are often wrong.** The seated row and lat pulldown highlight the *front abdomen* instead of the lats/back. The face pull highlights the *chest and front delts*. The cable trunk twist highlights the *hips/upper thighs* instead of the obliques. The deadbug highlights the *front thighs* instead of the abs. The Bulgarian split squat and isometric lunge leave the glutes unhighlighted.
- **Muscle lists.** The step-up lists calves (only minor). The curl→press omits triceps. The Bulgarian split squat lists hamstrings as main (they're secondary). The isometric lunge lists adductors, but its ankle cue really targets the foot arch / tibialis posterior.
- **Parameters.** The row + face pull superset has no rest (assumed ~90 s after the face pull). The Bulgarian split squat and isometric lunge omit "each side". It's unclear whether chest press 5 kg is per cable, what the trunk-twist med ball weighs, or whether the deadbug is 10 reps total or per side.
- **Photos / cues.** The isometric lunge photo shows the rear knee resting on the floor. The deadbug's 2nd photo shows a moving leg extension, not a hold. "Drive through your heels" (box squat) is a dated cue.
