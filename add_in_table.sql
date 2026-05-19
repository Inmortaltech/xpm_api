-- =============================================================================
-- DATABASE UPDATES FOR WORKXKLOUD PROJECT
-- Run these commands on your production database to support new features.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. UPDATES FOR PROJECTS TABLE
-- Adds support for Technical Lead and mandatory Technology fields.
-- -----------------------------------------------------------------------------
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS technical_lead VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS technology VARCHAR(255) DEFAULT NULL;

-- -----------------------------------------------------------------------------
-- 2. UPDATES FOR USERS TABLE
-- Adds support for Customer profiles (Account and Company names).
-- -----------------------------------------------------------------------------
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS account_name VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS company_name VARCHAR(255) DEFAULT NULL;

-- -----------------------------------------------------------------------------
-- 3. UPDATES FOR RESOURCES TABLE
-- Adds support for Shift and Working Days (Monday to Sunday) checkboxes.
-- -----------------------------------------------------------------------------
ALTER TABLE resources 
ADD COLUMN IF NOT EXISTS shift VARCHAR(100) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS monday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS tuesday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS wednesday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS thursday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS friday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS saturday TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS sunday TINYINT(1) DEFAULT 0;

-- -----------------------------------------------------------------------------
-- 4. ADDITIONAL UPDATES FOR PROJECTS TABLE
-- Adds support for Resource Allocation JSON data.
-- -----------------------------------------------------------------------------
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS resource_allocations LONGTEXT DEFAULT NULL;

-- -----------------------------------------------------------------------------
-- 5. HOLIDAYS TABLE
-- Stores company / national holidays used for project end-date calculation.
-- The `is_recurring` flag means the holiday repeats every year on that MM-DD.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `holidays` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `holiday_date` DATE         NOT NULL,
  `title`        VARCHAR(255) NOT NULL,
  `description`  TEXT         DEFAULT NULL,
  `is_recurring` TINYINT(1)   NOT NULL DEFAULT 0
                               COMMENT '1 = repeat every year on same MM-DD, 0 = one-time',
  `is_active`    TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME         NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_holiday_date` (`holiday_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

