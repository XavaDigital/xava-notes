<?php

namespace App\Http\Controllers;

use App\Models\Attachment;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\HeaderUtils;

class AttachmentsController extends Controller
{
    /** Types the browser may show in place. Anything else downloads. */
    private const INLINE = ['image/', 'application/pdf', 'text/plain', 'text/markdown', 'audio/', 'video/'];

    /**
     * POST /api/attachments (multipart: file): store an upload and return its entry for the
     * note's `attachments` list. The app uploads before the note is saved, so the attachment
     * belongs to no note until the note's next save names it.
     */
    public function store(Request $request): JsonResponse
    {
        $request->validate([
            'file' => ['required', 'file', 'max:'.config('notes.attachment_max_kb')],
        ]);

        $file = $request->file('file');
        $id = Str::lower((string) Str::ulid());
        $path = $file->storeAs('attachments', $id, 'local');

        $attachment = Attachment::create([
            'id' => $id,
            'name' => $file->getClientOriginalName() ?: 'file',
            'mime' => $file->getClientMimeType() ?: 'application/octet-stream',
            'size' => $file->getSize(),
            'path' => $path,
        ]);

        return response()->json($attachment->toClient(), 201);
    }

    /**
     * GET /api/attachments/{attachment}: the file. Sandboxed so an uploaded page cannot run script here.
     *
     * Sent whole rather than streamed: the server's PHP has fpassthru() disabled, which
     * Laravel's streamed file responses rely on. Attachments are capped at 50 MB.
     */
    public function show(Attachment $attachment): Response
    {
        $inline = Str::startsWith($attachment->mime, self::INLINE);
        $fallbackName = preg_replace('/[^A-Za-z0-9._ -]/', '_', Str::ascii($attachment->name)) ?: 'file';

        return response(Storage::disk('local')->get($attachment->path), 200, [
            'Content-Type' => $attachment->mime,
            'Content-Disposition' => HeaderUtils::makeDisposition($inline ? 'inline' : 'attachment', $attachment->name, $fallbackName),
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => 'sandbox',
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }

    /** DELETE /api/attachments/{id}: remove it. Repeating it is a no-op. */
    public function destroy(string $id): JsonResponse
    {
        Attachment::find($id)?->purge();

        return response()->json(['ok' => true]);
    }
}
