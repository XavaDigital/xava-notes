<?php

namespace App\Notes;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Google Drive, as the OAuth client the app has always used. The drive.file scope means
 * it sees only the files that client created: the XavaNotes folder and its attachments.
 * Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
 */
class Drive
{
    private const API = 'https://www.googleapis.com/drive/v3';

    private const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

    private const FOLDER_MIME = 'application/vnd.google-apps.folder';

    private ?string $token = null;

    private function http(): PendingRequest
    {
        return Http::withToken($this->token ??= $this->accessToken())->timeout(60)->retry(3, 1000, throw: false);
    }

    private function accessToken(): string
    {
        $c = config('notes.google');
        if (blank($c['client_id']) || blank($c['client_secret']) || blank($c['refresh_token'])) {
            throw new RuntimeException('Google is not configured (need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).');
        }

        $response = Http::asForm()->timeout(30)->post('https://oauth2.googleapis.com/token', [
            'client_id' => $c['client_id'],
            'client_secret' => $c['client_secret'],
            'refresh_token' => $c['refresh_token'],
            'grant_type' => 'refresh_token',
        ]);
        if (! $response->successful() || ! $response->json('access_token')) {
            throw new RuntimeException('Google sign-in failed ('.$response->status().'): '.mb_substr($response->body(), 0, 200));
        }

        return $response->json('access_token');
    }

    /** The id of the folder with this name (and parent), or null. */
    public function findFolder(string $name, ?string $parentId = null): ?string
    {
        $q = sprintf("mimeType='%s' and name='%s' and trashed=false", self::FOLDER_MIME, addslashes($name));
        if ($parentId) {
            $q .= sprintf(" and '%s' in parents", $parentId);
        }

        return $this->list($q)[0]['id'] ?? null;
    }

    /**
     * Every file directly inside a folder, folders excluded.
     *
     * @return list<array{id: string, name: string, mimeType: string, modifiedTime: string, size?: string}>
     */
    public function filesIn(string $folderId): array
    {
        return array_values(array_filter(
            $this->list(sprintf("'%s' in parents and trashed=false", $folderId)),
            fn ($f) => $f['mimeType'] !== self::FOLDER_MIME,
        ));
    }

    public function createFolder(string $name, ?string $parentId = null): string
    {
        $response = $this->http()->post(self::API.'/files?fields=id', array_filter([
            'name' => $name,
            'mimeType' => self::FOLDER_MIME,
            'parents' => $parentId ? [$parentId] : null,
        ]));
        if (! $response->successful()) {
            throw new RuntimeException('Drive '.$response->status()." creating folder '$name'");
        }

        return $response->json('id');
    }

    /** Upload a new file into a folder; returns its id. */
    public function create(string $name, string $content, string $mime, string $parentId, array $appProperties = []): string
    {
        $response = $this->upload('post', self::UPLOAD.'/files?uploadType=multipart&fields=id', array_filter([
            'name' => $name,
            'parents' => [$parentId],
            'appProperties' => $appProperties ?: null,
        ]), $content, $mime);
        if (! $response->successful()) {
            throw new RuntimeException('Drive '.$response->status()." uploading '$name'");
        }

        return $response->json('id');
    }

    /** Replace a file's name and contents. Throws DriveFileMissing if it is gone (deleted by hand). */
    public function update(string $fileId, string $name, string $content, string $mime): void
    {
        $response = $this->upload('patch', self::UPLOAD.'/files/'.rawurlencode($fileId).'?uploadType=multipart&fields=id', ['name' => $name], $content, $mime);
        if ($response->status() === 404) {
            throw new DriveFileMissing($fileId);
        }
        if (! $response->successful()) {
            throw new RuntimeException('Drive '.$response->status()." updating '$name'");
        }
    }

    /** Move a file to Drive's trash (recoverable there for 30 days). Already gone is fine. */
    public function trash(string $fileId): void
    {
        $response = $this->http()->patch(self::API.'/files/'.rawurlencode($fileId).'?fields=id', ['trashed' => true]);
        if (! $response->successful() && $response->status() !== 404) {
            throw new RuntimeException('Drive '.$response->status().' trashing '.$fileId);
        }
    }

    /** A multipart/related upload: JSON metadata, then the bytes. */
    private function upload(string $method, string $url, array $metadata, string $content, string $mime)
    {
        $boundary = 'xn-'.bin2hex(random_bytes(8));
        $body = "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".json_encode($metadata)
            ."\r\n--$boundary\r\nContent-Type: $mime\r\n\r\n".$content."\r\n--$boundary--";

        return $this->http()->withBody($body, "multipart/related; boundary=$boundary")->{$method}($url);
    }

    /** A file's contents. */
    public function download(string $fileId): string
    {
        $response = $this->http()->get(self::API.'/files/'.rawurlencode($fileId), ['alt' => 'media']);
        if (! $response->successful()) {
            throw new RuntimeException('Drive '.$response->status().' downloading '.$fileId);
        }

        return $response->body();
    }

    private function list(string $q): array
    {
        $files = [];
        $page = null;
        do {
            $response = $this->http()->get(self::API.'/files', array_filter([
                'q' => $q,
                'pageSize' => 1000,
                'fields' => 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
                'pageToken' => $page,
            ]));
            if (! $response->successful()) {
                throw new RuntimeException('Drive '.$response->status().' listing files: '.mb_substr($response->body(), 0, 200));
            }
            array_push($files, ...$response->json('files', []));
            $page = $response->json('nextPageToken');
        } while ($page);

        return $files;
    }
}
