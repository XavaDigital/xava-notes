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
