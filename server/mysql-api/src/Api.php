<?php

declare(strict_types=1);

namespace PersonalTimeLogger\MysqlApi;

use PDO;

final class Api
{
    private const ROUTES = [
        '/v1/health' => 'GET',
        '/v1/change-token' => 'GET',
        '/v1/snapshot' => 'GET',
        '/v1/entries/append' => 'POST',
        '/v1/entries/update' => 'POST',
        '/v1/entries/delete' => 'POST',
        '/v1/config/update' => 'POST',
    ];

    public function __construct(private readonly Database $database)
    {
    }

    public function dispatch(string $method, string $path): array
    {
        if (!isset(self::ROUTES[$path])) {
            throw new ApiException(404, 'ROUTE_NOT_FOUND', 'The requested API route does not exist.');
        }
        if ($method !== self::ROUTES[$path]) {
            throw new ApiException(405, 'METHOD_NOT_ALLOWED', 'The requested method is not allowed.');
        }
        return match ($path) {
            '/v1/health' => $this->health(),
            '/v1/change-token' => ['changeToken' => $this->changeToken()],
            '/v1/snapshot' => $this->snapshot(),
            '/v1/entries/append' => $this->append(Http::jsonBody()),
            '/v1/entries/update' => $this->update(Http::jsonBody()),
            '/v1/entries/delete' => $this->delete(Http::jsonBody()),
            '/v1/config/update' => $this->updateConfig(Http::jsonBody()),
        };
    }

    private function health(): array
    {
        $meta = $this->meta();
        $version = (string) $this->database->pdo()->query('SELECT VERSION()')->fetchColumn();
        $parts = explode('.', $version);
        return [
            'ok' => true,
            'service' => 'personal-time-logger',
            'apiVersion' => 1,
            'schemaVersion' => $meta['schema_version'],
            'mysql' => ($parts[0] ?? '0') . '.' . ($parts[1] ?? '0'),
        ];
    }

    private function changeToken(): string
    {
        return (string) $this->meta()['change_seq'];
    }

    private function snapshot(): array
    {
        return $this->database->consistentRead(function (PDO $pdo): array {
            $entries = [];
            $statement = $pdo->query(
                'SELECT id, project, task, description, start_at, end_at, duration_seconds, status,
                        created_at, updated_at, deleted_at, device_id, revision, multiply, remote_version
                 FROM time_entries ORDER BY id'
            );
            foreach ($statement as $row) {
                $entries[] = [
                    'entry' => $this->entryFromRow($row),
                    'version' => (int) $row['remote_version'],
                ];
            }

            $config = [];
            $statement = $pdo->query(
                'SELECT `key`, `value`, updated_at, remote_version FROM config ORDER BY `key`'
            );
            foreach ($statement as $row) {
                $config[] = [
                    'key' => (string) $row['key'],
                    'value' => (string) $row['value'],
                    'updated_at' => Validator::normalizeTimestamp($row['updated_at'], 'updated_at'),
                    'version' => (int) $row['remote_version'],
                ];
            }

            $meta = $pdo->query('SELECT change_seq FROM app_meta WHERE id = 1')->fetch();
            if ($meta === false) {
                throw new ApiException(500, 'DATABASE_SCHEMA_INVALID', 'The API metadata row is missing.');
            }

            return [
                'changeToken' => (string) $meta['change_seq'],
                'entries' => $entries,
                'config' => $config,
            ];
        });
    }

    private function append(array $body): array
    {
        $entries = $this->list($body, 'entries', 500);
        $normalized = array_map([Validator::class, 'entry'], $entries);
        $this->assertUniqueIds($normalized);
        $ordered = $this->withPositions($normalized);
        usort($ordered, static fn (array $left, array $right): int => strcmp($left['entry']['id'], $right['entry']['id']));
        $results = array_fill(0, count($ordered), null);
        $this->database->transaction(function (PDO $pdo) use ($ordered, &$results): void {
            $changed = false;
            foreach ($ordered as $item) {
                $entry = $item['entry'];
                $select = $pdo->prepare('SELECT * FROM time_entries WHERE id = ? FOR UPDATE');
                $select->execute([$entry['id']]);
                $existing = $select->fetch();
                if ($existing !== false) {
                    if ($this->canonicalEntry($this->entryFromRow($existing)) !== $this->canonicalEntry($entry)) {
                        throw new ApiException(409, 'REMOTE_APPEND_CONFLICT', 'An entry with this ID has different content.');
                    }
                    $results[$item['position']] = ['id' => $entry['id'], 'version' => (int) $existing['remote_version']];
                    continue;
                }

                $insert = $pdo->prepare(
                    'INSERT INTO time_entries
                     (id, project, task, description, start_at, end_at, duration_seconds, status,
                      created_at, updated_at, deleted_at, device_id, revision, multiply, remote_version)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
                );
                $insert->execute([
                    $entry['id'], $entry['project'], $entry['task'], $entry['description'],
                    $entry['start_at'], $entry['end_at'], $entry['duration_seconds'], $entry['status'],
                    $entry['created_at'], $entry['updated_at'], $entry['deleted_at'], $entry['device_id'],
                    $entry['revision'], $entry['multiply'],
                ]);
                $changed = true;
                $results[$item['position']] = ['id' => $entry['id'], 'version' => 1];
            }
            if ($changed) {
                $this->database->changeSeq($pdo);
            }
        });
        return ['entries' => $results];
    }

    private function update(array $body): array
    {
        $updates = $this->list($body, 'updates', 500);
        $normalized = [];
        foreach ($updates as $update) {
            if (!is_array($update) || array_is_list($update)
                || array_diff(array_keys($update), ['entry', 'expectedVersion'])
                || !array_key_exists('entry', $update)
                || !array_key_exists('expectedVersion', $update)) {
                throw new ApiException(400, 'INVALID_REQUEST', 'Each update needs entry and expectedVersion.');
            }
            $normalized[] = [
                'entry' => Validator::entry($update['entry']),
                'expectedVersion' => Validator::version($update['expectedVersion']),
            ];
        }

        $ids = array_map(static fn (array $update): string => $update['entry']['id'], $normalized);
        $this->assertUniqueIds($ids);
        $ordered = $this->withPositions($normalized);
        usort($ordered, static fn (array $left, array $right): int => strcmp($left['entry']['id'], $right['entry']['id']));
        $results = array_fill(0, count($ordered), null);
        $this->database->transaction(function (PDO $pdo) use ($ordered, &$results): void {
            $changed = false;
            foreach ($ordered as $item) {
                $update = $item['value'];
                $entry = $update['entry'];
                $existing = $this->lockedEntry($pdo, $entry['id']);
                $this->assertVersion($existing, $update['expectedVersion']);
                $statement = $pdo->prepare(
                    'UPDATE time_entries SET project = ?, task = ?, description = ?, start_at = ?, end_at = ?,
                     duration_seconds = ?, status = ?, created_at = ?, updated_at = ?, deleted_at = ?, device_id = ?,
                     revision = ?, multiply = ?, remote_version = remote_version + 1 WHERE id = ? AND remote_version = ?'
                );
                $statement->execute([
                    $entry['project'], $entry['task'], $entry['description'], $entry['start_at'], $entry['end_at'],
                    $entry['duration_seconds'], $entry['status'], $entry['created_at'], $entry['updated_at'],
                    $entry['deleted_at'], $entry['device_id'], $entry['revision'], $entry['multiply'],
                    $entry['id'], $update['expectedVersion'],
                ]);
                if ($statement->rowCount() !== 1) throw new ApiException(409, 'REMOTE_VERSION_STALE', 'The remote entry changed before the update.');
                $changed = true;
                $results[$item['position']] = ['id' => $entry['id'], 'version' => $update['expectedVersion'] + 1];
            }
            if ($changed) {
                $this->database->changeSeq($pdo);
            }
        });
        return ['entries' => $results];
    }

    private function delete(array $body): array
    {
        $preconditions = $this->list($body, 'preconditions', 500);
        $normalized = [];
        foreach ($preconditions as $precondition) {
            if (!is_array($precondition) || array_is_list($precondition)
                || array_diff(array_keys($precondition), ['id', 'expectedVersion'])
                || !array_key_exists('id', $precondition)
                || !array_key_exists('expectedVersion', $precondition)) {
                throw new ApiException(400, 'INVALID_REQUEST', 'Each delete needs id and expectedVersion.');
            }
            $normalized[] = [
                'id' => Validator::id($precondition['id']),
                'expectedVersion' => Validator::version($precondition['expectedVersion']),
            ];
        }

        $this->assertUniqueIds(array_map(static fn (array $item): string => $item['id'], $normalized));
        $ordered = $this->withPositions($normalized);
        usort($ordered, static fn (array $left, array $right): int => strcmp($left['value']['id'], $right['value']['id']));
        $deleted = array_fill(0, count($ordered), null);
        $this->database->transaction(function (PDO $pdo) use ($ordered, &$deleted): void {
            $changed = false;
            foreach ($ordered as $item) {
                $precondition = $item['value'];
                $existing = $this->lockedEntry($pdo, $precondition['id']);
                $this->assertVersion($existing, $precondition['expectedVersion']);
                $statement = $pdo->prepare('DELETE FROM time_entries WHERE id = ? AND remote_version = ?');
                $statement->execute([$precondition['id'], $precondition['expectedVersion']]);
                if ($statement->rowCount() !== 1) throw new ApiException(409, 'REMOTE_VERSION_STALE', 'The remote entry changed before deletion.');
                $changed = true;
                $deleted[$item['position']] = $precondition['id'];
            }
            if ($changed) {
                $this->database->changeSeq($pdo);
            }
        });
        return ['deleted' => $deleted];
    }

    private function updateConfig(array $body): array
    {
        $allowed = ['key', 'value', 'updated_at', 'expectedVersion'];
        if (array_is_list($body) || array_diff(array_keys($body), $allowed)
            || !array_key_exists('key', $body) || !array_key_exists('value', $body)
            || !array_key_exists('updated_at', $body)) {
            throw new ApiException(400, 'INVALID_REQUEST', 'Config update needs key, value, and updated_at.');
        }
        $key = Validator::configKey($body['key']);
        $value = Validator::configValue($body['value']);
        $updatedAt = Validator::normalizeTimestamp($body['updated_at'], 'updated_at');
        $expectedVersion = array_key_exists('expectedVersion', $body)
            ? Validator::version($body['expectedVersion'])
            : null;

        $result = null;
        $this->database->transaction(function (PDO $pdo) use ($key, $value, $updatedAt, $expectedVersion, &$result): void {
            $select = $pdo->prepare('SELECT `value`, updated_at, remote_version FROM config WHERE `key` = ? FOR UPDATE');
            $select->execute([$key]);
            $existing = $select->fetch();
            if ($existing === false) {
                if ($expectedVersion !== null) throw new ApiException(409, 'CONFIG_CONFLICT', 'The remote config key does not exist.');
                $insert = $pdo->prepare('INSERT INTO config (`key`, `value`, updated_at, remote_version) VALUES (?, ?, ?, 1)');
                $insert->execute([$key, $value, $updatedAt]);
                $this->database->changeSeq($pdo);
                $result = ['key' => $key, 'version' => 1];
                return;
            }
            if ($expectedVersion === null || (int) $existing['remote_version'] !== $expectedVersion) {
                throw new ApiException(409, 'REMOTE_VERSION_STALE', 'The remote config changed before the update.');
            }
            if ((string) $existing['value'] === $value
                && Validator::normalizeTimestamp($existing['updated_at'], 'updated_at') === $updatedAt) {
                $result = ['key' => $key, 'version' => $expectedVersion];
                return;
            }
            $update = $pdo->prepare(
                'UPDATE config SET `value` = ?, updated_at = ?, remote_version = remote_version + 1
                 WHERE `key` = ? AND remote_version = ?'
            );
            $update->execute([$value, $updatedAt, $key, $expectedVersion]);
            if ($update->rowCount() !== 1) throw new ApiException(409, 'REMOTE_VERSION_STALE', 'The remote config changed before the update.');
            $this->database->changeSeq($pdo);
            $result = ['key' => $key, 'version' => $expectedVersion + 1];
        });
        return $result;
    }

    /** @param array<int, array<string, mixed>> $items @return array<int, array<string, mixed>> */
    private function withPositions(array $items): array
    {
        $positioned = [];
        foreach ($items as $position => $item) {
            $positioned[] = ['value' => $item, 'entry' => $item['entry'] ?? $item, 'position' => $position];
        }
        return $positioned;
    }

    /** @param array<int, string|array<string, mixed>> $items */
    private function assertUniqueIds(array $items): void
    {
        $seen = [];
        foreach ($items as $item) {
            $id = is_array($item) ? (string) $item['id'] : $item;
            if (isset($seen[$id])) {
                throw new ApiException(400, 'INVALID_REQUEST', 'A batch contains duplicate entry IDs.');
            }
            $seen[$id] = true;
        }
    }

    private function meta(): array
    {
        $meta = $this->database->pdo()->query('SELECT schema_version, change_seq FROM app_meta WHERE id = 1')->fetch();
        if ($meta === false) throw new ApiException(500, 'DATABASE_SCHEMA_INVALID', 'The API metadata row is missing.');
        return ['schema_version' => (int) $meta['schema_version'], 'change_seq' => (string) $meta['change_seq']];
    }

    private function lockedEntry(PDO $pdo, string $id): array
    {
        $statement = $pdo->prepare('SELECT * FROM time_entries WHERE id = ? FOR UPDATE');
        $statement->execute([$id]);
        $row = $statement->fetch();
        if ($row === false) throw new ApiException(409, 'REMOTE_ENTRY_MISSING', 'The remote entry does not exist.');
        return $row;
    }

    private function assertVersion(array $row, int $expected): void
    {
        if ((int) $row['remote_version'] !== $expected) {
            throw new ApiException(409, 'REMOTE_VERSION_STALE', 'The remote entry changed before the mutation.');
        }
    }

    private function entryFromRow(array $row): array
    {
        return Validator::entry([
            'id' => (string) $row['id'],
            'project' => (string) $row['project'],
            'task' => (string) $row['task'],
            'description' => (string) $row['description'],
            'start_at' => (string) $row['start_at'],
            'end_at' => $row['end_at'] === null ? '' : (string) $row['end_at'],
            'duration_seconds' => (int) $row['duration_seconds'],
            'status' => (string) $row['status'],
            'created_at' => (string) $row['created_at'],
            'updated_at' => (string) $row['updated_at'],
            'deleted_at' => $row['deleted_at'] === null ? '' : (string) $row['deleted_at'],
            'device_id' => (string) $row['device_id'],
            'revision' => (int) $row['revision'],
            'multiply' => $row['multiply'] === null ? '' : (string) $row['multiply'],
        ]);
    }

    private function canonicalEntry(array $entry): string
    {
        return json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }

    private function list(array $body, string $field, int $max): array
    {
        if (array_diff(array_keys($body), [$field]) || !array_key_exists($field, $body)
            || !is_array($body[$field]) || !array_is_list($body[$field])
            || count($body[$field]) > $max) {
            throw new ApiException(400, 'INVALID_REQUEST', "{$field} must be a list of at most {$max} items.");
        }
        return $body[$field];
    }
}
