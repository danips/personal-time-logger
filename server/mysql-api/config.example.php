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
    // Use exact origins. For Firefox, this is normally the extension origin.
    'cors_origins' => [
        'moz-extension://replace-with-extension-id',
    ],
];
