<?php

declare(strict_types=1);

$token = (string) getenv('PTL_TEST_HTTP_TOKEN');

return [
    'database' => [
        'dsn' => (string) getenv('PTL_TEST_MYSQL_DSN'),
        'username' => (string) getenv('PTL_TEST_MYSQL_USER'),
        'password' => (string) getenv('PTL_TEST_MYSQL_PASSWORD'),
    ],
    'api_token_sha256' => hash('sha256', $token),
    'cors_origins' => [],
];
