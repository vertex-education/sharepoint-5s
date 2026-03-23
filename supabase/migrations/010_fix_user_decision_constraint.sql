-- Fix: Allow 'executed' as a valid user_decision value
-- This was preventing execute-actions from marking suggestions as executed

ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_user_decision_check;

ALTER TABLE suggestions ADD CONSTRAINT suggestions_user_decision_check
    CHECK (user_decision IN ('pending', 'approved', 'rejected', 'skipped', 'executed'));
