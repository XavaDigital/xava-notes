<?php

namespace Tests\Feature;

use App\Models\Note;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class NotesApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->actingAs(User::factory()->create());
    }

    /** A note in the app's own shape (js/note.js emptyNote()). */
    private function note(array $overrides = []): array
    {
        return $overrides + [
            'id' => 'mfx1a2b3-abc123',
            'fileId' => null,
            'title' => 'Shopping',
            'type' => 'task',
            'body' => "- milk\n- **bread**",
            'notebook' => 'Home',
            'done' => false,
            'completedAt' => '',
            'due' => '2026-10-03',
            'tags' => ['errands'],
            'subtasks' => [['text' => 'milk', 'done' => true], ['text' => 'bread', 'done' => false]],
            'attachments' => [],
            'deleted' => false,
            'deletedAt' => '',
            'order' => 1727740800000.5,
            'created' => '2026-10-01T09:00:00.000Z',
            'updated' => '2026-10-01T09:00:00.000Z',
        ];
    }

    private function save(array $note, ?int $base = null)
    {
        return $this->putJson('/api/notes/'.$note['id'], ['base_version' => $base, 'note' => $note]);
    }

    public function test_a_new_note_is_created_under_the_apps_own_id(): void
    {
        $this->save($this->note())->assertOk()->assertExactJson(['version' => 1, 'rev' => 1]);

        $pulled = $this->getJson('/api/notes?after=0')->assertOk()->json();
        $this->assertSame(1, $pulled['rev']);
        $this->assertCount(1, $pulled['notes']);

        $expected = $this->note();
        unset($expected['fileId']);
        $this->assertEquals($expected + ['version' => 1, 'rev' => 1], $pulled['notes'][0]);
    }

    public function test_an_update_on_the_current_version_goes_up_by_one(): void
    {
        $this->save($this->note());

        $this->save($this->note(['title' => 'Groceries', 'updated' => '2026-10-01T10:00:00.000Z']), 1)
            ->assertOk()->assertExactJson(['version' => 2, 'rev' => 2]);

        $this->assertSame('Groceries', Note::find('mfx1a2b3-abc123')->title);
    }

    public function test_a_repeated_save_is_not_duplicated_and_writes_nothing(): void
    {
        $this->save($this->note())->assertOk();
        // The response was lost, so the app sends the same save again with the same base.
        $this->save($this->note())->assertOk()->assertExactJson(['version' => 1, 'rev' => 1]);

        $this->assertSame(1, Note::count());
        $this->assertSame(1, $this->getJson('/api/notes?after=0')->json('rev'));
    }

    public function test_a_save_on_a_stale_version_is_a_conflict_carrying_the_stored_note(): void
    {
        $this->save($this->note());
        $this->save($this->note(['title' => 'From the laptop', 'updated' => '2026-10-01T10:00:00.000Z']), 1);

        // The phone still thinks it is on version 1.
        $this->save($this->note(['title' => 'From the phone', 'updated' => '2026-10-01T10:05:00.000Z']), 1)
            ->assertStatus(409)
            ->assertJsonPath('error', 'conflict')
            ->assertJsonPath('note.title', 'From the laptop')
            ->assertJsonPath('note.version', 2);

        $this->assertSame('From the laptop', Note::find('mfx1a2b3-abc123')->title);

        // "Overwrite" in the conflict prompt resends with the stored version as its base.
        $this->save($this->note(['title' => 'From the phone', 'updated' => '2026-10-01T10:05:00.000Z']), 2)
            ->assertOk()->assertJsonPath('version', 3);
    }

    public function test_the_id_in_the_body_must_match_the_url(): void
    {
        $this->putJson('/api/notes/other-id', ['note' => $this->note()])->assertStatus(422);
        $this->assertSame(0, Note::count());
    }

    public function test_a_pull_returns_only_what_changed_after_the_given_rev(): void
    {
        $this->save($this->note(['id' => 'a']));
        $this->save($this->note(['id' => 'b']));
        $this->save($this->note(['id' => 'a', 'title' => 'A again', 'updated' => '2026-10-01T11:00:00.000Z']), 1);

        $pulled = $this->getJson('/api/notes?after=2')->assertOk()->json();

        $this->assertSame(3, $pulled['rev']);
        $this->assertSame(['a'], array_column($pulled['notes'], 'id'));
        $this->assertSame([], $this->getJson('/api/notes?after=3')->json('notes'));
    }

    public function test_a_pull_includes_notes_in_trash(): void
    {
        $this->save($this->note(['deleted' => true, 'deletedAt' => '2026-10-01T12:00:00.000Z']));

        $this->getJson('/api/notes?after=0')
            ->assertJsonPath('notes.0.deleted', true)
            ->assertJsonPath('notes.0.deletedAt', '2026-10-01T12:00:00.000Z');
    }

    public function test_emptying_from_trash_leaves_a_marker_for_other_devices_but_not_for_a_first_load(): void
    {
        $this->save($this->note(['id' => 'keep']));
        $this->save($this->note(['id' => 'gone', 'deleted' => true]));

        $this->deleteJson('/api/notes/gone')->assertOk();

        $pulled = $this->getJson('/api/notes?after=2')->json();
        $this->assertSame(3, $pulled['rev']);
        $this->assertSame([['id' => 'gone', 'purged' => true, 'version' => 2, 'rev' => 3]], $pulled['notes']);

        $this->assertSame(['keep'], array_column($this->getJson('/api/notes?after=0')->json('notes'), 'id'));

        $gone = Note::find('gone');
        $this->assertSame('', $gone->body);
        $this->assertSame('', $gone->title);
    }

    public function test_emptying_from_trash_twice_or_for_an_unknown_id_is_harmless(): void
    {
        $this->save($this->note(['id' => 'gone']));
        $this->deleteJson('/api/notes/gone')->assertOk();
        $this->deleteJson('/api/notes/gone')->assertOk();
        $this->deleteJson('/api/notes/never-existed')->assertOk();

        $this->assertSame(2, $this->getJson('/api/notes?after=0')->json('rev'));
    }

    public function test_an_offline_edit_to_a_note_emptied_elsewhere_is_a_conflict_and_overwrite_brings_it_back(): void
    {
        $this->save($this->note(['id' => 'n']));
        $this->deleteJson('/api/notes/n');

        $this->save($this->note(['id' => 'n', 'body' => 'edited offline', 'updated' => '2026-10-02T08:00:00.000Z']), 1)
            ->assertStatus(409)
            ->assertJsonPath('note.purged', true);

        $this->save($this->note(['id' => 'n', 'body' => 'edited offline', 'updated' => '2026-10-02T08:00:00.000Z']), 2)
            ->assertOk()->assertJsonPath('version', 3);

        $this->getJson('/api/notes?after=0')->assertJsonPath('notes.0.body', 'edited offline');
    }

    public function test_the_api_needs_a_session(): void
    {
        auth()->logout();

        $this->getJson('/api/session')->assertUnauthorized();
        $this->getJson('/api/notes')->assertUnauthorized();
        $this->putJson('/api/notes/x', ['note' => $this->note(['id' => 'x'])])->assertUnauthorized();
        $this->deleteJson('/api/notes/x')->assertUnauthorized();
        $this->postJson('/api/notify', [])->assertUnauthorized();

        $this->assertSame(0, Note::count());
    }

    public function test_the_session_endpoint_says_who_is_signed_in(): void
    {
        $this->getJson('/api/session')->assertOk()->assertJsonStructure(['email']);
    }
}
