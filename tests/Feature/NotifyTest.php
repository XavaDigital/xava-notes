<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class NotifyTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->actingAs(User::factory()->create());
    }

    public function test_a_task_is_emailed_through_mailgun(): void
    {
        Http::fake(['api.mailgun.net/*' => Http::response(['id' => '<x@mg>'])]);

        $this->postJson('/api/notify', [
            'title' => 'Call <Sam>', 'type' => 'task', 'body' => 'about the quote', 'due' => '2026-10-03', 'notebook' => 'Work',
        ])->assertOk()->assertExactJson(['ok' => true]);

        Http::assertSent(function (Request $r) {
            return $r->url() === 'https://api.mailgun.net/v3/mg.example.test/messages'
                && $r->hasHeader('Authorization', 'Basic '.base64_encode('api:test-key'))
                && $r['to'] === 'owner@example.test'
                && $r['from'] === 'Xava Notes <notes@mg.example.test>'
                && $r['subject'] === '[Xava Task] Call <Sam>'
                && $r['text'] === "Call <Sam>\n\nNotebook: Work\nDue: 2026-10-03\n\nabout the quote"
                && str_contains($r['html'], 'Call &lt;Sam&gt;');
        });
    }

    public function test_a_mailgun_failure_is_reported_to_the_app(): void
    {
        Http::fake(['api.mailgun.net/*' => Http::response('Forbidden', 401)]);

        $this->postJson('/api/notify', ['title' => 'x', 'type' => 'note'])
            ->assertStatus(502)
            ->assertJsonPath('error', 'Mailgun 401: Forbidden');
    }

    public function test_missing_mailgun_settings_are_named(): void
    {
        config(['notes.mailgun.secret' => null]);
        Http::fake();

        $this->postJson('/api/notify', ['title' => 'x'])->assertStatus(502);
        Http::assertNothingSent();
    }
}
