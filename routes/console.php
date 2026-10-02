<?php

use Illuminate\Support\Facades\Schedule;

// The scheduler is driven by one cron entry on Cloudways:
//   * * * * * php8.3 artisan schedule:run

// The nightly backup to Google Drive (PLAN.md, Phase 4). It emails if it fails.
Schedule::command('notes:backup-drive')
    ->dailyAt('02:30')
    ->timezone('Pacific/Auckland')
    ->withoutOverlapping();
