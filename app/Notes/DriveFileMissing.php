<?php

namespace App\Notes;

use RuntimeException;

/** A Drive file the app expected is gone, for example deleted by hand. */
class DriveFileMissing extends RuntimeException
{
    public function __construct(public readonly string $fileId)
    {
        parent::__construct("Drive file $fileId is gone");
    }
}
