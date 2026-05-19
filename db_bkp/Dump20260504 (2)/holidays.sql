-- =============================================================================
-- HOLIDAYS TABLE
-- Stores company/national holidays used for project end-date calculation.
-- Run this script on your MySQL database.
-- =============================================================================

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

-- =============================================================================
-- SAMPLE DATA  (remove / adjust as needed)
-- =============================================================================
INSERT IGNORE INTO `holidays` (`holiday_date`, `title`, `is_recurring`) VALUES
  ('2026-01-01', 'New Year''s Day',           1),
  ('2026-01-26', 'Republic Day',              1),
  ('2026-03-25', 'Holi',                      0),
  ('2026-04-14', 'Dr. Ambedkar Jayanti',      1),
  ('2026-04-18', 'Good Friday',               0),
  ('2026-08-15', 'Independence Day',          1),
  ('2026-10-02', 'Gandhi Jayanti',            1),
  ('2026-10-24', 'Dussehra',                  0),
  ('2026-11-14', 'Diwali',                    0),
  ('2026-12-25', 'Christmas Day',             1);
