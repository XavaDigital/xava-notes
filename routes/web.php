<?php

use App\Http\Controllers\AttachmentsController;
use App\Http\Controllers\NotesController;
use App\Http\Controllers\NotifyController;
use App\Http\Controllers\SessionController;
use App\Http\Controllers\SignInController;
use Illuminate\Support\Facades\Route;

// The app itself. Served to anyone: it holds no data, and the service worker must be able to
// cache it while signed out. The notes come from the API below, which needs a session.
Route::get('/', fn () => response()->file(public_path('index.html'), [
    'Content-Type' => 'text/html; charset=utf-8',
    'Cache-Control' => 'no-cache',
]))->name('app');

// The Android share sheet posts here. The service worker normally answers it; if the post ever
// reaches the server (the service worker not yet in control), open the app rather than fail.
Route::post('/share-target', fn () => redirect('/'));

// A plain sign-in form (password managers can save it) that remembers the device. The owner's sign-in comes from notes:owner.
Route::middleware('guest')->group(function () {
    Route::get('/login', [SignInController::class, 'show'])->name('login');
    Route::post('/login', [SignInController::class, 'store'])->middleware('throttle:6,1')->name('login.store');
});
Route::post('/logout', [SignInController::class, 'destroy'])->middleware('auth')->name('logout');

Route::middleware('auth')->prefix('/api')->group(function () {
    Route::get('/session', [SessionController::class, 'show']);

    Route::get('/notes', [NotesController::class, 'index']);
    Route::put('/notes/{id}', [NotesController::class, 'put'])->where('id', '[A-Za-z0-9._-]{1,100}');
    Route::delete('/notes/{id}', [NotesController::class, 'destroy'])->where('id', '[A-Za-z0-9._-]{1,100}');

    Route::post('/attachments', [AttachmentsController::class, 'store']);
    Route::get('/attachments/{attachment}', [AttachmentsController::class, 'show']);
    Route::delete('/attachments/{id}', [AttachmentsController::class, 'destroy']);

    Route::post('/notify', [NotifyController::class, 'store']);
});
