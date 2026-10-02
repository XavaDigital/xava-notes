<?php

namespace Tests\Support;

use App\Notes\Drive;
use App\Notes\DriveFileMissing;
use RuntimeException;

/** An in-memory Google Drive for the backup and restore tests. */
class FakeDrive extends Drive
{
    /** @var array<string, array{name: string, content: string, mime: string, parent: ?string, folder: bool, trashed: bool, appProperties: array, modifiedTime: string}> */
    public array $files = [];

    /** File names whose upload fails, to test error reporting. */
    public array $failUploadsNamed = [];

    private int $next = 0;

    public function findFolder(string $name, ?string $parentId = null): ?string
    {
        foreach ($this->files as $id => $f) {
            if ($f['folder'] && ! $f['trashed'] && $f['name'] === $name && ($parentId === null || $f['parent'] === $parentId)) {
                return $id;
            }
        }

        return null;
    }

    public function createFolder(string $name, ?string $parentId = null): string
    {
        return $this->put($name, '', 'application/vnd.google-apps.folder', $parentId, [], true);
    }

    public function filesIn(string $folderId): array
    {
        $out = [];
        foreach ($this->files as $id => $f) {
            if (! $f['folder'] && ! $f['trashed'] && $f['parent'] === $folderId) {
                $out[] = ['id' => $id, 'name' => $f['name'], 'mimeType' => $f['mime'], 'modifiedTime' => $f['modifiedTime']];
            }
        }

        return $out;
    }

    public function download(string $fileId): string
    {
        if (! isset($this->files[$fileId]) || $this->files[$fileId]['trashed']) {
            throw new RuntimeException("Drive 404 downloading $fileId");
        }

        return $this->files[$fileId]['content'];
    }

    public function create(string $name, string $content, string $mime, string $parentId, array $appProperties = []): string
    {
        if (in_array($name, $this->failUploadsNamed, true)) {
            throw new RuntimeException("Drive 500 uploading '$name'");
        }

        return $this->put($name, $content, $mime, $parentId, $appProperties);
    }

    public function update(string $fileId, string $name, string $content, string $mime): void
    {
        if (! isset($this->files[$fileId]) || $this->files[$fileId]['trashed']) {
            throw new DriveFileMissing($fileId);
        }
        $this->files[$fileId] = ['name' => $name, 'content' => $content, 'mime' => $mime, 'modifiedTime' => $this->now()] + $this->files[$fileId];
    }

    public function trash(string $fileId): void
    {
        if (isset($this->files[$fileId])) {
            $this->files[$fileId]['trashed'] = true;
        }
    }

    /** Live (untrashed) files in a folder, by name. */
    public function namesIn(string $folderId): array
    {
        $names = array_column($this->filesIn($folderId), 'name');
        sort($names);

        return $names;
    }

    private function put(string $name, string $content, string $mime, ?string $parent, array $appProperties, bool $folder = false): string
    {
        $id = 'g'.(++$this->next);
        $this->files[$id] = compact('name', 'content', 'mime', 'parent', 'folder', 'appProperties') + ['trashed' => false, 'modifiedTime' => $this->now()];

        return $id;
    }

    private function now(): string
    {
        return gmdate('Y-m-d\TH:i:s', 1_780_000_000 + $this->next).'Z';
    }
}
