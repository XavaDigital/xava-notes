// App configuration.
//
// The Google OAuth Client ID is PUBLIC for web apps (security comes from the
// list of Authorized JavaScript origins you set in Google Cloud Console), so it
// is safe to commit. You can either hard-code it below, or leave it blank and
// paste it into the in-app Settings screen (stored in localStorage).

export const CONFIG = {
  // Optional default. Leave '' to require entering it in Settings.
  googleClientId: '',

  // drive.file = the app can only see and manage files it creates itself.
  // This is the least-privilege Drive scope and needs no Google verification.
  driveScope: 'https://www.googleapis.com/auth/drive.file',

  // Name of the Drive folder where notes live.
  appFolderName: 'XavaNotes',

  // Reserved for a future backend (reminders / push notifications).
  // Leave '' for fully serverless mode.
  apiBaseUrl: '',
};

const LS_CLIENT_ID = 'xn.clientId';

export function getClientId() {
  return localStorage.getItem(LS_CLIENT_ID) || CONFIG.googleClientId || '';
}

export function setClientId(id) {
  localStorage.setItem(LS_CLIENT_ID, (id || '').trim());
}
