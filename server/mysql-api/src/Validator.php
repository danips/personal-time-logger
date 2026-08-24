<?php

declare(strict_types=1);

namespace PersonalTimeLogger\MysqlApi;

use DateTimeImmutable;
use DateTimeZone;

final class Validator
{
    public const ENTRY_FIELDS = [
        'id', 'project', 'task', 'description', 'start_at', 'end_at',
        'duration_seconds', 'status', 'created_at', 'updated_at', 'deleted_at',
        'device_id', 'revision', 'multiply',
    ];

    public static function entry(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) self::invalid('entry must be an object.');
        foreach (self::ENTRY_FIELDS as $field) {
            if (!array_key_exists($field, $value)) self::invalid("entry is missing {$field}.");
        }
        foreach (array_keys($value) as $field) {
            if (!in_array($field, self::ENTRY_FIELDS, true)) self::invalid("entry field {$field} is not supported.");
        }

        return [
            'id' => self::text($value['id'], 'id', 64, false),
            'project' => self::text($value['project'], 'project', 65535),
            'task' => self::text($value['task'], 'task', 65535),
            'description' => self::text($value['description'], 'description', 65535),
            'start_at' => self::timestamp($value['start_at'], 'start_at'),
            'end_at' => self::optionalTimestamp($value['end_at'], 'end_at'),
            'duration_seconds' => self::integer($value['duration_seconds'], 'duration_seconds', 0),
            'status' => self::status($value['status']),
            'created_at' => self::timestamp($value['created_at'], 'created_at'),
            'updated_at' => self::timestamp($value['updated_at'], 'updated_at'),
            'deleted_at' => self::optionalTimestamp($value['deleted_at'], 'deleted_at'),
            'device_id' => self::text($value['device_id'], 'device_id', 128),
            'revision' => self::integer($value['revision'], 'revision', 1),
            'multiply' => self::multiply($value['multiply']),
        ];
    }

    public static function id(mixed $value): string
    {
        return self::text($value, 'id', 64, false);
    }

    public static function version(mixed $value, string $field = 'expectedVersion'): int
    {
        return self::integer($value, $field, 1);
    }

    public static function configKey(mixed $value): string
    {
        return self::text($value, 'key', 128, false);
    }

    public static function configValue(mixed $value): string
    {
        return self::text($value, 'value', 65535);
    }

    public static function normalizeTimestamp(mixed $value, string $field): string
    {
        return self::timestamp($value, $field);
    }

    private static function text(mixed $value, string $field, int $maxBytes, bool $allowEmpty = true): string
    {
        if (!is_string($value)) self::invalid("{$field} must be text.");
        if (!$allowEmpty && trim($value) === '') self::invalid("{$field} must not be empty.");
        if (strlen($value) > $maxBytes) self::invalid("{$field} is too long.");
        return $value;
    }

    private static function integer(mixed $value, string $field, int $minimum): int
    {
        if (is_int($value)) $integer = $value;
        elseif (is_string($value) && preg_match('/\A\d+\z/', $value)) $integer = (int) $value;
        elseif (is_float($value) && is_finite($value) && floor($value) === $value) $integer = (int) $value;
        else self::invalid("{$field} must be an integer.");
        if ($integer < $minimum) self::invalid("{$field} is out of range.");
        return $integer;
    }

    private static function timestamp(mixed $value, string $field): string
    {
        if (!is_string($value)
            || !preg_match('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\z/', $value)) {
            self::invalid("{$field} must be an ISO-8601 timestamp.");
        }
        try {
            $date = new DateTimeImmutable($value);
        } catch (\Exception) {
            self::invalid("{$field} must be a valid timestamp.");
        }
        $errors = DateTimeImmutable::getLastErrors();
        if (is_array($errors) && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) {
            self::invalid("{$field} must be a valid timestamp.");
        }
        return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function optionalTimestamp(mixed $value, string $field): ?string
    {
        if ($value === '' || $value === null) return null;
        return self::timestamp($value, $field);
    }

    private static function status(mixed $value): string
    {
        if ($value !== 'ok' && $value !== 'needs_review') self::invalid('status must be ok or needs_review.');
        return $value;
    }

    private static function multiply(mixed $value): ?string
    {
        if ($value === '' || $value === null) return null;
        if (!is_int($value) && !is_float($value) && !is_string($value)) self::invalid('multiply must be numeric or empty.');
        $text = str_replace(',', '.', trim((string) $value));
        if (!preg_match('/\A\d+(?:\.\d{1,3})?\z/', $text)) self::invalid('multiply is invalid.');
        $number = (float) $text;
        if (!is_finite($number) || $number < 1 || $number > 5.001) self::invalid('multiply is out of range.');
        return number_format($number, 3, '.', '');
    }

    private static function invalid(string $message): never
    {
        throw new ApiException(400, 'ENTRY_INVALID', $message);
    }
}
