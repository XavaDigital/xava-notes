<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Tests\TestCase;

class SignInTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_app_is_served_without_a_session(): void
    {
        $response = $this->get('/')->assertOk()->assertHeader('Content-Type', 'text/html; charset=utf-8');

        $this->assertSame(public_path('index.html'), $response->baseResponse->getFile()->getPathname());
    }

    public function test_the_owner_command_creates_a_sign_in_that_remembers_the_device(): void
    {
        $this->artisan('notes:owner', ['email' => 'owner@example.test', 'password' => 'long-secret'])->assertSuccessful();

        $this->get('/login')->assertOk()->assertSee('Sign in');

        $response = $this->post('/login', ['email' => 'owner@example.test', 'password' => 'long-secret'])
            ->assertRedirect('/');

        $this->assertAuthenticated();
        $this->assertNotNull(User::first()->remember_token);
        $this->assertNotEmpty(array_filter(
            $response->headers->getCookies(),
            fn ($c) => str_starts_with($c->getName(), Auth::guard()->getRecallerName()),
        ));
    }

    public function test_a_wrong_password_is_refused(): void
    {
        $this->artisan('notes:owner', ['email' => 'owner@example.test', 'password' => 'long-secret']);

        $this->post('/login', ['email' => 'owner@example.test', 'password' => 'nope'])->assertSessionHasErrors('email');
        $this->assertGuest();
    }

    public function test_signing_out_ends_the_session(): void
    {
        $this->actingAs(User::factory()->create());

        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_a_share_that_reaches_the_server_opens_the_app(): void
    {
        $this->post('/share-target', ['title' => 'x'])->assertRedirect('/');
    }
}
