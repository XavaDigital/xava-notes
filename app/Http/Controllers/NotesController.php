<?php

namespace App\Http\Controllers;

use App\Models\Attachment;
use App\Models\Note;
use App\Notes\Revisions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class NotesController extends Controller
{
    /**
     * GET /api/notes?after=<rev>: every note written after that rev, oldest change first,
     * and the rev to ask after next time. A first load (after=0) leaves out purged markers,
     * since a new device has nothing to drop.
     */
    public function index(Request $request): JsonResponse
    {
        $after = max(0, (int) $request->query('after', 0));

        // Read the counter and the rows in one transaction so they come from the same snapshot.
        return DB::transaction(function () use ($after) {
            $rev = Revisions::current();
            $notes = Note::query()
                ->where('rev', '>', $after)
                ->where('rev', '<=', $rev)
                ->when($after === 0, fn ($q) => $q->whereNull('purged_at'))
                ->orderBy('rev')
                ->get();

            return response()->json([
                'notes' => $notes->map->toClient()->values(),
                'rev' => $rev,
            ]);
        });
    }

    /**
     * PUT /api/notes/{id} with { base_version, note }: create or update.
     *
     * - New id: created at version 1.
     * - Same content as stored: nothing written, 200 with the stored version. This is what
     *   makes a retried save safe, whatever base it carries.
     * - base_version behind the stored version: 409 with the stored note, for the app's
     *   conflict prompt. "Overwrite" resends with the stored version as its base.
     * - Otherwise: written, version up by one, new rev.
     */
    public function put(Request $request, string $id): JsonResponse
    {
        $request->validate([
            'base_version' => ['nullable', 'integer', 'min:0'],
            'note' => ['required', 'array'],
            'note.id' => ['nullable', 'string', 'in:'.$id],
            'note.type' => ['nullable', 'string', 'in:note,task'],
            'note.title' => ['nullable', 'string'],
            'note.body' => ['nullable', 'string'],
            'note.notebook' => ['nullable', 'string', 'max:255'],
            'note.done' => ['nullable', 'boolean'],
            'note.completedAt' => ['nullable', 'string', 'max:40'],
            'note.due' => ['nullable', 'string', 'max:40'],
            'note.tags' => ['nullable', 'array'],
            'note.tags.*' => ['string', 'max:255'],
            'note.subtasks' => ['nullable', 'array'],
            'note.subtasks.*' => ['array'],
            'note.attachments' => ['nullable', 'array'],
            'note.attachments.*' => ['array'],
            'note.attachments.*.id' => ['required', 'string'],
            'note.deleted' => ['nullable', 'boolean'],
            'note.deletedAt' => ['nullable', 'string', 'max:40'],
            'note.order' => ['nullable', 'numeric'],
            'note.created' => ['required', 'string', 'max:40'],
            'note.updated' => ['required', 'string', 'max:40'],
        ]);

        $fields = Note::clientFields($request->input('note'));
        $base = (int) $request->input('base_version', 0);

        return DB::transaction(function () use ($id, $fields, $base) {
            Revisions::lock();
            $note = Note::query()->lockForUpdate()->find($id);

            if ($note && ! $note->purged_at && $note->sameContentAs($fields)) {
                return response()->json(['version' => $note->version, 'rev' => $note->rev]);
            }

            if ($note && $base < $note->version) {
                return response()->json(['error' => 'conflict', 'note' => $note->toClient()], 409);
            }

            $note ??= new Note(['id' => $id]);
            $note->fill($fields + [
                'purged_at' => null,
                'version' => $note->exists ? max($note->version, $base) + 1 : 1,
                'rev' => Revisions::next(),
            ])->save();

            // Claim uploaded attachments for this note, so purging it removes them too.
            $ids = array_column($fields['attachments'], 'id');
            if ($ids) {
                Attachment::query()->whereIn('id', $ids)->whereNull('note_id')->update(['note_id' => $id]);
            }

            return response()->json(['version' => $note->version, 'rev' => $note->rev]);
        });
    }

    /**
     * DELETE /api/notes/{id}: empty it from Trash. The content and its attachments go; the row
     * stays as a marker so other devices drop the note on their next pull. Repeating it is a no-op.
     */
    public function destroy(string $id): JsonResponse
    {
        return DB::transaction(function () use ($id) {
            Revisions::lock();
            $note = Note::query()->lockForUpdate()->find($id);

            if (! $note || $note->purged_at) {
                return response()->json(['ok' => true]);
            }

            $ids = array_column($note->attachments ?? [], 'id');
            Attachment::query()
                ->where('note_id', $id)
                ->orWhereIn('id', $ids)
                ->get()
                ->each->purge();

            $note->fill([
                'title' => '',
                'body' => '',
                'tags' => [],
                'subtasks' => [],
                'attachments' => [],
                'purged_at' => now(),
                'version' => $note->version + 1,
                'rev' => Revisions::next(),
            ])->save();

            return response()->json(['ok' => true]);
        });
    }
}
