-- Migration 009: Create crawl_queue table for chunked, resumable crawls
-- Moves the BFS folder queue to the database to avoid memory issues and enable resumption

CREATE TABLE crawl_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    drive_id TEXT NOT NULL,
    graph_path TEXT NOT NULL,
    parent_item_id TEXT,
    depth INT NOT NULL DEFAULT 0,
    folder_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'error')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    processed_at TIMESTAMPTZ
);

-- Index for efficiently fetching pending folders for a scan
CREATE INDEX idx_crawl_queue_scan_pending
    ON crawl_queue(scan_id, status) WHERE status = 'pending';

-- Index for checking if a scan has pending work
CREATE INDEX idx_crawl_queue_scan_status
    ON crawl_queue(scan_id, status);

-- RLS Policies (crawl_queue is accessed via service role, but add policies for safety)
ALTER TABLE crawl_queue ENABLE ROW LEVEL SECURITY;

-- Users can see queue entries for their own scans
CREATE POLICY "Users can view own scan queue"
    ON crawl_queue FOR SELECT
    USING (
        scan_id IN (
            SELECT id FROM scans WHERE user_id = auth.uid()
        )
    );

-- Only service role can insert/update/delete queue entries
-- (No additional policies needed - service role bypasses RLS)

COMMENT ON TABLE crawl_queue IS 'Database-backed BFS queue for chunked SharePoint crawls';
COMMENT ON COLUMN crawl_queue.graph_path IS 'Microsoft Graph API endpoint for this folder''s children';
COMMENT ON COLUMN crawl_queue.status IS 'pending=not started, processing=in progress, done=completed, error=failed';
