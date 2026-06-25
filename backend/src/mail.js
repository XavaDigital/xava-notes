// Transactional email via the Mailgun HTTP API.
//
// Config (set on the Worker):
//   MAILGUN_API_KEY   secret — your Mailgun private API key
//   MAILGUN_DOMAIN    var    — a verified sending domain, e.g. mg.xavadigital.com
//   NOTIFY_EMAIL      var    — where notifications go (the user's address)
//   MAILGUN_FROM      var    — optional From override; defaults to notes@<domain>
//   MAILGUN_BASE_URL  var    — optional; set to https://api.eu.mailgun.net for EU

export async function sendEmail(env, { subject, text, html }) {
  const domain = env.MAILGUN_DOMAIN;
  const key = env.MAILGUN_API_KEY;
  const to = env.NOTIFY_EMAIL;
  if (!domain || !key || !to) {
    throw new Error('Mailgun not configured (need MAILGUN_DOMAIN, MAILGUN_API_KEY, NOTIFY_EMAIL)');
  }
  const base = (env.MAILGUN_BASE_URL || 'https://api.mailgun.net').replace(/\/+$/, '');
  const from = env.MAILGUN_FROM || `Xava Notes <notes@${domain}>`;

  const body = new URLSearchParams({ from, to, subject, text });
  if (html) body.set('html', html);

  const r = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`api:${key}`) },
    body,
  });
  if (!r.ok) {
    throw new Error(`Mailgun ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return r.json();
}
