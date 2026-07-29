-- Migration 0004: rename alerts table to alert_history.
-- The production database was already migrated manually on 2026-07-29.
-- This migration is idempotent and safe to run in CI.

-- Remove backward-compat view if it still exists
DROP VIEW IF EXISTS alerts;

-- Create the view for backward compatibility
CREATE VIEW IF NOT EXISTS alerts AS SELECT * FROM alert_history;

-- Indexes for the renamed table
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alert_history(status, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_trace ON alert_history(trace_id);
