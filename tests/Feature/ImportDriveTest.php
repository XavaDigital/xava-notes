<?php

namespace Tests\Feature;

use App\Models\Attachment;
use App\Models\Note;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class ImportDriveTest extends TestCase
{
    use RefreshDatabase;

    /** Files in the fake Drive: id => [name, contents, modifiedTime]. */
    private array $files = [];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        config(['notes.google' => ['client_id' => 'cid', 'client_secret' => 'secret', 'refresh_token' => 'rt']]);

        $this->files = [
            'f-task' => ['Ring the bank.md', $this->md('task-1', 'Ring the bank', 'task', '2026-09-02T00:00:00.000Z', "notebook: \"Home\"\ndone: true\ntags: [money]\nsubtasks:\n  - text: \"Find number\"\n    done: true\n"), '2026-09-02T00:00:01Z'],
            'f-receipt' => ['Receipt.md', $this->md('note-1', 'Receipt', 'note', '2026-09-03T00:00:00.000Z', "attachments:\n  - id: \"d-att\"\n    name: \"receipt.pdf\"\n    mime: \"application/pdf\"\n    size: 3\n  - id: \"d-gone\"\n    name: \"lost.jpg\"\n    mime: \"image/jpeg\"\n    size: 9\n"), '2026-09-03T00:00:01Z'],
            'f-old' => ['Idea.md', $this->md('dup-1', 'Idea (old)', 'note', '2026-09-01T00:00:00.000Z', ''), '2026-09-01T00:00:01Z'],
            'f-new' => ['Idea.md', $this->md('dup-1', 'Idea (new)', 'note', '2026-09-04T00:00:00.000Z', ''), '2026-09-04T00:00:01Z'],
            'f-trash' => ['Gone.md', $this->md('trash-1', 'Gone', 'note', '2026-09-05T00:00:00.000Z', "deleted: true\n"), '2026-09-05T00:00:01Z'],
            'f-plain' => ['Phone numbers.md', "Sam 021 555 1234\n", '2026-08-01T00:00:00Z'],
        ];

        Http::fake(function (Request $r) {
            $url = $r->url();
            if (str_starts_with($url, 'https://oauth2.googleapis.com/token')) {
                return Http::response(['access_token' => 'tok']);
            }
            if (preg_match('#/files/([^/?]+)\?alt=media#', $url, $m)) {
                if ($m[1] === 'd-att') {
                    return Http::response('PDF');
                }

                return isset($this->files[$m[1]]) ? Http::response($this->files[$m[1]][1]) : Http::response('not found', 404);
            }
            $q = $r->data()['q'] ?? '';
            if (str_contains($q, "name='XavaNotes'")) {
                return Http::response(['files' => [['id' => 'folder', 'name' => 'XavaNotes', 'mimeType' => 'application/vnd.google-apps.folder']]]);
            }
            if (str_contains($q, "'folder' in parents")) {
                $list = [['id' => 'att-folder', 'name' => 'attachments', 'mimeType' => 'application/vnd.google-apps.folder', 'modifiedTime' => '2026-01-01T00:00:00Z']];
                foreach ($this->files as $id => [$name, , $time]) {
                    $list[] = ['id' => $id, 'name' => $name, 'mimeType' => 'text/markdown', 'modifiedTime' => $time];
                }

                return Http::response(['files' => $list]);
            }

            return Http::response('unexpected '.$url, 500);
        });
    }

    private function md(string $id, string $title, string $type, string $updated, string $extra): string
    {
        return "---\nid: \"$id\"\ntype: \"$type\"\ncreated: \"2026-08-01T00:00:00.000Z\"\nupdated: \"$updated\"\ntitle: \"$title\"\n{$extra}---\n# $title\n\nBody of $title\n";
    }

    public function test_a_dry_run_reports_and_writes_nothing(): void
    {
        $this->artisan('notes:import-drive', ['--dry-run' => true])
            ->expectsOutputToContain('6 note files')
            ->expectsOutputToContain('Duplicate ids')
            ->expectsOutputToContain('Files with no id')
            ->expectsOutputToContain('Dry run: nothing written.')
            ->assertSuccessful();

        $this->assertSame(0, Note::count());
        $this->assertSame([], Storage::disk('local')->allFiles());
        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), 'd-att'));
    }

    public function test_notes_are_imported_with_their_ids_and_attachments_moved_to_the_server(): void
    {
        $this->artisan('notes:import-drive')
            ->expectsOutputToContain('Imported 5 notes.')
            ->expectsOutputToContain('Attachments that could not be downloaded (left off the note) (1)')
            ->assertFailed(); // one attachment is missing from Drive, so it says so

        $this->assertSame(['drive-f-plain', 'dup-1', 'note-1', 'task-1', 'trash-1'], Note::query()->orderBy('id')->pluck('id')->all());

        $task = Note::find('task-1');
        $this->assertSame(['task', 'Ring the bank', "Body of Ring the bank\n", 'Home', true, ['money'], 1],
            [$task->type, $task->title, $task->body, $task->notebook, $task->done, $task->tags, $task->version]);
        $this->assertSame([['text' => 'Find number', 'done' => true]], $task->subtasks);

        $this->assertSame('Idea (new)', Note::find('dup-1')->title, 'the newest copy of a duplicate wins');
        $this->assertTrue(Note::find('trash-1')->deleted);
        $this->assertSame('Phone numbers', Note::find('drive-f-plain')->title, 'no id: named after the Drive file, titled from the file name');

        $receipt = Note::find('note-1');
        $this->assertCount(1, $receipt->attachments);
        $att = Attachment::find($receipt->attachments[0]['id']);
        $this->assertSame(['receipt.pdf', 'application/pdf', 'note-1'], [$att->name, $att->mime, $att->note_id]);
        $this->assertSame('PDF', Storage::disk('local')->get($att->path));

        // Each import is its own change, so devices pull them all.
        $this->assertSame(5, Note::query()->distinct()->count('rev'));
    }

    public function test_running_it_again_skips_what_is_already_there(): void
    {
        $this->artisan('notes:import-drive');
        $before = Note::count();

        $this->artisan('notes:import-drive')
            ->expectsOutputToContain('Already in the database (skipped) (5)')
            ->expectsOutputToContain('Imported 0 notes.');

        $this->assertSame($before, Note::count());
        $this->assertSame(1, Note::find('note-1')->version, 'existing notes are not touched');
    }

    public function test_it_says_when_google_is_not_configured(): void
    {
        config(['notes.google.refresh_token' => null]);

        $this->expectExceptionMessage('Google is not configured');
        $this->artisan('notes:import-drive', ['--dry-run' => true]);
    }
}
