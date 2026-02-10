-- Add source column to track whether a suggestion came from rules engine or AI
ALTER TABLE suggestions ADD COLUMN source TEXT DEFAULT 'rules'
    CHECK (source IN ('rules', 'ai'));

-- Update user_decision constraint to include 'executed' state
ALTER TABLE suggestions DROP CONSTRAINT suggestions_user_decision_check;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_user_decision_check
    CHECK (user_decision IN ('pending', 'approved', 'rejected', 'skipped', 'executed'));
