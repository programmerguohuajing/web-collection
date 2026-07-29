-- Migration 0006: add threshold column to alert_history
ALTER TABLE alert_history ADD COLUMN threshold REAL;
