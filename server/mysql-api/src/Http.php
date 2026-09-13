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
        $maxBytes = 2_000_000;
        $declaredLength = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
        if ($declaredLength > $maxBytes) {
            throw new ApiException(413, 'INVALID_REQUEST', 'The request body is too large.');
        }
        $stream = fopen('php://input', 'rb');
        $raw = $stream === false ? false : stream_get_contents($stream, $maxBytes + 1);
        if ($raw === false || $raw === '' || strlen($raw) > $maxBytes) {
            throw new ApiException(strlen((string) $raw) > $maxBytes ? 413 : 400, 'INVALID_REQUEST', 'The request body must be a JSON object.');
        }
        try {
            $body = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(400, 'INVALID_REQUEST', 'The request body must be valid JSON.');
        }
        if (!is_array($body) || array_is_list($body)) {
            throw new ApiException(400, 'INVALID_REQUEST', 'The request body must be a JSON object.');
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
