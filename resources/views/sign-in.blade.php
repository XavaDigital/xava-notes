<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#11141a">
<title>Sign in · Xava Notes</title>
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<style>
:root{--bg:#0e1116;--surface:#181c24;--border:#2a313d;--text:#e6e9ef;--muted:#8b94a3;--accent:#4f8cff;--danger:#ff5f56}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg)}
body{color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:380px;margin:0 auto;padding:18vh 16px 56px}
h1{font-size:22px;margin:0 0 16px}
form{display:grid;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px}
label{font-size:14px;color:var(--muted)}
input{font:inherit;padding:11px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);width:100%}
input:focus{outline:none;border-color:var(--accent)}
button{font:inherit;font-weight:600;padding:11px 14px;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer;margin-top:4px}
.err{color:var(--danger);font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Xava Notes</h1>
  <form method="post" action="{{ route('login.store') }}">
    @csrf
    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="{{ old('email') }}" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    @error('email')<div class="err">{{ $message }}</div>@enderror
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>
