<?php

return [

    // Largest attachment upload, in KB. PHP's upload_max_filesize and post_max_size on the
    // server must be at least this, or uploads fail before Laravel sees them.
    'attachment_max_kb' => (int) env('NOTES_ATTACHMENT_MAX_KB', 51200),

    // Google Drive, for notes:import-drive (and the nightly backup in Phase 4). The same OAuth
    // client the app always used; the refresh token is the one the old Worker held.
    'google' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'refresh_token' => env('GOOGLE_REFRESH_TOKEN'),
    ],

    // "Email me a copy". Anything blank makes /api/notify answer 502 with the reason.
    'mailgun' => [
        'domain' => env('MAILGUN_DOMAIN'),
        'secret' => env('MAILGUN_SECRET'),
        'endpoint' => env('MAILGUN_ENDPOINT', 'https://api.mailgun.net'),
        'from' => env('MAILGUN_FROM'),
        'to' => env('NOTIFY_EMAIL'),
    ],

];
