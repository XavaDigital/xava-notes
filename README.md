# Xava Notes

A fast, voice-friendly **note-taking + to-do** PWA — a small blend of Evernote
and Todoist. Capture quick notes or tasks by typing or dictating (use your
Android keyboard mic / VoiceDash), then view and search them on any device.

Your data is stored as plain **Markdown files in your own Google Drive**
(in a `XavaNotes` folder). There is no server and no third-party database —
the app talks to Drive directly from your browser.

## Features (v1)

- 📝 Quick capture of **notes** and **tasks** from any device
- 🎙️ Voice-friendly: plain text fields work with any OS dictation
- 📓 **Notebooks** (lists/projects): jump into a notebook view; new items are auto-filed there
- ✅ Tasks with **completion**, **subtasks**, **due dates**, and **tags**
- 📎 **Image & file attachments** — stored in a `XavaNotes/attachments` subfolder in your Drive; images preview as thumbnails
- 📥 **Import** from Evernote (`.enex`, incl. attachments) and Todoist (`.csv`, project → notebook) by drag & drop
- ✍️ **Markdown formatting** toolbar: headings, bold/italic/strikethrough, highlight, lists, checkboxes, quote, code, links, divider — with live preview
- 🔍 Instant search across titles, bodies, tags, and subtasks
- 📲 Installable **PWA** (add to home screen on Android; runs in any browser on Windows)
- 🔗 **Android share target**: share a link or text from any app to create a note (installed PWA)
- ⚡ Offline-capable: notes are cached locally and synced to Drive when online
- 🔒 Least-privilege: uses the Drive `drive.file` scope, so the app can only
  see files **it** creates — never the rest of your Drive

Each note is a readable Markdown file you can open or edit directly in Drive:

```markdown
---
id: l3k9x2-a1b2c3
type: task
created: 2026-06-16T05:57:00.000Z
updated: 2026-06-16T05:57:00.000Z
title: "Groceries"
done: false
due: 2026-06-18
subtasks:
  - text: "Milk"
    done: false
  - text: "Bread"
    done: true
tags: [home, errands]
---
# Groceries

Pick up on the way home.
```

## One-time setup: Google OAuth Client ID

The app needs a Google OAuth **Web Client ID** to access your Drive. This takes
about two minutes and is free.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or pick) a project.
2. **APIs & Services → Enabled APIs → Enable APIs and Services** → enable the
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - Fill in the app name and your email.
   - Add yourself as a **Test user** (your Google account). While the app is in
     "Testing" mode, only test users can sign in — which is exactly what you want
     for a personal app, and it avoids any Google verification.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins** — add every URL you'll open the app from:
     - `http://localhost:8000` (for local testing)
     - `https://<your-username>.github.io` (your GitHub Pages site)
   - Create, then copy the **Client ID** (looks like `…apps.googleusercontent.com`).
5. Open the app → **menu (☰) → Settings**, paste the Client ID, **Save**, then
   **Connect Google Drive**.

You can also hard-code the Client ID in `js/config.js` (it is safe to commit —
for web apps the security boundary is the Authorized origins list, not secrecy
of the ID).

## Run locally

It's a static site — serve the folder over HTTP (a file:// URL won't work with
service workers or Google sign-in):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Make sure `http://localhost:8000` is in your Authorized JavaScript origins.

## Deploy free on GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick your branch and the root (`/`) folder.
3. Your app will be live at `https://<your-username>.github.io/<repo>/`.
4. Add that exact URL to your OAuth **Authorized JavaScript origins**.

## Install on Android

Open the GitHub Pages URL in Chrome → menu → **Add to Home screen**. It launches
full-screen like a native app, with an icon and offline support.

## Project layout

```
index.html              App shell
manifest.webmanifest    PWA manifest
sw.js                   Service worker (offline shell cache)
css/styles.css          Styles
js/
  app.js                UI controller
  config.js             Config + Client ID storage
  auth.js               Google sign-in (GIS token client)
  drive.js              Google Drive REST wrapper
  store.js              IndexedDB cache + sync
  note.js               Note model + Markdown serialization
  frontmatter.js        YAML frontmatter parser/serializer
icons/icon.svg          App icon
```

## Roadmap

- [ ] Reminders & push notifications (needs the small optional backend — the
      `config.apiBaseUrl` hook is already wired for this)
- [ ] Recurring tasks
- [ ] Share/Android intent target for capturing from other apps
- [ ] In-app voice recording + AI transcription/grammar cleanup
- [ ] Sort & group options (by due date, tag, etc.)
