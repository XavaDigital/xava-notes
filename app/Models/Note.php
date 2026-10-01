<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A note or task. The API speaks the app's own note shape (js/note.js); toClient() and
 * clientFields() translate between that and the columns.
 */
class Note extends Model
{
    public $incrementing = false;

    public $timestamps = false;

    protected $keyType = 'string';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'done' => 'boolean',
            'deleted' => 'boolean',
            'tags' => 'array',
            'subtasks' => 'array',
            'attachments' => 'array',
            'sort_order' => 'float',
            'purged_at' => 'datetime',
            'version' => 'integer',
            'rev' => 'integer',
        ];
    }

    /**
     * Normalise a note as the app sends it into column values. The same normalisation is
     * applied to what is stored, so a repeated save compares equal field by field.
     *
     * @param  array<string, mixed>  $n
     * @return array<string, mixed>
     */
    public static function clientFields(array $n): array
    {
        return [
            'type' => ($n['type'] ?? '') === 'task' ? 'task' : 'note',
            'title' => (string) ($n['title'] ?? ''),
            'body' => (string) ($n['body'] ?? ''),
            'notebook' => (string) ($n['notebook'] ?? ''),
            'done' => (bool) ($n['done'] ?? false),
            'completed_at' => (string) ($n['completedAt'] ?? ''),
            'due' => (string) ($n['due'] ?? ''),
            'tags' => array_values(array_map('strval', $n['tags'] ?? [])),
            'subtasks' => array_values(array_map(fn ($s) => [
                'text' => (string) ($s['text'] ?? ''),
                'done' => (bool) ($s['done'] ?? false),
            ], $n['subtasks'] ?? [])),
            'attachments' => array_values(array_map(fn ($a) => [
                'id' => (string) ($a['id'] ?? ''),
                'name' => (string) ($a['name'] ?? ''),
                'mime' => (string) ($a['mime'] ?? ''),
                'size' => (int) ($a['size'] ?? 0),
            ], $n['attachments'] ?? [])),
            'deleted' => (bool) ($n['deleted'] ?? false),
            'deleted_at' => (string) ($n['deletedAt'] ?? ''),
            'sort_order' => (float) ($n['order'] ?? 0),
            'created' => (string) ($n['created'] ?? ''),
            'updated' => (string) ($n['updated'] ?? ''),
        ];
    }

    /**
     * Whether saving these fields would change nothing. The stored note goes through the same
     * normalisation first: MySQL re-sorts the keys inside JSON objects, so the raw columns
     * would not compare equal to what was sent.
     */
    public function sameContentAs(array $fields): bool
    {
        return self::clientFields($this->toClient()) === $fields;
    }

    /** The note as the app holds it, plus the server's version and rev. Purged notes are a bare marker. */
    public function toClient(): array
    {
        if ($this->purged_at) {
            return ['id' => $this->id, 'purged' => true, 'version' => $this->version, 'rev' => $this->rev];
        }

        return [
            'id' => $this->id,
            'type' => $this->type,
            'title' => $this->title,
            'body' => $this->body,
            'notebook' => $this->notebook,
            'done' => $this->done,
            'completedAt' => $this->completed_at,
            'due' => $this->due,
            'tags' => $this->tags,
            'subtasks' => $this->subtasks,
            'attachments' => $this->attachments,
            'deleted' => $this->deleted,
            'deletedAt' => $this->deleted_at,
            'order' => $this->sort_order,
            'created' => $this->created,
            'updated' => $this->updated,
            'version' => $this->version,
            'rev' => $this->rev,
        ];
    }
}
