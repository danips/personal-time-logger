CREATE TABLE IF NOT EXISTS time_entries (
    id                VARCHAR(64) NOT NULL,
    project           TEXT NOT NULL,
    task              TEXT NOT NULL,
    description       TEXT NOT NULL,
    start_at          VARCHAR(32) NOT NULL,
    end_at            VARCHAR(32) NULL,
    duration_seconds  BIGINT UNSIGNED NOT NULL,
    status            VARCHAR(32) NOT NULL,
    created_at        VARCHAR(32) NOT NULL,
    updated_at        VARCHAR(32) NOT NULL,
    deleted_at        VARCHAR(32) NULL,
    device_id         VARCHAR(128) NOT NULL,
    revision          BIGINT UNSIGNED NOT NULL,
    multiply          DECIMAL(6,3) NULL,
    remote_version    BIGINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    INDEX idx_start_at (start_at),
    INDEX idx_updated_at (updated_at),
    INDEX idx_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS config (
    `key`           VARCHAR(128) NOT NULL,
    `value`         TEXT NOT NULL,
    updated_at      VARCHAR(32) NOT NULL,
    remote_version  BIGINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS app_meta (
    id             TINYINT UNSIGNED NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    change_seq     BIGINT UNSIGNED NOT NULL,
    updated_at     VARCHAR(32) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO app_meta (id, schema_version, change_seq, updated_at)
VALUES (1, 1, 1, UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE id = id;
