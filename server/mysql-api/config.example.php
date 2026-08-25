<?php

declare(strict_types=1);

/*
 * Copy this file to config.php outside the public/ directory and fill in the
 * deployment values. Never commit config.php or a raw API token.
 */
return [
    'database' => [
        'dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=personal_time_logger;charset=utf8mb4',
        'username' => 'personal_time_logger_api',
        'password' => 'replace-with-database-password',
    ],
    // SHA-256 hex digest of the 32-byte random bearer token.
    'api_token_sha256' => 'replace-with-64-character-sha256-hex-digest',
    // Keep explicit web origins here. Firefox extension origins are random per
    // browser instance; the validated moz-extension policy below avoids a
    // per-device allowlist while bearer authentication remains mandatory.
    'cors_origins' => [
        // 'https://your-admin.example.com',
    ],
    'allow_moz_extension_origins' => true,
];
