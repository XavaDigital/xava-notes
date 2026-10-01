<?php

namespace App\Http\Controllers;

use App\Notes\Mailgun;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class NotifyController extends Controller
{
    /** POST /api/notify { title, type, body?, due?, notebook? }: email a copy of a note or task. */
    public function store(Request $request, Mailgun $mailgun): JsonResponse
    {
        $n = $request->validate([
            'title' => ['nullable', 'string'],
            'type' => ['nullable', 'string'],
            'body' => ['nullable', 'string'],
            'due' => ['nullable', 'string'],
            'notebook' => ['nullable', 'string'],
        ]);

        try {
            $mailgun->send(...self::format($n));
        } catch (RuntimeException $e) {
            report($e);

            return response()->json(['error' => $e->getMessage()], 502);
        }

        return response()->json(['ok' => true]);
    }

    /**
     * Subject, text and HTML for a note, as the Worker's formatNoteEmail() built them.
     *
     * @return array{subject: string, text: string, html: string}
     */
    public static function format(array $n): array
    {
        $isTask = ($n['type'] ?? '') === 'task';
        $title = trim((string) ($n['title'] ?? '')) ?: '(untitled)';
        $meta = implode("\n", array_filter([
            ($n['notebook'] ?? '') !== '' ? 'Notebook: '.$n['notebook'] : '',
            ($n['due'] ?? '') !== '' ? ($isTask ? 'Due' : 'Date').': '.$n['due'] : '',
        ]));
        $body = trim((string) ($n['body'] ?? ''));
        $e = fn (string $s) => htmlspecialchars($s, ENT_QUOTES);

        return [
            'subject' => '[Xava '.($isTask ? 'Task' : 'Note').'] '.$title,
            'text' => implode("\n\n", array_filter([$title, $meta, $body])),
            'html' => '<h2 style="margin:0 0 8px">'.$e($title).'</h2>'
                .($meta !== '' ? '<p style="color:#666;margin:0 0 12px">'.nl2br($e($meta), false).'</p>' : '')
                .($body !== '' ? '<div style="white-space:pre-wrap">'.$e($body).'</div>' : ''),
        ];
    }
}
