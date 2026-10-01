<?php

namespace App\Notes;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/** Sends one email through the Mailgun HTTP API to the owner's address, as the Worker's mail.js did. */
class Mailgun
{
    public function send(string $subject, string $text, string $html = ''): void
    {
        $c = config('notes.mailgun');
        if (blank($c['domain']) || blank($c['secret']) || blank($c['to'])) {
            throw new RuntimeException('Mailgun is not configured (need MAILGUN_DOMAIN, MAILGUN_SECRET, NOTIFY_EMAIL).');
        }

        $response = Http::asForm()
            ->withBasicAuth('api', $c['secret'])
            ->timeout(20)
            ->post(rtrim($c['endpoint'], '/').'/v3/'.$c['domain'].'/messages', array_filter([
                'from' => $c['from'] ?: 'Xava Notes <notes@'.$c['domain'].'>',
                'to' => $c['to'],
                'subject' => $subject,
                'text' => $text,
                'html' => $html,
            ]));

        if (! $response->successful()) {
            throw new RuntimeException('Mailgun '.$response->status().': '.mb_substr($response->body(), 0, 200));
        }
    }
}
