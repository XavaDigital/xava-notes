<?php

namespace App\Console\Commands;

use App\Models\Attachment;
use App\Models\Note;
use App\Notes\Drive;
use App\Notes\MarkdownNote;
use App\Notes\Revisions;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * PLAN.md, Phase 3: copy the notes from the XavaNotes folder in Drive into the database.
 * Each note keeps its id. Drive is only read, never changed. Notes already in the database
 * are skipped, so running it again after an interruption carries on where it stopped.
 */
class ImportDriveCommand extends Command
{
    protected $signature = 'notes:import-drive
        {--dry-run : Read everything and report, but write nothing and download no attachments}
        {--folder=XavaNotes : The Drive folder the app kept its notes in}';

    protected $description = 'Import the notes and attachments from Google Drive';

    public function handle(Drive $drive): int
    {
        $dry = (bool) $this->option('dry-run');
        $folderName = (string) $this->option('folder');

        $folderId = $drive->findFolder($folderName);
        if (! $folderId) {
            $this->error("No '$folderName' folder found in Drive.");

            return self::FAILURE;
        }

        $files = array_values(array_filter($drive->filesIn($folderId), fn ($f) => str_ends_with(strtolower($f['name']), '.md')));
        $this->info(count($files)." note files in '$folderName'.");

        // Read every file.
        $read = [];
        $failed = [];
        $crlf = [];
        $noId = [];
        $bar = $this->output->createProgressBar(count($files));
        foreach ($files as $f) {
            try {
                $text = $drive->download($f['id']);
                $note = MarkdownNote::parse($text, $f['name'], $f['modifiedTime'] ?? '');
                if (str_contains($text, "\r\n")) {
                    $crlf[] = $f['name'];
                }
                if (empty(MarkdownNote::frontmatter($text)['meta']['id'])) {
                    // Named after the Drive file, so a second run finds it again instead of
                    // importing it twice under another random id.
                    $note['id'] = 'drive-'.$f['id'];
                    $noId[] = $f['name'];
                }
                $read[] = ['file' => $f, 'note' => $note];
            } catch (Throwable $e) {
                $failed[] = "{$f['name']}: {$e->getMessage()}";
            }
            $bar->advance();
        }
        $bar->finish();
        $this->newLine(2);

        // One note per id: the newest copy wins.
        $byId = [];
        $duplicates = [];
        foreach ($read as $r) {
            $id = $r['note']['id'];
            if (isset($byId[$id])) {
                [$keep, $drop] = $this->newer($byId[$id], $r) ? [$byId[$id], $r] : [$r, $byId[$id]];
                $byId[$id] = $keep;
                $duplicates[] = sprintf('%s: kept "%s" (updated %s), dropped "%s" (updated %s)',
                    $id, $keep['file']['name'], $keep['note']['updated'], $drop['file']['name'], $drop['note']['updated']);
            } else {
                $byId[$id] = $r;
            }
        }
        $notes = array_column($byId, 'note');
        $existing = Note::query()->whereIn('id', array_keys($byId))->pluck('id')->all();

        $this->table(['From Drive', 'Count'], $this->counts($notes));
        $this->report('Files that could not be read', $failed);
        $this->report('Duplicate ids (the newest copy is kept)', $duplicates);
        $this->report('Files with no id (given one named after the Drive file)', $noId);
        $this->report('Files with Windows line endings (the old app ignored their details; read properly here)', $crlf);
        $this->report('Already in the database (skipped)', $existing);

        if ($dry) {
            $this->info('Dry run: nothing written.');

            return $failed ? self::FAILURE : self::SUCCESS;
        }

        // Write: attachments to disk first, then the note, one note at a time.
        $imported = 0;
        $missing = [];
        foreach ($byId as $id => $r) {
            if (in_array($id, $existing, true)) {
                continue;
            }
            $note = $r['note'];
            $stored = [];
            foreach ($note['attachments'] as $a) {
                try {
                    $stored[] = $this->storeAttachment($drive, $a, $id);
                } catch (Throwable $e) {
                    $missing[] = sprintf('"%s" on "%s": %s', $a['name'], $note['title'] ?: $id, $e->getMessage());
                }
            }
            $note['attachments'] = array_map(fn ($a) => $a->toClient(), $stored);

            DB::transaction(function () use ($id, $note) {
                Revisions::lock();
                Note::create(Note::clientFields($note) + ['id' => $id, 'version' => 1, 'rev' => Revisions::next()]);
            });
            $imported++;
        }

        $this->info("Imported $imported notes.");
        $this->report('Attachments that could not be downloaded (left off the note)', $missing);

        $all = Note::query()->whereNull('purged_at')->get()->map->toClient()->all();
        $this->table(['Now in the database', 'Count'], $this->counts($all));

        return $failed || $missing ? self::FAILURE : self::SUCCESS;
    }

    /** Whether $a is the newer copy of a note than $b. */
    private function newer(array $a, array $b): bool
    {
        return [$a['note']['updated'], $a['file']['modifiedTime'] ?? ''] >= [$b['note']['updated'], $b['file']['modifiedTime'] ?? ''];
    }

    private function storeAttachment(Drive $drive, array $a, string $noteId): Attachment
    {
        $bytes = $drive->download($a['id']);
        $id = Str::lower((string) Str::ulid());
        $path = 'attachments/'.$id;
        if (! Storage::disk('local')->put($path, $bytes)) {
            throw new RuntimeException('could not write to disk');
        }

        return Attachment::create([
            'id' => $id,
            'note_id' => $noteId,
            'name' => $a['name'] ?: 'file',
            'mime' => $a['mime'] ?: 'application/octet-stream',
            'size' => strlen($bytes),
            'path' => $path,
        ]);
    }

    /** The figures PLAN.md's count check compares. */
    private function counts(array $notes): array
    {
        $live = array_filter($notes, fn ($n) => ! $n['deleted']);

        return [
            ['Notes and tasks', count($notes)],
            ['  notes', count(array_filter($live, fn ($n) => $n['type'] === 'note'))],
            ['  tasks', count(array_filter($live, fn ($n) => $n['type'] === 'task'))],
            ['  in Trash', count($notes) - count($live)],
            ['Notebooks', count(array_unique(array_filter(array_map(fn ($n) => mb_strtolower($n['notebook']), $notes))))],
            ['Attachments', array_sum(array_map(fn ($n) => count($n['attachments']), $notes))],
        ];
    }

    private function report(string $title, array $lines): void
    {
        if (! $lines) {
            return;
        }
        $this->warn("$title (".count($lines).'):');
        foreach ($lines as $line) {
            $this->line("  $line");
        }
    }
}
