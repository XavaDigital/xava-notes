<?php

namespace App\Console\Commands;

use App\Models\Attachment;
use App\Models\Note;
use App\Notes\Drive;
use App\Notes\DriveFileMissing;
use App\Notes\Mailgun;
use App\Notes\MarkdownNote;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * PLAN.md, Phase 4: the nightly backup into Drive. Every note is a Markdown file in the
 * format the app used to write, in a folder of its own; attachments are copied once into a
 * subfolder and the notes point at those copies, so notes:import-drive --folder="XavaNotes
 * backup" restores from it. One-way: nothing is ever read back. A failure is emailed and
 * leaves the app untouched; the next run sends whatever was missed.
 */
class BackupDriveCommand extends Command
{
    protected $signature = 'notes:backup-drive {--folder=XavaNotes backup : The Drive folder to back up into}';

    protected $description = 'Back up every changed note and new attachment to Google Drive';

    private array $errors = [];

    public function handle(Drive $drive, Mailgun $mailgun): int
    {
        $this->errors = [];
        try {
            [$notes, $removed, $attachments] = $this->backup($drive, (string) $this->option('folder'));
            $this->info("Backed up $notes notes and $attachments attachments; moved $removed to Drive's trash.");
            // One line per run in storage/logs/laravel.log, so a run that never happened is noticeable.
            logger()->info('notes:backup-drive finished', ['notes' => $notes, 'attachments' => $attachments, 'trashed' => $removed, 'problems' => count($this->errors)]);
        } catch (Throwable $e) {
            $this->errors[] = $e->getMessage();
        }

        if (! $this->errors) {
            return self::SUCCESS;
        }

        foreach ($this->errors as $error) {
            $this->error($error);
        }
        try {
            $mailgun->send(
                '[Xava Notes] The nightly backup to Drive had problems',
                "The backup to Google Drive did not finish cleanly. The app itself is unaffected, and the next run sends anything missed.\n\n"
                .implode("\n", $this->errors)
                ."\n\nTo run it by hand: php8.3 artisan notes:backup-drive",
            );
        } catch (Throwable $e) {
            report($e);
        }

        return self::FAILURE;
    }

    /** @return array{int, int, int} notes written, notes trashed, attachments copied */
    private function backup(Drive $drive, string $folderName): array
    {
        $folder = $drive->findFolder($folderName) ?? $drive->createFolder($folderName);
        $attFolder = $drive->findFolder('attachments', $folder) ?? $drive->createFolder('attachments', $folder);

        // Attachments first, so the notes can point at their copies.
        $copied = 0;
        foreach (Attachment::query()->whereNull('drive_file_id')->whereNotNull('note_id')->get() as $a) {
            try {
                $a->drive_file_id = $drive->create($a->name, Storage::disk('local')->get($a->path) ?? '', $a->mime, $attFolder, ['attachmentId' => $a->id]);
                $a->save();
                $copied++;
            } catch (Throwable $e) {
                $this->errors[] = "Attachment \"{$a->name}\": {$e->getMessage()}";
            }
        }
        $driveIds = Attachment::query()->whereNotNull('drive_file_id')->pluck('drive_file_id', 'id');

        // Every note written since its last backup. Purged notes only matter if a backup exists.
        $changed = Note::query()
            ->leftJoin('drive_backups', 'drive_backups.note_id', '=', 'notes.id')
            ->where(fn ($q) => $q->whereNull('drive_backups.rev')->orWhereColumn('notes.rev', '>', 'drive_backups.rev'))
            ->where(fn ($q) => $q->whereNull('notes.purged_at')->orWhereNotNull('drive_backups.note_id'))
            ->select('notes.*', 'drive_backups.file_id as backup_file_id')
            ->orderBy('notes.rev')
            ->get();

        $written = 0;
        $removed = 0;
        foreach ($changed as $note) {
            try {
                if ($note->purged_at) {
                    $drive->trash($note->backup_file_id);
                    DB::table('drive_backups')->where('note_id', $note->id)->delete();
                    $removed++;

                    continue;
                }

                $n = $note->toClient();
                $n['attachments'] = array_values(array_filter(array_map(function ($a) use ($driveIds, $n) {
                    if (! isset($driveIds[$a['id']])) {
                        $this->errors[] = 'Note "'.($n['title'] ?: $n['id'])."\": attachment \"{$a['name']}\" has no copy in Drive yet; left out of this backup.";

                        return null;
                    }

                    return ['id' => $driveIds[$a['id']]] + $a;
                }, $n['attachments'])));

                $fileId = $this->write($drive, $note->backup_file_id, $folder, $n);
                DB::table('drive_backups')->upsert(
                    [['note_id' => $note->id, 'file_id' => $fileId, 'rev' => $note->rev, 'created_at' => now(), 'updated_at' => now()]],
                    ['note_id'],
                    ['file_id', 'rev', 'updated_at'],
                );
                $written++;
            } catch (Throwable $e) {
                $this->errors[] = 'Note "'.($note->title ?: $note->id)."\": {$e->getMessage()}";
            }
        }

        return [$written, $removed, $copied];
    }

    /** Update the note's backup file, or create it if there is none (or it was deleted by hand). */
    private function write(Drive $drive, ?string $fileId, string $folder, array $note): string
    {
        $name = MarkdownNote::filename($note);
        $content = MarkdownNote::toMarkdown($note);
        if ($fileId) {
            try {
                $drive->update($fileId, $name, $content, 'text/markdown');

                return $fileId;
            } catch (DriveFileMissing) {
                // Fall through and write a new one.
            }
        }

        return $drive->create($name, $content, 'text/markdown', $folder, ['noteId' => $note['id']]);
    }
}
