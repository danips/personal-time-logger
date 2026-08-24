<?php

declare(strict_types=1);

use PersonalTimeLogger\MysqlApi\Api;
use PersonalTimeLogger\MysqlApi\ApiException;
use PersonalTimeLogger\MysqlApi\Config;
use PersonalTimeLogger\MysqlApi\Database;
use PersonalTimeLogger\MysqlApi\Http;

require_once dirname(__DIR__) . '/src/ApiException.php';
require_once dirname(__DIR__) . '/src/Config.php';
require_once dirname(__DIR__) . '/src/Database.php';
require_once dirname(__DIR__) . '/src/Http.php';
require_once dirname(__DIR__) . '/src/Validator.php';
require_once dirname(__DIR__) . '/src/Api.php';

$origin = $_SERVER['HTTP_ORIGIN'] ?? null;
$allowOrigin = false;

try {
    $config = Config::load();
    $allowOrigin = $config->allowsOrigin($origin);

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        if ($origin !== null && !$allowOrigin) {
            throw new ApiException(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
        }
        http_response_code(204);
        if ($allowOrigin) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
        }
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Authorization, Content-Type');
        header('Access-Control-Max-Age: 600');
        exit;
    }

    if ($origin !== null && !$allowOrigin) {
        throw new ApiException(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
    }

    $token = Http::bearerToken();
    if (!$config->tokenMatches($token)) {
        throw new ApiException(401, 'AUTH_INVALID', 'The bearer token is invalid.');
    }

    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    if (str_starts_with($path, '/index.php')) $path = substr($path, strlen('/index.php')) ?: '/';
    $api = new Api(new Database($config));
    $response = $api->dispatch($_SERVER['REQUEST_METHOD'] ?? 'GET', $path);
    Http::respond($response, 200, $origin, $allowOrigin);
} catch (ApiException $error) {
    Http::error($error, $origin, $allowOrigin);
} catch (PDOException $error) {
    error_log('Personal Time Logger MySQL API database error: ' . $error->getCode());
    Http::error(new ApiException(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable.'), $origin, $allowOrigin);
} catch (Throwable $error) {
    error_log('Personal Time Logger MySQL API internal error: ' . $error->getCode());
    Http::error(new ApiException(500, 'INTERNAL_ERROR', 'The API could not complete the request.'), $origin, $allowOrigin);
}
