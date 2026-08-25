<?php

declare(strict_types=1);

use PersonalTimeLogger\MysqlApi\Api;
use PersonalTimeLogger\MysqlApi\ApiException;
use PersonalTimeLogger\MysqlApi\Config;
use PersonalTimeLogger\MysqlApi\Database;

require_once dirname(__DIR__) . '/src/ApiException.php';
require_once dirname(__DIR__) . '/src/Config.php';
require_once dirname(__DIR__) . '/src/Database.php';
require_once dirname(__DIR__) . '/src/Http.php';
require_once dirname(__DIR__) . '/src/Validator.php';
require_once dirname(__DIR__) . '/src/Api.php';

if (!extension_loaded('pdo_mysql')) {
    fwrite(STDOUT, "Session 1 MySQL integration checks skipped: pdo_mysql is unavailable.\n");
    exit(0);
}

if (getenv('PTL_TEST_MYSQL_DSN') === false || getenv('PTL_TEST_MYSQL_ALLOW_RESET') !== '1') {
    fwrite(STDOUT, "Session 1 MySQL integration checks skipped: set PTL_TEST_MYSQL_DSN and PTL_TEST_MYSQL_ALLOW_RESET=1 for a disposable database.\n");
    exit(0);
}

function assertSameValue(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        throw new RuntimeException($message . " Expected " . var_export($expected, true) . ', got ' . var_export($actual, true) . '.');
    }
}

function assertThrows(callable $callback, int $status, string $code): void
{
    try {
        $callback();
    } catch (ApiException $error) {
        assertSameValue($status, $error->status, "Expected {$code} status.");
        assertSameValue($code, $error->errorCode, "Expected {$code} error.");
        return;
    }
    throw new RuntimeException("Expected {$code} exception.");
}

function invoke(Api $api, string $method, array $body = []): mixed
{
    $reflection = new ReflectionMethod($api, $method);
    $reflection->setAccessible(true);
    return $reflection->invoke($api, $body);
}

function entry(string $id, string $project = 'project'): array
{
    return [
        'id' => $id,
        'project' => $project,
        'task' => 'task',
        'description' => 'description',
        'start_at' => '2026-08-25T10:00:00Z',
        'end_at' => '',
        'duration_seconds' => 60,
        'status' => 'ok',
        'created_at' => '2026-08-25T10:00:00Z',
        'updated_at' => '2026-08-25T10:00:00Z',
        'deleted_at' => '',
        'device_id' => 'test-device',
        'revision' => 1,
        'multiply' => '',
    ];
}

$settings = [
    'dsn' => (string) getenv('PTL_TEST_MYSQL_DSN'),
    'username' => (string) (getenv('PTL_TEST_MYSQL_USER') ?: ''),
    'password' => (string) (getenv('PTL_TEST_MYSQL_PASSWORD') ?: ''),
];
$config = new Config([
    'database' => $settings,
    'api_token_sha256' => str_repeat('0', 64),
    'cors_origins' => [],
]);
$database = new Database($config);
$pdo = $database->pdo();

$pdo->exec('DELETE FROM time_entries');
$pdo->exec('DELETE FROM config');
$pdo->exec("UPDATE app_meta SET schema_version = 1, change_seq = 1, updated_at = '2026-08-25T00:00:00.000Z' WHERE id = 1");

$api = new Api($database);
$baseToken = (string) invoke($api, 'changeToken');
assertSameValue('1', $baseToken, 'The disposable database should start at change token 1.');

$firstEntries = [entry('entry-c'), entry('entry-a'), entry('entry-b')];
$append = invoke($api, 'append', ['entries' => $firstEntries]);
assertSameValue(['entry-c', 'entry-a', 'entry-b'], array_column($append['entries'], 'id'), 'Append response order changed.');
assertSameValue('2', (string) invoke($api, 'changeToken'), 'A multi-row append should bump once.');

invoke($api, 'append', ['entries' => $firstEntries]);
assertSameValue('2', (string) invoke($api, 'changeToken'), 'An idempotent append should not bump the token.');
invoke($api, 'append', ['entries' => []]);
assertSameValue('2', (string) invoke($api, 'changeToken'), 'An empty append should not bump the token.');

$updates = [
    ['entry' => entry('entry-c', 'updated-c'), 'expectedVersion' => 1],
    ['entry' => entry('entry-a', 'updated-a'), 'expectedVersion' => 1],
];
$updateResult = invoke($api, 'update', ['updates' => $updates]);
assertSameValue(['entry-c', 'entry-a'], array_column($updateResult['entries'], 'id'), 'Update response order changed.');
assertSameValue('3', (string) invoke($api, 'changeToken'), 'A multi-row update should bump once.');

assertThrows(
    static fn () => invoke($api, 'update', ['updates' => [
        ['entry' => entry('entry-a', 'stale'), 'expectedVersion' => 1],
    ]]),
    409,
    'REMOTE_VERSION_STALE'
);
assertSameValue('3', (string) invoke($api, 'changeToken'), 'A stale update should not bump the token.');
invoke($api, 'update', ['updates' => []]);
assertSameValue('3', (string) invoke($api, 'changeToken'), 'An empty update should not bump the token.');
assertThrows(
    static fn () => invoke($api, 'update', ['updates' => [
        ['entry' => entry('entry-b', 'duplicate-1'), 'expectedVersion' => 1],
        ['entry' => entry('entry-b', 'duplicate-2'), 'expectedVersion' => 1],
    ]]),
    400,
    'INVALID_REQUEST'
);

$deleteResult = invoke($api, 'delete', ['preconditions' => [
    ['id' => 'entry-c', 'expectedVersion' => 2],
    ['id' => 'entry-a', 'expectedVersion' => 2],
]]);
assertSameValue(['entry-c', 'entry-a'], $deleteResult['deleted'], 'Delete response order changed.');
assertSameValue('4', (string) invoke($api, 'changeToken'), 'A multi-row delete should bump once.');
invoke($api, 'delete', ['preconditions' => []]);
assertSameValue('4', (string) invoke($api, 'changeToken'), 'An empty delete should not bump the token.');

$configPayload = [
    'key' => 'theme',
    'value' => 'dark',
    'updated_at' => '2026-08-25T10:00:00Z',
];
invoke($api, 'updateConfig', $configPayload);
assertSameValue('5', (string) invoke($api, 'changeToken'), 'A config insert should bump the token.');
invoke($api, 'updateConfig', $configPayload + ['expectedVersion' => 1]);
assertSameValue('5', (string) invoke($api, 'changeToken'), 'An identical config update should not bump the token.');

$failedEntry = entry('entry-failed');
$conflicting = entry('entry-b', 'different content');
assertThrows(
    static fn () => invoke($api, 'append', ['entries' => [$failedEntry, $conflicting]]),
    409,
    'REMOTE_APPEND_CONFLICT'
);
assertSameValue('5', (string) invoke($api, 'changeToken'), 'A failed batch should not bump the token.');
assertSameValue(0, (int) $pdo->query("SELECT COUNT(*) FROM time_entries WHERE id = 'entry-failed'")->fetchColumn(), 'A failed batch partially committed.');

assertThrows(
    static fn () => invoke($api, 'append', ['entries' => [entry('duplicate'), entry('duplicate')]]),
    400,
    'INVALID_REQUEST'
);
assertThrows(
    static fn () => invoke($api, 'delete', ['preconditions' => [
        ['id' => 'entry-b', 'expectedVersion' => 1],
        ['id' => 'entry-b', 'expectedVersion' => 1],
    ]]),
    400,
    'INVALID_REQUEST'
);

$reader = new Database($config);
$writer = new PDO($settings['dsn'], $settings['username'], $settings['password'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
]);
$before = invoke($api, 'snapshot');
$reader->consistentRead(function (PDO $read) use ($writer, $before): void {
    $entryBefore = $read->query("SELECT project FROM time_entries WHERE id = 'entry-b'")->fetchColumn();
    $writer->beginTransaction();
    $writer->exec("UPDATE time_entries SET project = 'writer-project', remote_version = remote_version + 1 WHERE id = 'entry-b'");
    $writer->exec('UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1');
    $writer->commit();

    $read->query('SELECT `key`, `value` FROM config ORDER BY `key`')->fetchAll();
    $tokenDuringRead = (string) $read->query('SELECT change_seq FROM app_meta WHERE id = 1')->fetchColumn();
    assertSameValue('project', $entryBefore, 'The read transaction did not capture the old entry.');
    assertSameValue((string) $before['changeToken'], $tokenDuringRead, 'The read transaction mixed database snapshots.');
});

$after = invoke($api, 'snapshot');
assertSameValue('writer-project', $after['entries'][0]['entry']['project'], 'The post-mutation snapshot missed the writer.');
assertSameValue('6', (string) $after['changeToken'], 'The writer mutation should bump the token once.');

fwrite(STDOUT, "Session 1 MySQL integration checks passed.\n");
