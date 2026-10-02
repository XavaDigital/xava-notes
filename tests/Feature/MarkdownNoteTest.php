<?php

namespace Tests\Feature;

use App\Notes\MarkdownNote;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The PHP reader must read every note file exactly as the app's JavaScript does. */
class MarkdownNoteTest extends TestCase
{
    public static function cases(): array
    {
        $cases = json_decode(file_get_contents(__DIR__.'/../Fixtures/markdown/cases.json'), true);

        return array_combine(array_column($cases, 'name'), array_map(fn ($c) => [$c], $cases));
    }

    #[DataProvider('cases')]
    public function test_it_reads_a_note_file_as_the_app_does(array $case): void
    {
        $parsed = MarkdownNote::parse($case['markdown'], $case['fileName']);
        $expected = $case['expected'];

        foreach ($case['volatile'] as $field) {
            $this->assertNotSame('', $parsed[$field], "$field should still be filled in");
            unset($parsed[$field], $expected[$field]);
        }
        unset($expected['fileId']);
        // Known difference: the JavaScript keeps a bare number as the title (`title: 2024`);
        // the server stores titles as text.
        $expected['title'] = (string) $expected['title'];

        // JSON has no int/float distinction; compare as the app would see it.
        $this->assertSame(
            json_decode(json_encode($expected), true),
            json_decode(json_encode($parsed), true),
        );
    }

    public static function writtenCases(): array
    {
        return array_filter(self::cases(), fn ($c) => isset($c[0]['input']));
    }

    #[DataProvider('writtenCases')]
    public function test_it_writes_a_note_file_byte_for_byte_as_the_app_did(array $case): void
    {
        $this->assertSame($case['markdown'], MarkdownNote::toMarkdown($case['input']));
        $this->assertSame($case['filename'], MarkdownNote::filename($case['input']));
    }

    public function test_windows_line_endings_are_read_properly_unlike_the_javascript(): void
    {
        $n = MarkdownNote::parse("---\r\nid: \"crlf-1\"\r\ntype: \"task\"\r\ntitle: \"Windows file\"\r\ndone: true\r\ncreated: \"2026-01-01T00:00:00.000Z\"\r\n---\r\nbody text\r\n", 'x.md');

        $this->assertSame(
            ['crlf-1', 'Windows file', 'task', true, '2026-01-01T00:00:00.000Z'],
            [$n['id'], $n['title'], $n['type'], $n['done'], $n['created']],
        );
    }

    public function test_a_file_with_no_id_gets_one_in_the_apps_format(): void
    {
        $this->assertMatchesRegularExpression('/^[0-9a-z]{8,9}-[0-9a-z]{6}$/', MarkdownNote::parse("# x\n")['id']);
    }
}
