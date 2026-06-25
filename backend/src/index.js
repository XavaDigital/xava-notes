// Xava Notes API — Cloudflare Worker.
//
// Endpoints (all JSON; all except the two public ones require
//   Authorization: Bearer <deviceToken>):
//   GET  /push/vapid-public-key            (public) -> { key }
//   POST /auth/exchange                    (public) { code, redirectUri, codeVerifier? }
//                                            -> { deviceToken, accessToken, expiresIn }
//   POST /auth/access-token                -> { accessToken, expiresIn }  (mint from refresh token)
//   POST /push/subscribe                   { subscription }
//   POST /push/unsubscribe                 { endpoint }
//   POST /notify                           { title, type, body?, due?, notebook? }  (emails the user)
//   GET  /reminders                        -> { reminders }
//   PUT  /reminders                        { id, noteId?, title, dueAt }
//   DELETE /reminders/:id
//   POST /outbox                           { op:'put'|'delete', noteId?, fileId?, name?, content?, appProperties? }
//                                            -> { id, status, fileId? }
//
// scheduled() runs every minute: flush the outbox to Drive, send due reminders.

import * as google from './google.js';
import { sendPush } from './webpush.js';
import { sendEmail } from './mail.js';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}

async function getConfig(env, k) {
  const row = await env.DB.prepare('SELECT v FROM config WHERE k=?').bind(k).first();
  return row ? row.v : null;
}
async function setConfig(env, k, v) {
  await env.DB.prepare('INSERT INTO config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .bind(k, v).run();
}
async function authed(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const stored = await getConfig(env, 'device_token');
  return !!token && !!stored && token === stored;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Build a subject/text/html email from a saved note/task payload.
function formatNoteEmail(n) {
  const kind = n.type === 'task' ? 'Task' : 'Note';
  const title = (n.title || '').trim() || '(untitled)';
  const subject = `[Xava ${kind}] ${title}`;
  const meta = [
    n.notebook ? `Notebook: ${n.notebook}` : '',
    n.due ? `${n.type === 'task' ? 'Due' : 'Date'}: ${n.due}` : '',
  ].filter(Boolean).join('\n');
  const bodyText = (n.body || '').trim();
  const text = [title, meta, bodyText].filter(Boolean).join('\n\n');
  const html =
    `<h2 style="margin:0 0 8px">${escHtml(title)}</h2>` +
    (meta ? `<p style="color:#666;margin:0 0 12px">${escHtml(meta).replace(/\n/g, '<br>')}</p>` : '') +
    (bodyText ? `<div style="white-space:pre-wrap">${escHtml(bodyText)}</div>` : '');
  return { subject, text, html };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // --- Public ---
      if (req.method === 'GET' && path === '/push/vapid-public-key') {
        return json({ key: env.VAPID_PUBLIC_KEY }, 200, env);
      }
      if (req.method === 'POST' && path === '/auth/exchange') {
        const { code, redirectUri, codeVerifier } = await req.json();
        const tok = await google.exchangeCode(env, code, redirectUri, codeVerifier);
        if (tok.refresh_token) await setConfig(env, 'refresh_token', tok.refresh_token);
        let device = await getConfig(env, 'device_token');
        if (!device) { device = crypto.randomUUID().replace(/-/g, ''); await setConfig(env, 'device_token', device); }
        return json({ deviceToken: device, accessToken: tok.access_token, expiresIn: tok.expires_in }, 200, env);
      }

      // --- Authenticated ---
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401, env);

      if (req.method === 'POST' && path === '/auth/access-token') {
        const rt = await getConfig(env, 'refresh_token');
        if (!rt) return json({ error: 'no refresh token' }, 400, env);
        const tok = await google.refreshAccessToken(env, rt);
        return json({ accessToken: tok.access_token, expiresIn: tok.expires_in }, 200, env);
      }

      if (req.method === 'POST' && path === '/push/subscribe') {
        const { subscription } = await req.json();
        await env.DB.prepare(
          'INSERT INTO subscriptions (endpoint,p256dh,auth,created_at) VALUES (?,?,?,?) ' +
          'ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth'
        ).bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()).run();
        return json({ ok: true }, 200, env);
      }
      if (req.method === 'POST' && path === '/push/unsubscribe') {
        const { endpoint } = await req.json();
        await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint=?').bind(endpoint).run();
        return json({ ok: true }, 200, env);
      }

      if (req.method === 'POST' && path === '/notify') {
        const n = await req.json(); // { title, type, body, due, notebook }
        await sendEmail(env, formatNoteEmail(n));
        return json({ ok: true }, 200, env);
      }

      if (path === '/reminders' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE sent=0 ORDER BY due_at').all();
        return json({ reminders: results }, 200, env);
      }
      if (path === '/reminders' && req.method === 'PUT') {
        const { id, noteId, title, dueAt } = await req.json();
        await env.DB.prepare(
          'INSERT INTO reminders (id,note_id,title,due_at,sent,created_at) VALUES (?,?,?,?,0,?) ' +
          'ON CONFLICT(id) DO UPDATE SET title=excluded.title, due_at=excluded.due_at, note_id=excluded.note_id, sent=0'
        ).bind(id, noteId || null, title, dueAt, Date.now()).run();
        return json({ ok: true }, 200, env);
      }
      if (req.method === 'DELETE' && path.startsWith('/reminders/')) {
        const id = decodeURIComponent(path.split('/').pop());
        await env.DB.prepare('DELETE FROM reminders WHERE id=?').bind(id).run();
        return json({ ok: true }, 200, env);
      }

      if (req.method === 'POST' && path === '/outbox') {
        const b = await req.json();
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO outbox (id,op,note_id,file_id,name,content,app_props,status,attempts,created_at,updated_at) ' +
          "VALUES (?,?,?,?,?,?,?,'pending',0,?,?)"
        ).bind(id, b.op, b.noteId || null, b.fileId || null, b.name || null, b.content || null,
          JSON.stringify(b.appProperties || {}), Date.now(), Date.now()).run();
        // Process immediately so the client gets the resulting fileId; on failure
        // it stays queued and the cron retries it.
        try {
          const row = await env.DB.prepare('SELECT * FROM outbox WHERE id=?').bind(id).first();
          const result = await processOutbox(env, row);
          return json({ id, status: 'done', fileId: (result && result.fileId) || b.fileId || null }, 200, env);
        } catch (e) {
          await env.DB.prepare('UPDATE outbox SET attempts=attempts+1, last_error=?, updated_at=? WHERE id=?')
            .bind(String((e && e.message) || e), Date.now(), id).run();
          return json({ id, status: 'queued' }, 202, env);
        }
      }

      return json({ error: 'not found' }, 404, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await flushOutbox(env);
      await sendDueReminders(env);
    })());
  },
};

async function freshToken(env) {
  const rt = await getConfig(env, 'refresh_token');
  if (!rt) throw new Error('no refresh token stored');
  const tok = await google.refreshAccessToken(env, rt);
  return tok.access_token;
}

async function processOutbox(env, row) {
  const token = await freshToken(env);
  const appProps = JSON.parse(row.app_props || '{}');
  const result = {};
  if (row.op === 'delete') {
    if (row.file_id) await google.trashFile(token, row.file_id);
  } else {
    if (row.file_id) result.fileId = (await google.updateFile(token, row.file_id, row.name, row.content, appProps)).id;
    else result.fileId = (await google.createFile(token, row.name, row.content, appProps)).id;
  }
  await env.DB.prepare('UPDATE outbox SET status=?, result_file_id=?, updated_at=? WHERE id=?')
    .bind('done', result.fileId || row.file_id || null, Date.now(), row.id).run();
  return result;
}

async function flushOutbox(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM outbox WHERE status IN ('pending','error') AND attempts < 6 ORDER BY created_at LIMIT 25"
  ).all();
  for (const row of results) {
    try {
      await processOutbox(env, row);
    } catch (e) {
      await env.DB.prepare('UPDATE outbox SET status=?, attempts=attempts+1, last_error=?, updated_at=? WHERE id=?')
        .bind('error', String((e && e.message) || e), Date.now(), row.id).run();
    }
  }
}

async function sendDueReminders(env) {
  const now = Date.now();
  const { results: due } = await env.DB.prepare('SELECT * FROM reminders WHERE sent=0 AND due_at <= ?').bind(now).all();
  if (!due.length) return;
  const { results: subs } = await env.DB.prepare('SELECT * FROM subscriptions').all();
  for (const rem of due) {
    for (const s of subs) {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        const status = await sendPush(env, subscription, { title: rem.title, noteId: rem.note_id, dueAt: rem.due_at });
        if (status === 404 || status === 410) {
          await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint=?').bind(s.endpoint).run();
        }
      } catch (e) { /* ignore individual push failures */ }
    }
    await env.DB.prepare('UPDATE reminders SET sent=1 WHERE id=?').bind(rem.id).run();
  }
}
