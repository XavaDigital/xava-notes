<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Cloudways sits behind a proxy; trust it so url() builds https links.
        $middleware->trustProxies(at: '*');

        // The API is called from the app's own page with the session cookie. Writes carry the
        // XSRF-TOKEN cookie back as an X-XSRF-TOKEN header, so CSRF protection stays on for them.
        // Only the share sheet's post is exempt: it comes from Android, not from a page.
        $middleware->validateCsrfTokens(except: ['share-target']);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // API calls get JSON errors (401 when signed out) instead of a redirect to /login.
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
