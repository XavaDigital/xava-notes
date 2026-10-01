<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SessionController extends Controller
{
    /**
     * GET /api/session: who is signed in. A 401 means the app should send the person to
     * /login. It also sets the XSRF-TOKEN cookie the app echoes back on writes, so the app
     * calls it at start-up before sending any queued saves.
     */
    public function show(Request $request): JsonResponse
    {
        return response()->json(['email' => $request->user()->email]);
    }
}
