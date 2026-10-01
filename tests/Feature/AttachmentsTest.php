<?php

namespace Tests\Feature;

use App\Models\Attachment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class AttachmentsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $this->actingAs(User::factory()->create());
    }

    private function upload(string $name = 'receipt.pdf', string $mime = 'application/pdf'): array
    {
        return $this->post('/api/attachments', ['file' => UploadedFile::fake()->create($name, 12, $mime)])
            ->assertCreated()
            ->json();
    }

    private function saveNoteWith(array $attachments, string $id = 'n1'): void
    {
        $this->putJson("/api/notes/$id", ['note' => [
            'id' => $id, 'type' => 'note', 'title' => 'With a file', 'body' => '',
            'attachments' => $attachments,
            'created' => '2026-10-01T09:00:00.000Z', 'updated' => '2026-10-01T09:00:00.000Z',
        ]])->assertOk();
    }

    public function test_an_upload_returns_the_entry_the_note_keeps_and_can_be_downloaded(): void
    {
        $a = $this->upload();

        $this->assertSame('receipt.pdf', $a['name']);
        $this->assertSame('application/pdf', $a['mime']);
        $this->assertSame(12 * 1024, $a['size']);
        Storage::disk('local')->assertExists('attachments/'.$a['id']);

        $this->get('/api/attachments/'.$a['id'])
            ->assertOk()
            ->assertHeader('Content-Type', 'application/pdf')
            ->assertHeader('Content-Security-Policy', 'sandbox');
    }

    public function test_attachments_are_only_reachable_when_signed_in(): void
    {
        $a = $this->upload();
        auth()->logout();

        $this->getJson('/api/attachments/'.$a['id'])->assertUnauthorized();
        $this->postJson('/api/attachments', ['file' => UploadedFile::fake()->create('x.pdf', 1)])->assertUnauthorized();
        $this->deleteJson('/api/attachments/'.$a['id'])->assertUnauthorized();

        Storage::disk('local')->assertExists('attachments/'.$a['id']);
    }

    public function test_an_uploaded_page_downloads_instead_of_opening(): void
    {
        $a = $this->upload('page.html', 'text/html');

        $this->assertStringStartsWith('attachment;', $this->get('/api/attachments/'.$a['id'])->headers->get('Content-Disposition'));
    }

    public function test_saving_a_note_claims_its_attachments_and_emptying_it_from_trash_removes_them(): void
    {
        $a = $this->upload();
        $this->saveNoteWith([$a]);
        $this->assertSame('n1', Attachment::find($a['id'])->note_id);

        $this->deleteJson('/api/notes/n1')->assertOk();

        $this->assertNull(Attachment::find($a['id']));
        Storage::disk('local')->assertMissing('attachments/'.$a['id']);
    }

    public function test_removing_an_attachment_deletes_the_file_and_repeating_it_is_harmless(): void
    {
        $a = $this->upload();

        $this->deleteJson('/api/attachments/'.$a['id'])->assertOk();
        $this->deleteJson('/api/attachments/'.$a['id'])->assertOk();

        Storage::disk('local')->assertMissing('attachments/'.$a['id']);
        $this->getJson('/api/attachments/'.$a['id'])->assertNotFound();
    }
}
