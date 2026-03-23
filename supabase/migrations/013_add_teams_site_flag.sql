-- Add is_teams_site flag to crawl_queue for filtering Teams channel folders
ALTER TABLE crawl_queue ADD COLUMN IF NOT EXISTS is_teams_site BOOLEAN DEFAULT FALSE;
