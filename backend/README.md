# Xava Notes API (Cloudflare Worker + D1)

A small backend for **reminders / Web Push notifications** and a **durable
write-relay (outbox)** that reliably persists note writes to Google Drive.

- **Free** for one user (Workers + D1 + Cron Triggers free tier).
- **Scales to zero, never sleeps**, nothing to patch.
- Your notes still live as Markdown files in **your own Google Drive** — this
  server is a relay + scheduler, not the source of truth.

## What it does

- **Reminders**: stores `{ title, dueAt, noteId }`; a per-minute cron sends a
  Web Push when a reminder is due.
- **Web Push**: VAPID-authenticated, encrypted-payload pushes to subscribed
  devices.
- **Write-relay (outbox)**: the PWA can `POST /outbox` a note write; the server
  writes it to Drive immediately and, on any failure, retries it from cron — so
  a write survives the phone going offline mid-sync.
- **Permanent login**: holds the Google **refresh token** and mints fresh access
  tokens, so the app isn't limited by the browser's ~1h token.

## Prerequisites

1. A **dedicated Google Cloud project** for this app (so the strict
   verification of your Sheets project doesn't apply):
   - Enable the **Google Drive API**.
   - OAuth consent screen: **External**, add your email; **scope: only
     `.../auth/drive.file`** (non-sensitive → no verification). **Publish to
     Production** (this gives long-lived refresh tokens).
   - Create an **OAuth client ID → Web application**. Note the **Client ID** and
     **Client secret**. Add your app origin to **Authorized JavaScript origins**
     and a **redirect URI** the app will use (e.g. `https://xavadigital.github.io/xava-notes/`).
2. `npm i -g wrangler` and `wrangler login`.
3. VAPID keys: `npx web-push generate-vapid-keys` (note the public + private keys).

## Setup

```bash
cd backend
npm install

# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
wrangler d1 create xava-notes

# 2. Create the tables (locally for dev, and on the remote DB for prod)
npm run db:init           # local
npm run db:init:remote    # remote (production)

# 3. Fill in wrangler.toml [vars]: GOOGLE_CLIENT_ID, ALLOWED_ORIGIN,
#    VAPID_PUBLIC_KEY, VAPID_SUBJECT

# 4. Set the secrets (not committed)
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put VAPID_PRIVATE_KEY

# 5. Deploy
npm run deploy
```

Wrangler prints your Worker URL (e.g. `https://xava-notes-api.<you>.workers.dev`).
Set that as `config.apiBaseUrl` in the PWA.

## Wiring the PWA (next step)

The app's `js/config.js` already has an `apiBaseUrl` hook. To use this backend:

1. **Auth**: run the OAuth **authorization-code + PKCE** flow in the app,
   redirect back with the `code`, `POST /auth/exchange`, and store the returned
   `deviceToken`. Use it as `Authorization: Bearer <deviceToken>` for all calls,
   and call `POST /auth/access-token` whenever the app needs a fresh Google
   access token (removes the ~1h client-token limit).
2. **Reminders**: when a task has a due date + reminder, `PUT /reminders`.
3. **Push**: `GET /push/vapid-public-key`, subscribe via the service worker's
   `pushManager.subscribe({ applicationServerKey })`, then `POST /push/subscribe`.
   Add `push` + `notificationclick` handlers to `sw.js`:

   ```js
   self.addEventListener('push', (e) => {
     const d = e.data ? e.data.json() : {};
     e.waitUntil(self.registration.showNotification(d.title || 'Reminder', {
       body: 'Due now', data: d, tag: d.noteId || undefined,
     }));
   });
   self.addEventListener('notificationclick', (e) => {
     e.notification.close();
     e.waitUntil(clients.openWindow('./'));
   });
   ```
4. **Write-relay (optional, for reliability)**: instead of writing to Drive from
   the browser, `POST /outbox` each change; use the returned `fileId`.

## Endpoints

| Method | Path | Auth | Body / Notes |
|---|---|---|---|
| GET | `/push/vapid-public-key` | — | `{ key }` |
| POST | `/auth/exchange` | — | `{ code, redirectUri, codeVerifier? }` → `{ deviceToken, accessToken, expiresIn }` |
| POST | `/auth/access-token` | ✓ | → `{ accessToken, expiresIn }` |
| POST | `/push/subscribe` | ✓ | `{ subscription }` |
| POST | `/push/unsubscribe` | ✓ | `{ endpoint }` |
| GET | `/reminders` | ✓ | → `{ reminders }` |
| PUT | `/reminders` | ✓ | `{ id, noteId?, title, dueAt }` |
| DELETE | `/reminders/:id` | ✓ | |
| POST | `/outbox` | ✓ | `{ op:'put'\|'delete', noteId?, fileId?, name?, content?, appProperties? }` |

## Notes / caveats

- **Web Push encryption** (aes128gcm) is implemented from scratch with Web
  Crypto — verify on a real device after deploying; if pushes don't arrive,
  that's the first place to check.
- The server uses the **same OAuth client** as the PWA, so its `drive.file`
  access covers the same `XavaNotes` folder.
- Single-user model: one `device_token` gates the API. For multi-user you'd key
  everything by an account id.
