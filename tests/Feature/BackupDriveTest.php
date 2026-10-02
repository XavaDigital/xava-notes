<?php

namespace Tests\Feature;

use App\Models\Attachment;
use App\Models\Note;
use App\Models\User;
use App\Notes\Drive;
use App\Notes\MarkdownNote;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\Support\FakeDrive;
use Tests\TestCase;

class BackupDriveTest extends TestCase
{
    use RefreshDatabase;

    private FakeDrive $drive;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Http::fake(['api.mailgun.net/*' => Http::response(['id' => 'x'])]);
        $this->drive = new FakeDrive;
        $this->app->instance(Drive::class, $this->drive);
        $this->actingAs(User::factory()->create());
    }

    private function save(array $overrides): array
    {
        $note = $overrides + [
            'type' => 'note', 'title' => '', 'body' => '', 'notebook' => '', 'done' => false, 'completedAt' => '',
            'due' => '', 'tags' => [], 'subtasks' => [], 'attachments' => [], 'deleted' => false, 'deletedAt' => '',
            'order' => 0, 'created' => '2026-09-01T09:00:00.000Z', 'updated' => '2026-09-02T09:00:00.000Z',
        ];
        $base = Note::find($note['id'])?->version ?? 0;
        $this->putJson("/api/notes/{$note['id']}", ['base_version' => $base, 'note' => $note])->assertOk();

        return $note;
    }

    private function seedNotes(): void
    {
        $file = $this->post('/api/attachments', ['file' => UploadedFile::fake()->createWithContent('receipt.pdf', 'PDF bytes')])->json();
        $this->save(['id' => 'n1', 'type' => 'task', 'title' => 'Ring the bank', 'body' => "About the **loan**.\n", 'notebook' => 'Home',
            'done' => true, 'completedAt' => '2026-09-03T00:00:00.000Z', 'tags' => ['money'], 'order' => 3.5,
            'subtasks' => [['text' => 'Find number', 'done' => true]]]);
        $this->save(['id' => 'n2', 'title' => 'Receipt', 'body' => 'see file', 'attachments' => [$file]]);
        $this->save(['id' => 'n3', 'title' => 'Old idea', 'deleted' => true, 'deletedAt' => '2026-09-04T00:00:00.000Z']);
    }

    private function backupFolder(): string
    {
        return $this->drive->findFolder('XavaNotes backup');
    }

    public function test_every_note_is_written_in_the_apps_markdown_format_with_attachments_copied(): void
    {
        $this->seedNotes();

        $this->artisan('notes:backup-drive')
            ->expectsOutputToContain('Backed up 3 notes and 1 attachments')
            ->assertSuccessful();

        $folder = $this->backupFolder();
        $this->assertSame(['Old idea.md', 'Receipt.md', 'Ring the bank.md'], $this->drive->namesIn($folder));

        $task = Note::find('n1')->toClient();
        $file = collect($this->drive->files)->firstWhere('name', 'Ring the bank.md');
        $this->assertSame(MarkdownNote::toMarkdown($task), $file['content']);
        $this->assertSame('n1', $file['appProperties']['noteId']);

        // The attachment is copied once, and the backed-up note points at the copy.
        $attFolder = $this->drive->findFolder('attachments', $folder);
        $copy = $this->drive->filesIn($attFolder)[0];
        $this->assertSame(['receipt.pdf', 'PDF bytes'], [$copy['name'], $this->drive->download($copy['id'])]);
        $receipt = collect($this->drive->files)->firstWhere('name', 'Receipt.md')['content'];
        $this->assertStringContainsString('id: "'.$copy['id'].'"', $receipt);
        Http::assertNothingSent();
    }

    public function test_the_next_run_sends_only_what_changed_and_trashes_what_was_emptied_from_trash(): void
    {
        $this->seedNotes();
        $this->artisan('notes:backup-drive');
        $before = count($this->drive->files);

        $this->artisan('notes:backup-drive')->expectsOutputToContain('Backed up 0 notes and 0 attachments');
        $this->assertCount($before, $this->drive->files);

        $this->save(['id' => 'n1', 'type' => 'task', 'title' => 'Ring the bank today', 'updated' => '2026-09-05T00:00:00.000Z']);
        $this->deleteJson('/api/notes/n3')->assertOk();

        $this->artisan('notes:backup-drive')
            ->expectsOutputToContain('Backed up 1 notes and 0 attachments; moved 1 to Drive\'s trash')
            ->assertSuccessful();

        $this->assertSame(['Receipt.md', 'Ring the bank today.md'], $this->drive->namesIn($this->backupFolder()));
        $this->assertCount($before, $this->drive->files, 'the changed note was updated in place, not added');
    }

    public function test_a_backup_file_deleted_by_hand_is_written_again(): void
    {
        $this->seedNotes();
        $this->artisan('notes:backup-drive');
        $id = DB::table('drive_backups')->where('note_id', 'n2')->value('file_id');
        $this->drive->trash($id);
        $this->save(['id' => 'n2', 'title' => 'Receipt', 'body' => 'edited', 'updated' => '2026-09-06T00:00:00.000Z',
            'attachments' => Note::find('n2')->attachments]);

        $this->artisan('notes:backup-drive')->assertSuccessful();

        $this->assertContains('Receipt.md', $this->drive->namesIn($this->backupFolder()));
        $this->assertNotSame($id, DB::table('drive_backups')->where('note_id', 'n2')->value('file_id'));
    }

    public function test_a_failure_is_emailed_and_the_next_run_catches_up(): void
    {
        $this->seedNotes();
        $this->drive->failUploadsNamed = ['Receipt.md'];

        $this->artisan('notes:backup-drive')->assertFailed();

        Http::assertSent(fn (Request $r) => str_contains($r['subject'] ?? '', 'nightly backup to Drive had problems')
            && str_contains($r['text'], 'Note "Receipt": Drive 500 uploading \'Receipt.md\''));
        $this->assertSame(['Old idea.md', 'Ring the bank.md'], $this->drive->namesIn($this->backupFolder()));

        $this->drive->failUploadsNamed = [];
        $this->artisan('notes:backup-drive')->expectsOutputToContain('Backed up 1 notes')->assertSuccessful();
        $this->assertSame(['Old idea.md', 'Receipt.md', 'Ring the bank.md'], $this->drive->namesIn($this->backupFolder()));
    }

    public function test_the_backup_restores_with_the_import_command(): void
    {
        $this->seedNotes();
        $this->artisan('notes:backup-drive')->assertSuccessful();
        $original = Note::query()->orderBy('id')->get()->map->toClient()->all();

        // Lose everything on the server.
        Note::query()->delete();
        Attachment::query()->delete();
        DB::table('drive_backups')->delete();
        foreach (Storage::disk('local')->allFiles() as $f) {
            Storage::disk('local')->delete($f);
        }

        $this->artisan('notes:import-drive', ['--folder' => 'XavaNotes backup'])
            ->expectsOutputToContain('Imported 3 notes.')
            ->assertSuccessful();

        $restored = Note::query()->orderBy('id')->get()->map->toClient()->all();
        $strip = fn ($n) => array_diff_key($n, ['rev' => 1, 'version' => 1, 'attachments' => 1]);
        $this->assertEquals(array_map($strip, $original), array_map($strip, $restored));

        $att = Attachment::find(Note::find('n2')->attachments[0]['id']);
        $this->assertSame(['receipt.pdf', 'PDF bytes'], [$att->name, Storage::disk('local')->get($att->path)]);
    }
}
