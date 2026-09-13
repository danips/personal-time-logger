#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Lightweight, dependency-free PHP function/method cyclomatic complexity collector.
 *
 * This intentionally provides a stable trend metric, not a full static-analysis model.
 * Complexity starts at 1 and increments for common decision/branch tokens and ternaries.
 */

$files = array_slice($argv, 1);
if ($files === []) {
    fwrite(STDERR, "Usage: php .code-quality/scripts/php-complexity.php <file.php> [...]\n");
    exit(2);
}

$decisionTokens = array_filter([
    defined('T_IF') ? T_IF : null,
    defined('T_ELSEIF') ? T_ELSEIF : null,
    defined('T_FOR') ? T_FOR : null,
    defined('T_FOREACH') ? T_FOREACH : null,
    defined('T_WHILE') ? T_WHILE : null,
    defined('T_CASE') ? T_CASE : null,
    defined('T_CATCH') ? T_CATCH : null,
    defined('T_BOOLEAN_AND') ? T_BOOLEAN_AND : null,
    defined('T_BOOLEAN_OR') ? T_BOOLEAN_OR : null,
    defined('T_LOGICAL_AND') ? T_LOGICAL_AND : null,
    defined('T_LOGICAL_OR') ? T_LOGICAL_OR : null,
    defined('T_COALESCE') ? T_COALESCE : null,
    defined('T_MATCH') ? T_MATCH : null,
], static fn ($value): bool => $value !== null);
$decisionTokenSet = array_fill_keys($decisionTokens, true);

$functions = [];
$parseErrors = [];

foreach ($files as $file) {
    if (!is_file($file)) {
        $parseErrors[] = ['file' => $file, 'message' => 'file not found'];
        continue;
    }

    $source = file_get_contents($file);
    if ($source === false) {
        $parseErrors[] = ['file' => $file, 'message' => 'unable to read file'];
        continue;
    }

    try {
        $tokens = token_get_all($source, TOKEN_PARSE);
    } catch (ParseError $error) {
        $parseErrors[] = ['file' => $file, 'message' => $error->getMessage()];
        continue;
    }

    $braceDepth = 0;
    $functionStack = [];
    $pendingFunction = null;
    $lastLine = 1;

    foreach ($tokens as $index => $token) {
        if (is_array($token)) {
            [$id, $text, $line] = $token;
            $lastLine = $line;

            if ($id === T_FUNCTION) {
                $name = '(anonymous)';
                for ($lookahead = $index + 1, $count = count($tokens); $lookahead < $count; $lookahead++) {
                    $next = $tokens[$lookahead];
                    if (is_array($next) && in_array($next[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                        continue;
                    }
                    if ($next === '&') {
                        continue;
                    }
                    if (is_array($next) && $next[0] === T_STRING) {
                        $name = $next[1];
                    }
                    break;
                }
                $pendingFunction = [
                    'file' => str_replace('\\', '/', $file),
                    'symbol' => $name,
                    'line' => $line,
                    'cyclomatic' => 1,
                ];
                continue;
            }

            if ($functionStack !== [] && isset($decisionTokenSet[$id])) {
                $functionStack[array_key_last($functionStack)]['cyclomatic']++;
            }
            continue;
        }

        if ($token === '{') {
            $braceDepth++;
            if ($pendingFunction !== null) {
                $pendingFunction['body_depth'] = $braceDepth;
                $functionStack[] = $pendingFunction;
                $pendingFunction = null;
            }
            continue;
        }

        if ($token === '}') {
            if ($functionStack !== []) {
                $top = $functionStack[array_key_last($functionStack)];
                if (($top['body_depth'] ?? -1) === $braceDepth) {
                    unset($top['body_depth']);
                    $functions[] = $top;
                    array_pop($functionStack);
                }
            }
            $braceDepth = max(0, $braceDepth - 1);
            continue;
        }

        if ($token === '?' && $functionStack !== []) {
            $functionStack[array_key_last($functionStack)]['cyclomatic']++;
        }
    }

    foreach ($functionStack as $unfinished) {
        unset($unfinished['body_depth']);
        $parseErrors[] = [
            'file' => str_replace('\\', '/', $file),
            'line' => $unfinished['line'] ?? $lastLine,
            'message' => 'function body did not close while collecting complexity',
        ];
    }
}

echo json_encode([
    'functions' => $functions,
    'parse_errors' => $parseErrors,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
