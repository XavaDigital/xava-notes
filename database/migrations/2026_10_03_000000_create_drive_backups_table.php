<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // What the nightly backup to Drive has written: one file per note, and the rev it
        // was written at, so each run only sends what changed since.
        Schema::create('drive_backups', function (Blueprint $table) {
            $table->string('note_id', 100)->primary();
            $table->string('file_id');
            $table->unsignedBigInteger('rev');
            $table->timestamps();
        });

        // The attachment's copy in the backup folder. The backed-up notes point at these, so
        // notes:import-drive can restore from the backup folder as it imported from the old one.
        Schema::table('attachments', function (Blueprint $table) {
            $table->string('drive_file_id')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('attachments', fn (Blueprint $table) => $table->dropColumn('drive_file_id'));
        Schema::dropIfExists('drive_backups');
    }
};
