# Xava Notes on Cloudways — plan

Move Xava Notes off Google Drive and the Cloudflare Worker, onto a small Laravel app with a MySQL database on the Cloudways server that already runs BM Needs Me. The phone app (the PWA) keeps its look, its features and its offline use. Only where the notes are kept changes.

Written 2026-10-01.

**Progress.** Phases 0 to 3 are done. The app is live at https://notes.xava.co.nz with the notes imported from Drive on 2026-10-02 (129 notes, 23 duplicate copies dropped, 5 attachments). GitHub Pages is switched off (2026-10-03) and both branches hold the Laravel app; the old app's address now returns 404. The Drive files remain as the fallback until Phase 5. Still to do in Phase 3: install the app from the new address on the phone and Windows and remove the old one. Phase 4 (the nightly backup) is built and tested; it needs deploying, a first run, and the Cloudways cron line. Phase 5 is not started.

## Why

Reliability, not cost. The Worker was designed to fit Cloudflare's free tier, so the saving may be nothing; that is worth checking on the Cloudflare and Mailgun billing pages, but it is not the reason.

The reason is that most of the fixes in this repo's history are workarounds for Drive being the database:

| Fix in the history | What caused it |
|---|---|
| Google sign-in expiring about hourly; 401 recovery; token kept across refreshes; seamless session refresh | Drive needs a Google access token, and those expire |
| The Worker's refresh-token relay (`/auth/access-token`) | The same, from the other side |
| The Worker's write outbox and per-minute retry | Drive writes fail often enough to need a durable retry |
| Notes stuck "Unsynced"; creates that lost their Drive file id | Each note is a separate Drive file whose id Drive assigns, so a lost response leaves the note without one |
| 403 on long titles | Drive caps each `appProperties` value at 124 bytes |
| Unreliable bulk task creation | Many separate Drive file writes at once |
| Conflict guard via Drive `modifiedTime` | Drive has no version number to check against |

With our own database, notes are rows keyed by the id the app already generates, sign-in is an ordinary session, and a save is one request to a server we control. Those failure classes go away rather than being worked around.

## What stays the same

- The PWA: every screen, the editor, notebooks, tasks and subtasks, tags, due dates, Markdown formatting, attachments, import from Evernote and Todoist, the Android share target, installable on the phone.
- Offline use. The IndexedDB copy of every note stays, and so does the "dirty until the server confirms" rule in `js/store.js`. The phone still has to capture a note with no signal and send it later.
- The conflict prompt (overwrite, keep both, cancel). It now compares against a version number held by the server instead of Drive's `modifiedTime`.
- The note model in `js/note.js`, including its ids. Existing ids carry over, so nothing needs renumbering.
- Mailgun for "email me a copy".
- Notes as Markdown files you own: kept as a nightly backup into Drive (see Phase 4), not as the live store.

## What changes

| Now | After |
|---|---|
| PWA on GitHub Pages (`xavadigital.github.io`) | PWA served by the Laravel app at `notes.xava.co.nz` |
| Notes as Markdown files in Drive, `drive.file` scope | Rows in MySQL |
| Attachments in `XavaNotes/attachments` in Drive | Files on the server's disk, served only to a signed-in session |
| Google sign-in (GIS token client) plus the Worker's refresh token | Laravel sign-in form with remember-me, same as BM Needs Me |
| Cloudflare Worker + D1: write relay, refresh token, email | Laravel: the API, the email |
| Worker cron every minute | Laravel scheduler on Cloudways cron (already running on that server) |

Serving the PWA from the same domain as the API means no cross-origin requests and a plain session cookie for auth.

## The server

A new PHP Custom App on the existing Cloudways server (PHP 8.3, basic PHP stack), with its own MySQL database. The same server runs BM Needs Me and about a dozen agency WordPress sites, so nothing here changes server-wide settings. Deploy is Git pull from this repo, as for BM Needs Me; its `DEPLOY.md` is the reference.

Branches: the Laravel app lives on a new `cloudways` branch, and Cloudways deploys from it. `claude/note-todo-app-fnaar3` stays on the Drive version, because every push to it republishes the whole repo to GitHub Pages, the app on the phone today. The two are merged at Phase 3, when the old app is frozen.

Repository layout: the Laravel app becomes the repo root, and the PWA files (`index.html`, `js/`, `css/`, `icons/`, `sw.js`, `manifest.webmanifest`) move into `public/`, where Laravel serves them as static files. Cloudways Git deploy runs no build step, so this keeps it to a pull and a migrate. `backend/` (the Worker) stays in the repo until Phase 5 and is then deleted.

Local development follows BM Needs Me: no local PHP, everything in Docker, with `vendor/` in a Docker volume.

### Data

`notes`

| Column | Notes |
|---|---|
| `id` | The app's own id (`newId()` in `js/note.js`), primary key. Set by the client, so a retried create is the same row, never a duplicate |
| `type`, `title`, `body`, `notebook`, `done`, `completed_at`, `due` | As in the note model |
| `sort_order` | The note's `order`. Renamed because `order` is a reserved word in MySQL; the API still calls it `order` |
| `tags`, `subtasks`, `attachments` | JSON. `attachments` is the note's list as the app holds it |
| `deleted`, `deleted_at` | In Trash. Kept as the app's own flag and time, since older notes have the flag without a time |
| `purged_at` | Emptied from Trash. Body and attachments are removed; the row stays as a marker so other devices drop it on their next pull |
| `version` | Starts at 1, goes up by one on every save. Used for the conflict check |
| `rev` | A global change counter, set on every write. Devices pull "everything after rev N" |
| `created`, `updated` | The client's times, kept as the exact strings sent, so a repeated save compares equal |

`attachments`: `id`, `note_id`, `name`, `mime`, `size`, `path` on disk. The note's `attachments` field keeps its current shape; the `id` becomes this row's id instead of a Drive file id. The app uploads before the note is saved, so `note_id` is empty until the note's next save names the attachment.

`sync_state`: one row holding the last `rev` handed out. Each write locks it until its transaction commits, so revs become visible in order and a pull can never skip one that commits late.

### API

All behind the session, all JSON. Writes carry Laravel's `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header, so CSRF protection stays on; a write without it gets 419, which the app treats like a 401.

- `GET /api/session` — who is signed in; 401 means go to `/login`. It also sets the `XSRF-TOKEN` cookie, so the app calls it at start-up before sending any queued saves.

- `GET /api/notes?after=<rev>` — every note changed after that rev, including purged markers (`{id, purged: true}`), plus the new highest rev. First load is `after=0`, which leaves the purged markers out.
- `PUT /api/notes/{id}` with `base_version` — create or update. Returns the new `version` and `rev`. If `base_version` is behind the stored version, returns 409 with the stored note, and the app shows the existing conflict prompt. A save whose content equals what is stored returns 200 and writes nothing, whatever its base, so retries are safe. Saving to a note that was emptied from Trash elsewhere is a 409 carrying the purged marker; "overwrite" brings the note back.
- `DELETE /api/notes/{id}` — purge (empty from Trash).
- `POST /api/attachments` (multipart), `GET /api/attachments/{id}` and `DELETE /api/attachments/{id}` — upload, download, and remove (the app removes an attachment from a note with `trashFile` today). Downloads are sandboxed, and anything other than images, PDFs, text, audio and video downloads instead of opening.
- `POST /api/notify` — the "email me a copy" email, as the Worker's `/notify` does now.

### Client changes

- `js/store.js`: `writeNoteToDrive`, `relayPut`, `relayDelete`, `refreshFromDrive` and `flushQueue` are replaced by calls to the API above. The dirty flag, `syncPending` and `countPending` stay as they are. The IndexedDB cache stores `version` and the last pulled `rev` instead of `modifiedTime`.
  - As built: `note.version` replaces `note.fileId` as "the server has this note" (0 until confirmed). Writes to one note are serialised, so an autosave, a background retry and a pull never interleave. A background retry that meets a conflict keeps both (nobody is there to answer the prompt); a save with no conflict handler overwrites, as quick list actions always did. A pull never overwrites a local unsynced edit.
- `js/drive.js`: removed. The three calls from `js/app.js` into it (`uploadAttachment`, `getBlob`, `trashFile` for attachments) move to a small `js/api.js`.
- `js/auth.js`: Google sign-in and the relay token are removed. If the session has expired, the app shows the sign-in form; offline edits keep waiting in IndexedDB until then.
- `js/config.js`: the Google client id, Drive scope, folder name and Worker URL go.
- `sw.js`: bump the cache version so the phone picks up the new code. Also: take `./js/drive.js` out of the precache list and add `./js/api.js`, or `cache.addAll` fails and the new service worker never installs; and stop caching `/api/` and `/login` (the fetch handler caches every same-origin GET today).
- `js/app.js`: calls into `store` are unchanged. The Settings screen loses "Connect Google Drive" and gains "Sign out". Start-up (`js/app.js` around line 150) is keyed on the Google client id today: whether to restore the editor draft, try a silent Google sign-in, or open Settings. It becomes a call to `/api/session`. The "email me a copy" call (around line 2272) moves from the Worker's `/notify` to `/api/notify`.

## Build phases

**Phase 0. Before any code (David).**
1. Pick the subdomain. Done: `notes.xava.co.nz`, an A record at Discount Domains (the DNS host for `xava.co.nz`) pointing at the server, 139.180.160.90.
2. Check that Cloudways backups are switched on for the server. Done: on. The server becomes the only live copy of the notes, and it is shared with BM Needs Me, so if it goes down both go down.
3. Look at how much is in `XavaNotes/attachments` in Drive, to confirm the server disk has room. Done: tens of MB at most, against 187 GB free.
4. Optional: check the Cloudflare and Mailgun billing pages, so the saving (if any) is known.

**Phase 1. The server app. Done, live.** Laravel app, migrations for `notes` and `attachments`, the sign-in form, the API, the `notify` email through Mailgun, and the PWA served from `public/`. PHPUnit tests for: create and update by client id, a repeated save not duplicating, the 409 on a stale `base_version`, the `after=<rev>` pull including soft-deleted and purged notes, and attachments only reachable when signed in. Deployed to the subdomain with an empty database ([DEPLOY.md](DEPLOY.md)).

**Phase 2. The client talks to the server. Done, phone test passed.** The changes to `js/store.js`, `js/auth.js`, `js/config.js` and `sw.js` above, `js/drive.js` replaced by `js/api.js`. Tried on the new subdomain with test notes, including offline on the phone: capture with no signal, reconnect, confirm it lands; edit the same note on two devices and confirm the conflict prompt.

**Phase 3. Move the notes. Done 2026-10-02.**
1. Freeze the old app: stop editing on the GitHub Pages version.
2. Import with an artisan command, `notes:import-drive`. It reads the `XavaNotes` folder and its attachments through the same Google OAuth client (the `drive.file` scope lets that client see the files it created), using the refresh token the Worker already holds (or a fresh consent), parses each file with the same frontmatter rules as `js/note.js`, and inserts it with its original id. Attachments are downloaded to disk and their ids rewritten in the note.
3. Check: the count of notes, tasks, notebooks and attachments matches Drive; open a sample of notes with attachments.
4. Merge `cloudways` into `claude/note-todo-app-fnaar3` only now, with GitHub Pages switched off first. Done 2026-10-03. Removing the workflow file was not enough: Pages was also set to build straight from the branch ("legacy" mode), so the merge push republished the repo root over the old app before Pages was switched off.
5. Install the PWA from the new subdomain on the phone and on Windows. Remove the old one. IndexedDB is per domain, so the new install starts clean and pulls everything from the server.

The Drive files are left where they are, untouched, as the fallback until Phase 5.

**Phase 4. Nightly backup to Drive. Built.** As built: `notes:backup-drive` at 2:30am NZ time; each run writes only notes changed since the last (tracked in `drive_backups`), copies new attachments once into `XavaNotes backup/attachments` and points the backed-up notes at those copies, and moves the backup of a note emptied from Trash to Drive's trash. `notes:import-drive --folder="XavaNotes backup"` restores from it; a test proves the round trip. A scheduled job writes every note as a Markdown file, in today's frontmatter format, into a separate Drive folder (`XavaNotes backup`), plus any attachments added since the last run. One-way only: nothing is ever read back from it automatically. If it fails, the app is unaffected and the failure is emailed. Because the format is unchanged, the Phase 3 import command can restore from it.

**Phase 5. Retire the old pieces, after about two weeks of use without problems.** Delete the Cloudflare Worker and its D1 database, remove `deploy.sh` (or change it to push the branch Cloudways pulls from; GitHub Pages and its workflow are already gone, see Phase 3), delete `backend/`, and update the README. Decide whether to keep or remove the original `XavaNotes` folder in Drive.

**Later. Reminders and push notifications.** Built in the Worker but never connected to the app. Port it to Laravel (the `minishlink/web-push` package, the same VAPID keys, the existing scheduler) and add the UI to set a reminder on a note. This is the "Reminders & push notifications" item on the README roadmap.

## Risks and how they are covered

- **One server for everything.** A server outage takes out BM Needs Me and Xava Notes together. Covered by Cloudways backups, the nightly Drive export, and the phone's offline copy, which still shows every note and accepts new ones during an outage.
- **A bad migration.** Covered by the count check in Phase 3 and by leaving the Drive files untouched until Phase 5.
- **Session expiry while offline edits are waiting.** The edits stay in IndexedDB marked dirty and are sent after sign-in; nothing is dropped. Remember-me keeps this rare.
- **Google refresh token expiring.** Phases 3 and 4 need a refresh token on the server. If the Google consent screen is in Testing mode, refresh tokens expire after 7 days and the nightly backup would stop every week. `backend/README.md` says it was published to Production; `README.md` describes Testing. Checked 2026-10-02: in production, so the refresh token does not expire after 7 days.
- **Disk space for attachments.** Checked in Phase 0. If it is tight, attachments can stay in Drive with only notes moving; that keeps one Google dependency, for attachments only.

## Open questions

- How often the Cloudways backups run.
- Mailgun region: the server uses the US endpoint, as the Worker did. Confirmed once "Email me a copy" from the live app arrives.
- Whether the old `XavaNotes` Drive folder is deleted or kept after Phase 5.
