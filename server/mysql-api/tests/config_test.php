<?php

declare(strict_types=1);

use PersonalTimeLogger\MysqlApi\ApiException;
use PersonalTimeLogger\MysqlApi\Config;

require_once dirname(__DIR__) . '/src/ApiException.php';
require_once dirname(__DIR__) . '/src/Config.php';

function assertSameValue(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        throw new RuntimeException($message . ' Expected ' . var_export($expected, true) . ', got ' . var_export($actual, true) . '.');
    }
}

$values = [
    'database' => [
        'dsn' => 'mysql:host=127.0.0.1;dbname=test',
        'username' => 'user',
        'password' => 'password',
    ],
    'api_token_sha256' => str_repeat('0', 64),
    'cors_origins' => ['https://admin.example.com'],
    'allow_moz_extension_origins' => true,
];
$config = new Config($values);

assertSameValue(true, $config->allowsOrigin('https://admin.example.com'), 'Configured web origin should be allowed.');
assertSameValue(true, $config->allowsOrigin('moz-extension://f3bf897b-6d55-480f-b0f0-d1c425c789ad'), 'Valid Firefox extension origin should be allowed.');
assertSameValue(true, $config->allowsOrigin('moz-extension://0253418e-62f8-424c-97c9-3e81df4ef30f'), 'A second valid Firefox extension origin should be allowed.');
assertSameValue(false, $config->allowsOrigin('moz-extension://not-a-uuid'), 'Malformed Firefox extension origin should be rejected.');
assertSameValue(false, $config->allowsOrigin('https://attacker.example.com'), 'Unconfigured web origin should be rejected.');
assertSameValue(false, $config->allowsOrigin('https://admin.example.com/'), 'Origins with a path should be rejected.');

$omitted = new Config(array_diff_key($values, ['cors_origins' => true]));
assertSameValue(false, $omitted->allowsOrigin('https://admin.example.com'), 'Omitted origin list should default to no configured web origins.');
assertSameValue(true, $omitted->allowsOrigin('moz-extension://f3bf897b-6d55-480f-b0f0-d1c425c789ad'), 'Omitted origin list should retain the extension-origin setting.');

$empty = new Config([...$values, 'cors_origins' => []]);
assertSameValue(false, $empty->allowsOrigin('https://admin.example.com'), 'An explicit empty origin list should deny web origins.');
assertSameValue(true, $empty->allowsOrigin('moz-extension://f3bf897b-6d55-480f-b0f0-d1c425c789ad'), 'An explicit empty origin list should retain the extension-origin setting.');

$disabled = new Config([...$values, 'allow_moz_extension_origins' => false]);
assertSameValue(false, $disabled->allowsOrigin('moz-extension://f3bf897b-6d55-480f-b0f0-d1c425c789ad'), 'Firefox origins should be disabled when configured off.');

try {
    new Config([...$values, 'allow_moz_extension_origins' => 'yes']);
    throw new RuntimeException('Invalid Firefox extension CORS setting should fail.');
} catch (ApiException $error) {
    assertSameValue('SERVER_CONFIG_INVALID', $error->errorCode, 'Invalid Firefox extension CORS setting error code changed.');
}

try {
    new Config([...$values, 'cors_origins' => ['https://admin.example.com', 42]]);
    throw new RuntimeException('Invalid CORS origin list should fail.');
} catch (ApiException $error) {
    assertSameValue('SERVER_CONFIG_INVALID', $error->errorCode, 'Invalid CORS origin list error code changed.');
}

fwrite(STDOUT, "Config CORS checks passed.\n");
