<?php

namespace App\Notes;

/**
 * Reads a note's Markdown file as the app does: a PHP port of parseFrontmatter() in
 * public/js/frontmatter.js and noteFromMarkdown() in public/js/note.js. It copies their
 * quirks on purpose (numbers in tags become numbers and back, quoted values only unescape
 * \"), so an imported note is exactly what the app showed. tests/Feature/MarkdownNoteTest
 * checks it against output from the JavaScript itself.
 */
class MarkdownNote
{
    /**
     * The note as the app holds it (js/note.js emptyNote() shape, without fileId).
     * $fallbackTime replaces the JavaScript's "now" for files with no created/updated.
     *
     * @return array<string, mixed>
     */
    public static function parse(string $text, string $fileName = '', string $fallbackTime = ''): array
    {
        ['meta' => $meta, 'body' => $body] = self::frontmatter($text);

        // Strip a leading "# Title" heading from the body (the app re-adds it on save).
        $cleanBody = $body;
        $titleFromBody = '';
        if (preg_match('/^\s*#\s+(.+)\n+/u', $body, $h1)) {
            $titleFromBody = self::trim($h1[1]);
            $cleanBody = substr($body, strlen($h1[0]));
        }

        $now = $fallbackTime !== '' ? $fallbackTime : gmdate('Y-m-d\TH:i:s.v\Z');
        $or = fn (...$values) => self::firstTruthy($values);

        return [
            'id' => self::str($or($meta['id'] ?? null, null)) ?: self::newId(),
            'title' => self::str($or($meta['title'] ?? null, $titleFromBody, self::titleFromFilename($fileName), '')),
            'type' => ($meta['type'] ?? null) === 'task' ? 'task' : 'note',
            'body' => preg_replace('/^\n+/', '', $cleanBody),
            'notebook' => self::truthy($meta['notebook'] ?? null) ? self::str($meta['notebook']) : '',
            'done' => self::truthy($meta['done'] ?? null),
            'completedAt' => self::str($or($meta['completedAt'] ?? null, '')),
            'due' => self::str($or($meta['due'] ?? null, '')),
            'tags' => is_array($meta['tags'] ?? null) && array_is_list($meta['tags'])
                ? array_map(self::str(...), $meta['tags']) : [],
            'subtasks' => self::isObjectList($meta['subtasks'] ?? null)
                ? array_map(fn ($s) => [
                    'text' => self::str($or(self::field($s, 'text'), '')),
                    'done' => self::truthy(self::field($s, 'done')),
                ], $meta['subtasks']) : [],
            'attachments' => self::isObjectList($meta['attachments'] ?? null)
                ? array_values(array_filter(array_map(fn ($a) => [
                    'id' => self::str($or(self::field($a, 'id'), '')),
                    'name' => self::str($or(self::field($a, 'name'), '')),
                    'mime' => self::str($or(self::field($a, 'mime'), '')),
                    'size' => self::number(self::field($a, 'size')),
                ], $meta['attachments']), fn ($a) => $a['id'] !== '')) : [],
            'deleted' => self::truthy($meta['deleted'] ?? null),
            'deletedAt' => self::str($or($meta['deletedAt'] ?? null, '')),
            'order' => self::number($meta['order'] ?? null),
            'created' => self::str($or($meta['created'] ?? null, $now)),
            'updated' => self::str($or($meta['updated'] ?? null, $meta['created'] ?? null, $now)),
        ];
    }

    /**
     * parseFrontmatter(): the small YAML subset the app writes, leniently.
     *
     * @return array{meta: array<string, mixed>, body: string}
     */
    public static function frontmatter(string $text): array
    {
        $meta = [];
        if (! preg_match('/^---\s*\n([\s\S]*?)\n---\s*\n?/', $text, $match)) {
            return ['meta' => $meta, 'body' => $text];
        }

        $body = substr($text, strlen($match[0]));
        $listKey = null;
        $list = [];
        $current = null;

        $flush = function () use (&$listKey, &$list, &$current, &$meta) {
            if ($listKey === null) {
                return;
            }
            if ($current !== null) {
                $list[] = $current;
                $current = null;
            }
            if ($list) {
                $meta[$listKey] = $list;
            }
            $listKey = null;
            $list = [];
        };

        foreach (explode("\n", $match[1]) as $line) {
            if (self::trim($line) === '') {
                continue;
            }

            // Inside a block list (indented lines).
            if ($listKey !== null && preg_match('/^\s+/u', $line)) {
                if (preg_match('/^\s*-\s*(.*)$/u', $line, $item)) {
                    if ($current !== null) {
                        $list[] = $current;
                    }
                    $current = [];
                    if (preg_match('/^(\w+):\s*(.*)$/u', $item[1], $kv)) {
                        $current[$kv[1]] = self::scalar($kv[2]);
                    }

                    continue;
                }
                if (preg_match('/^\s*(\w+):\s*(.*)$/u', $line, $kv) && $current !== null) {
                    $current[$kv[1]] = self::scalar($kv[2]);
                }

                continue;
            } elseif ($listKey !== null) {
                $flush(); // de-indented: the block list ended
            }

            if (! preg_match('/^(\w[\w-]*):\s*(.*)$/u', $line, $kv)) {
                continue;
            }
            [, $key, $val] = $kv;

            if (self::trim($val) === '') {
                // A key with no inline value begins a block list of objects.
                $listKey = $key;
                $list = [];
                $current = null;

                continue;
            }
            $meta[$key] = str_starts_with(self::trim($val), '[') ? self::inlineArray($val) : self::scalar($val);
        }
        $flush();

        return ['meta' => $meta, 'body' => $body];
    }

    /** newId() in js/note.js: base-36 milliseconds, a dash, six base-36 characters. */
    public static function newId(): string
    {
        $chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        $rand = '';
        for ($i = 0; $i < 6; $i++) {
            $rand .= $chars[random_int(0, 35)];
        }

        return base_convert((string) (int) floor(microtime(true) * 1000), 10, 36).'-'.$rand;
    }

    private static function scalar(string $raw): mixed
    {
        $v = self::trim($raw);
        if ($v === '') {
            return '';
        }
        if ($v === 'true') {
            return true;
        }
        if ($v === 'false') {
            return false;
        }
        if (strlen($v) >= 2 && (($v[0] === '"' && str_ends_with($v, '"')) || ($v[0] === "'" && str_ends_with($v, "'")))) {
            return str_replace('\\"', '"', substr($v, 1, -1));
        }
        if (preg_match('/^-?\d+(\.\d+)?$/', $v)) {
            return $v + 0;
        }

        return $v;
    }

    private static function inlineArray(string $raw): array
    {
        $inner = self::trim(preg_replace(['/^\[/', '/\]$/'], '', self::trim($raw)));
        if ($inner === '') {
            return [];
        }

        return array_values(array_filter(
            array_map(self::scalar(...), explode(',', $inner)),
            fn ($s) => $s !== '',
        ));
    }

    /** JavaScript's String.prototype.trim(): Unicode whitespace, not just ASCII. */
    private static function trim(string $s): string
    {
        return preg_replace('/^[\s\x{FEFF}\x{A0}]+|[\s\x{FEFF}\x{A0}]+$/u', '', $s) ?? trim($s);
    }

    /** JavaScript truthiness for the values the parser can produce. */
    private static function truthy(mixed $v): bool
    {
        return ! ($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0);
    }

    private static function firstTruthy(array $values): mixed
    {
        foreach ($values as $v) {
            if (self::truthy($v)) {
                return $v;
            }
        }

        return end($values);
    }

    /** JavaScript String(v). */
    private static function str(mixed $v): string
    {
        return match (true) {
            $v === null => '',
            is_bool($v) => $v ? 'true' : 'false',
            is_float($v) && floor($v) === $v && abs($v) < 1e21 => (string) (int) $v,
            is_array($v) => implode(',', array_map(self::str(...), $v)),
            default => (string) $v,
        };
    }

    /** JavaScript Number(v) || 0. */
    private static function number(mixed $v): int|float
    {
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if (is_bool($v)) {
            return (int) $v;
        }
        $s = self::trim((string) $v);

        return is_numeric($s) ? $s + 0 : 0;
    }

    /** obj.key in JavaScript: undefined (null here) when the item is not an object. */
    private static function field(mixed $item, string $key): mixed
    {
        return is_array($item) ? ($item[$key] ?? null) : null;
    }

    private static function isObjectList(mixed $v): bool
    {
        return is_array($v) && array_is_list($v);
    }

    private static function titleFromFilename(string $name): string
    {
        return self::trim(preg_replace('/\.md$/i', '', $name));
    }
}
