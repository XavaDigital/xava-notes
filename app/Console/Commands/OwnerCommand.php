<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

class OwnerCommand extends Command
{
    protected $signature = 'notes:owner {email} {password}';

    protected $description = 'Create or update the sign-in for the owner of the notes';

    public function handle(): int
    {
        $user = User::updateOrCreate(
            ['email' => (string) $this->argument('email')],
            ['name' => 'Owner', 'password' => (string) $this->argument('password')],
        );

        $this->info("Sign-in ready for {$user->email}.");

        return self::SUCCESS;
    }
}
