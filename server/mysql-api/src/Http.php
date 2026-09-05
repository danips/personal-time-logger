<?php

declare(strict_types=1);

namespace PersonalTimeLogger\MysqlApi;

final class Http
{
    public static function respond(mixed $body, int $status = 200, ?string $origin = null, bool $allowOrigin = false): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        if ($origin !== null && $allowOrigin) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
        }
        echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        exit;
    }

    public static function error(ApiException $error, ?string $origin = null, bool $allowOrigin = false): never
    {
        self::respond([
            'error' => [
                'code' => $error->errorCode,
                'message' => $error->getMessage(),
            ],
        ], $error->status, $origin, $allowOrigin);
    }

    public static function jsonBody(): array
    {
        $contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
        if (!preg_match('/\Aapplication\/json(?:\s*;|\s*\z)/i', $contentType)) {
            throw new ApiException(400, 'INVALID_REQUEST', 'The request must use JSON content type.');
        }
        $raw = file_get_contents('php://input');
        if ($raw === false || $raw === '' || strlen($raw) > 2_000_000) {
            throw new ApiException(400, 'INVALID_JSON', 'The request body must be a JSON object.');
        }
        try {
            $body = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(400, 'INVALID_JSON', 'The request body must be valid JSON.');
        }
        if (!is_array($body) || array_is_list($body)) {
            throw new ApiException(400, 'INVALID_JSON', 'The request body must be a JSON object.');
        }
        return $body;
    }

    public static function bearerToken(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION']
            ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
            ?? '';
        if ($header === '' && function_exists('getallheaders')) {
            foreach (getallheaders() as $name => $value) {
                if (strcasecmp((string) $name, 'Authorization') === 0) {
                    $header = is_string($value) ? $value : '';
                    break;
                }
            }
        }
        if (!preg_match('/\ABearer\s+([^\s]+)\z/', $header, $matches)) {
            throw new ApiException(401, 'AUTH_REQUIRED', 'A bearer token is required.');
        }
        return $matches[1];
    }
}
