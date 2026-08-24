<?php

declare(strict_types=1);

use PersonalTimeLogger\MysqlApi\ApiException;
use PersonalTimeLogger\MysqlApi\Validator;

require_once dirname(__DIR__) . '/src/ApiException.php';
require_once dirname(__DIR__) . '/src/Validator.php';

function assertSameValue(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) throw new RuntimeException($message);
}

function assertThrows(callable $callback, string $code): void
{
    try {
        $callback();
    } catch (ApiException $error) {
        assertSameValue($code, $error->errorCode, "Expected {$code}, got {$error->errorCode}");
        return;
    }
    throw new RuntimeException("Expected {$code} exception.");
}

$entry = Validator::entry([
    'id' => 'entry-1',
    'project' => "O'Reilly",
    'task' => 'SQL injection is data',
    'description' => 'description',
    'start_at' => '2026-08-24T10:00:00+01:00',
    'end_at' => '',
    'duration_seconds' => 42,
    'status' => 'ok',
    'created_at' => '2026-08-24T10:00:00Z',
    'updated_at' => '2026-08-24T10:00:00Z',
    'deleted_at' => '',
    'device_id' => 'device-1',
    'revision' => 1,
    'multiply' => 1.5,
]);
assertSameValue('2026-08-24T09:00:00.000Z', $entry['start_at'], 'Timestamp should normalize to UTC.');
assertSameValue('1.500', $entry['multiply'], 'Multiplier should normalize to three decimals.');
assertSameValue(null, $entry['end_at'], 'Empty timestamps should become database NULL values.');

assertThrows(static fn () => Validator::entry(array_diff_key($entry, ['id' => true])), 'ENTRY_INVALID');
assertThrows(static fn () => Validator::entry([...$entry, 'status' => 'running']), 'ENTRY_INVALID');
assertThrows(static fn () => Validator::entry([...$entry, 'multiply' => '99']), 'ENTRY_INVALID');
assertThrows(static fn () => Validator::entry([...$entry, 'id' => ['injection']]), 'ENTRY_INVALID');

echo "validator tests passed\n";
