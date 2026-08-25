<?php

declare(strict_types=1);

namespace PersonalTimeLogger\MysqlApi;

final class Config
{
    public function __construct(private readonly array $values)
    {
        $database = $values['database'] ?? null;
        $tokenHash = $values['api_token_sha256'] ?? '';
        if (!is_array($database)
            || !is_string($database['dsn'] ?? null)
            || !is_string($database['username'] ?? null)
            || !is_string($database['password'] ?? null)
            || !is_string($tokenHash)
            || !preg_match('/\A[a-f0-9]{64}\z/', $tokenHash)) {
            throw new ApiException(500, 'SERVER_CONFIG_INVALID', 'The API server configuration is invalid.');
        }

        $origins = $values['cors_origins'] ?? [];
        if (!is_array($origins) || array_filter($origins, static fn ($origin) => !is_string($origin))) {
            throw new ApiException(500, 'SERVER_CONFIG_INVALID', 'The API CORS configuration is invalid.');
        }

        if (!is_bool($values['allow_moz_extension_origins'] ?? false)) {
            throw new ApiException(500, 'SERVER_CONFIG_INVALID', 'The Firefox extension CORS setting is invalid.');
        }
    }

    public static function load(): self
    {
        $path = getenv('PTL_MYSQL_API_CONFIG') ?: dirname(__DIR__) . '/config.php';
        if (!is_file($path) || !is_readable($path)) {
            throw new ApiException(500, 'SERVER_CONFIG_MISSING', 'The API server configuration is missing.');
        }
        $values = require $path;
        if (!is_array($values)) {
            throw new ApiException(500, 'SERVER_CONFIG_INVALID', 'The API server configuration is invalid.');
        }
        return new self($values);
    }

    public function database(): array
    {
        return $this->values['database'];
    }

    public function allowsOrigin(?string $origin): bool
    {
        if ($origin === null || $origin === '') return false;
        if (in_array($origin, $this->values['cors_origins'], true)) return true;
        if (($this->values['allow_moz_extension_origins'] ?? false) !== true) return false;

        // Firefox assigns each browser instance a random UUID-based extension
        // origin. Keep the allowance limited to that scheme and UUID shape;
        // public/index.php still requires a bearer token for every API route.
        return preg_match(
            '/\\Amoz-extension:\\/\\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z/i',
            $origin
        ) === 1;
    }

    public function tokenMatches(string $token): bool
    {
        return hash_equals($this->values['api_token_sha256'], hash('sha256', $token));
    }
}
