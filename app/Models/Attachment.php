<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

/** A file attached to a note, kept on the server's disk under storage/app/private/attachments. */
class Attachment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['size' => 'integer'];
    }

    /** The shape the note's `attachments` list holds. */
    public function toClient(): array
    {
        return ['id' => $this->id, 'name' => $this->name, 'mime' => $this->mime, 'size' => $this->size];
    }

    /** Remove the file and the row. */
    public function purge(): void
    {
        Storage::disk('local')->delete($this->path);
        $this->delete();
    }
}
