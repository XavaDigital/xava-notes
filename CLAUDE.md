# Xava Notes — notes for anyone (or any agent) working in this repo

A notes and tasks PWA for one person, with a Laravel API that keeps the notes in MySQL. Read [PLAN.md](PLAN.md) first: it holds the move from Google Drive to Cloudways, the data model and the build phases.

## Branches

- `claude/note-todo-app-fnaar3` is the Drive version, published to GitHub Pages on every push (`.github/workflows/pages.yml`, `deploy.sh`). It is the live app until the notes are moved (PLAN.md, Phase 3). Do not merge `cloudways` into it before then.
- `cloudways` is the Laravel app. Cloudways deploys from it ([DEPLOY.md](DEPLOY.md)).

## Layout

- `public/` — the PWA, served as static files: `index.html`, `js/`, `css/`, `icons/`, `sw.js`, `manifest.webmanifest`. No build step.
  - `js/store.js` — the IndexedDB cache and sync: saves, retries, conflicts, pulls.
  - `js/api.js` — every call to the server. `js/auth.js` — whether the session is good; signing in is the server's `/login` page.
  - `sw.js` — bump `CACHE` whenever shipped files change, and keep `SHELL` in step with the files in `js/`, or the new service worker fails to install.
- `app/Http/Controllers/NotesController.php` — the pull (`GET /api/notes?after=<rev>`), the save with its conflict check (`PUT /api/notes/{id}`) and the purge.
- `app/Models/Note.php` — translates between the app's note shape (`public/js/note.js`) and the columns.
- `app/Notes/Revisions.php` — the global change counter behind `rev`.
- `app/Notes/MarkdownNote.php` — reads a note's Markdown file exactly as `public/js/note.js` does. `tests/Fixtures/markdown/cases.json` is generated from the JavaScript itself (`node tests/Fixtures/markdown/generate.mjs`); regenerate it whenever `note.js` or `frontmatter.js` changes.
- `app/Notes/Drive.php`, `app/Console/Commands/ImportDriveCommand.php` — `notes:import-drive` (Phase 3).
- `app/Http/Controllers/AttachmentsController.php`, `NotifyController.php`, `SignInController.php`, `SessionController.php`.
- `backend/` — the old Cloudflare Worker. Kept until Phase 5, then deleted.

## Rules the code keeps

- A note's id is the one the app generated. A retried create lands on the same row.
- A save whose content equals what is stored writes nothing and answers 200, whatever base version it carries. That is what makes retries safe.
- A save on a stale `base_version` answers 409 with the stored note. The app's conflict prompt decides; "overwrite" resends with the stored version as its base.
- Every write takes its `rev` while holding the lock on the `sync_state` row, so a pull "after rev N" can never miss a write that commits late.
- Emptying a note from Trash keeps the row as a purged marker so other devices drop it.
- `/` serves the app to anyone; it holds no data. Everything under `/api` needs the session. Writes carry the `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header.

## Working on this machine (Windows, no local PHP)

PHP and Composer are not installed here and should not be. Everything runs in Docker, with `vendor/` in a Docker volume:

```sh
# Composer (any composer command)
MSYS_NO_PATHCONV=1 docker run --rm -e COMPOSER_PROCESS_TIMEOUT=1800 -v "C:/Users/cirni/Desktop/code/xava-notes:/app" -v xava-notes-vendor:/app/vendor -w /app composer:2 composer install

# Artisan and tests on PHP 8.3, the server's version
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/cirni/Desktop/code/xava-notes:/app" -v xava-notes-vendor:/app/vendor -w /app php:8.3-cli php artisan test
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/cirni/Desktop/code/xava-notes:/app" -v xava-notes-vendor:/app/vendor -w /app php:8.3-cli sh -c "touch database/database.sqlite && php artisan migrate && php artisan notes:owner owner@example.test secret"

# Run the app locally on http://localhost:8000
MSYS_NO_PATHCONV=1 docker run --rm -p 8000:8000 -v "C:/Users/cirni/Desktop/code/xava-notes:/app" -v xava-notes-vendor:/app/vendor -w /app php:8.3-cli php artisan serve --host=0.0.0.0
```

Local `.env`: copy `.env.example`, then `php artisan key:generate`. `DB_CONNECTION=sqlite` is enough locally. The tests run on SQLite; the server runs MySQL, which re-sorts keys inside JSON columns, so compare stored JSON through `Note::clientFields()`, never raw.

`composer.json` pins the platform to PHP 8.3 so Composer never picks packages that need a newer PHP than the server has.

`.env.worker` (git-ignored) holds the Worker's secrets as notes. It is not a dotenv file; keep it out of `.env`.
