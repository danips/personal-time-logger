<?php

declare(strict_types=1);

namespace PersonalTimeLogger\MysqlApi;

use PDO;
use PDOException;

final class Database
{
    private PDO $pdo;

    public function __construct(Config $config)
    {
        try {
            $settings = $config->database();
            $this->pdo = new PDO($settings['dsn'], $settings['username'], $settings['password'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
        } catch (PDOException $error) {
            error_log('Personal Time Logger MySQL connection failed: ' . $error->getCode());
            throw new ApiException(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable.');
        }
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    /** @template T @param callable(PDO):T $callback @return T */
    public function transaction(callable $callback): mixed
    {
        $this->pdo->beginTransaction();
        try {
            $result = $callback($this->pdo);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $error) {
            if ($this->pdo->inTransaction()) $this->pdo->rollBack();
            throw $error;
        }
    }

    /** @template T @param callable(PDO):T $callback @return T */
    public function consistentRead(callable $callback): mixed
    {
        $this->pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        $this->pdo->exec('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
        try {
            $result = $callback($this->pdo);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $error) {
            if ($this->pdo->inTransaction()) $this->pdo->rollBack();
            throw $error;
        }
    }

    public function changeSeq(PDO $pdo): string
    {
        $statement = $pdo->prepare('UPDATE app_meta SET change_seq = change_seq + 1, updated_at = ? WHERE id = 1');
        $statement->execute([gmdate('Y-m-d\TH:i:s.v\Z')]);
        if ($statement->rowCount() !== 1) {
            throw new ApiException(500, 'DATABASE_SCHEMA_INVALID', 'The API metadata row is missing.');
        }
        $result = $pdo->query('SELECT change_seq FROM app_meta WHERE id = 1')->fetchColumn();
        return (string) $result;
    }
}
