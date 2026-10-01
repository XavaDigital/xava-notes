<?php

namespace App\Notes;

use Illuminate\Support\Facades\DB;

/**
 * The global change counter. Every write takes the next rev while holding a lock on the
 * counter row until its transaction commits, so revs become visible in order and a device
 * pulling "after rev N" never misses one. Call these inside a DB transaction.
 */
class Revisions
{
    /** Lock the counter for the rest of the transaction and return its current value. */
    public static function lock(): int
    {
        return (int) DB::table('sync_state')->where('id', 1)->lockForUpdate()->value('rev');
    }

    /** Hand out the next rev. The counter must already be locked. */
    public static function next(): int
    {
        DB::table('sync_state')->where('id', 1)->increment('rev');

        return (int) DB::table('sync_state')->where('id', 1)->value('rev');
    }

    /** The last rev handed out, without locking. */
    public static function current(): int
    {
        return (int) DB::table('sync_state')->where('id', 1)->value('rev');
    }
}
