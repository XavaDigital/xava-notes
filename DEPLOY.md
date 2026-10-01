# Deploying Xava Notes to Cloudways

Target: the existing Cloudways server that runs BM Needs Me (basic PHP stack, PHP 8.3). One new application, its own MySQL database, the app served over https at **https://notes.xava.co.nz**. [BM Needs Me's DEPLOY.md](../BM-Needs-Me/DEPLOY.md) is the reference this follows.

**Use `php8.3` in every command.** The web server runs the app on 8.3, but the plain `php` command over SSH is 8.2 on this server.

**Deploy from the `cloudways` branch, never from `claude/note-todo-app-fnaar3`.** That branch is what GitHub Pages publishes to the phone today. It stays on the Drive version until the notes are moved (PLAN.md, Phase 3).

## 1. Create the application

1. Server → Add Application → PHP (the plain PHP stack, not Laravel or WordPress). Name it `xava-notes`.
2. Application Settings → General: set the **Webroot** to `public_html/public`.
3. Domain Management: add `notes.xava.co.nz` as the primary domain. In Discount Domains (the DNS host for `xava.co.nz`), add an A record: host `notes`, value `139.180.160.90` (the server's IP). Once it resolves, SSL Certificate → Let's Encrypt. The service worker and the secure session cookie both need https.
4. Note the database name, user and password from the application's Access Details.

## 2. Deploy the code

1. Application Management → **Deployment via Git**. Paste the SSH URL of this repository, click **Authenticate**, and add the deploy key Cloudways shows to the GitHub repo (Settings → Deploy keys, read-only).
2. Branch `cloudways`, deployment path left blank so the repo lands in `public_html`.
3. Deploy. Cloudways pulls the code but does not run Composer.

Over SSH (Server → Master Credentials → Launch SSH Terminal), inside `applications/<app folder>/public_html`:

```sh
php8.3 $(which composer) install --no-dev --optimize-autoloader --no-interaction
cp .env.example .env            # first deploy only
php8.3 artisan key:generate     # first deploy only
# edit .env (section 3), then:
php8.3 artisan migrate --force
php8.3 artisan notes:owner david@xavadigital.com 'a-long-password'
```

Do not run `config:cache` or `route:cache`. Laravel never checks those caches for changes, so after the next pull the site would serve stale routes or settings until someone rebuilds them.

After a later deploy, only when the change needs it: `php8.3 artisan migrate --force` for new migrations, `php8.3 $(which composer) install --no-dev --optimize-autoloader` when `composer.lock` changed. A change to the app's own files in `public/` needs nothing beyond the pull.

If a command fails with "Permission denied" on `storage/`, use Application Settings → General → **Reset Permission**, then run it again.

## 3. Environment

| Key | What |
|---|---|
| `APP_ENV`, `APP_DEBUG` | `production` and `false`. The template ships with `local` and `true`, which shows stack traces and settings on any error page. |
| `APP_URL` | `https://notes.xava.co.nz` |
| `DB_*` | `DB_CONNECTION=mysql` and the details from step 1. |
| `SESSION_SECURE_COOKIE` | `true`. |
| `MAILGUN_DOMAIN`, `MAILGUN_SECRET` | The same values the Worker uses (they are in `.env.worker` on David's machine). |
| `MAILGUN_ENDPOINT` | `https://api.eu.mailgun.net` if the Mailgun account is in the EU region; otherwise leave the default. |
| `NOTIFY_EMAIL` | Where "email me a copy" sends. |
| `NOTES_ATTACHMENT_MAX_KB` | Largest attachment in KB. Default 51200 (50 MB). See section 4. |

## 4. Upload size

PHP refuses uploads above `upload_max_filesize` and `post_max_size` before Laravel sees them. If attaching a large file fails, raise both to at least the `NOTES_ATTACHMENT_MAX_KB` size under Application Settings → PHP FPM Settings (for example `php_admin_value[upload_max_filesize] = 50M` and `php_admin_value[post_max_size] = 55M`). This changes only this application, not the other sites on the server.

## 5. Cron (from Phase 4)

Nothing is scheduled until the nightly backup to Drive exists. When it does, Application Management → **Cron Job Management** → Advanced tab, one line:

```
* * * * * cd /home/master/applications/<app folder>/public_html && /usr/bin/php8.3 artisan schedule:run >> /dev/null 2>&1
```

## 6. Backups

The notes live in this application's MySQL database and the attachments in `storage/app/private/attachments` inside the application folder. Both are covered by Cloudways' server backups, which must be switched on (Server → Backups). Check the frequency there.

## 7. Check it

1. `curl -I https://notes.xava.co.nz/up` answers 200.
2. `https://notes.xava.co.nz/login` shows the sign-in page; the `notes:owner` details sign in and land on the app.
3. `https://notes.xava.co.nz/api/notes` answers 401 in a private window.

Until Phase 2 is deployed, the app on the subdomain is still the Drive version of the client. Do not use it for real notes before then.
