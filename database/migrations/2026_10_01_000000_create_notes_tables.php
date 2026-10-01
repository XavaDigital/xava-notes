<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // One note or task per row, keyed by the id the app generates (newId() in js/note.js),
        // so a retried create lands on the same row. Times are the client's ISO strings, kept
        // exactly as sent, so a repeated save compares equal to the stored one.
        Schema::create('notes', function (Blueprint $table) {
            $table->string('id', 100)->primary();
            $table->string('type', 10)->default('note');
            $table->text('title');
            $table->longText('body');
            $table->string('notebook')->default('');
            $table->boolean('done')->default(false);
            $table->string('completed_at', 40)->default('');
            $table->string('due', 40)->default('');
            $table->json('tags');
            $table->json('subtasks');
            $table->json('attachments');
            // In Trash. `deleted_at` is the client's time and may be blank on older notes.
            $table->boolean('deleted')->default(false);
            $table->string('deleted_at', 40)->default('');
            // `order` is a reserved word in MySQL; the API still calls it `order`.
            $table->double('sort_order')->default(0);
            $table->string('created', 40);
            $table->string('updated', 40);
            // Emptied from Trash: the content is gone, the row stays so other devices drop it.
            $table->timestamp('purged_at')->nullable();
            // Goes up by one on every save to this note. The conflict check compares against it.
            $table->unsignedInteger('version')->default(1);
            // The global change number of the last write. Devices pull "everything after rev N".
            $table->unsignedBigInteger('rev')->index();
        });

        Schema::create('attachments', function (Blueprint $table) {
            $table->string('id', 40)->primary();
            // Null until the note it was uploaded for is saved.
            $table->string('note_id', 100)->nullable()->index();
            $table->string('name');
            $table->string('mime')->default('application/octet-stream');
            $table->unsignedBigInteger('size')->default(0);
            $table->string('path');
            $table->timestamps();
        });

        // A single row holding the last rev handed out. Writers lock it, so revs are
        // committed in order and a pull can never skip one that commits late.
        Schema::create('sync_state', function (Blueprint $table) {
            $table->unsignedTinyInteger('id')->primary();
            $table->unsignedBigInteger('rev')->default(0);
        });
        DB::table('sync_state')->insert(['id' => 1, 'rev' => 0]);
    }

    public function down(): void
    {
        Schema::dropIfExists('sync_state');
        Schema::dropIfExists('attachments');
        Schema::dropIfExists('notes');
    }
};
