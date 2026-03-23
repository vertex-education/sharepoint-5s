-- Admin system for pre-scanning and management

-- Table to store admin emails
CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- Pre-scan queue for background scanning of large folders
CREATE TABLE IF NOT EXISTS prescan_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_url TEXT NOT NULL,
    folder_path TEXT,
    folder_name TEXT,
    size_bytes BIGINT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'scanning', 'complete', 'error')),
    scan_id UUID REFERENCES scans(id),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id)
);

-- Function to check if a user is an admin
CREATE OR REPLACE FUNCTION is_admin(user_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM admins WHERE email = user_email);
END;
$$;

-- Function to check if current user is admin
CREATE OR REPLACE FUNCTION current_user_is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    user_email TEXT;
BEGIN
    SELECT email INTO user_email FROM auth.users WHERE id = auth.uid();
    RETURN is_admin(user_email);
END;
$$;

-- RLS policies for admins table
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view admin list"
    ON admins FOR SELECT
    USING (current_user_is_admin());

CREATE POLICY "Admins can add admins"
    ON admins FOR INSERT
    WITH CHECK (current_user_is_admin());

CREATE POLICY "Admins can remove admins"
    ON admins FOR DELETE
    USING (current_user_is_admin());

-- RLS policies for prescan_queue
ALTER TABLE prescan_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view prescan queue"
    ON prescan_queue FOR SELECT
    USING (current_user_is_admin());

CREATE POLICY "Admins can add to prescan queue"
    ON prescan_queue FOR INSERT
    WITH CHECK (current_user_is_admin());

CREATE POLICY "Admins can update prescan queue"
    ON prescan_queue FOR UPDATE
    USING (current_user_is_admin());

-- Grant permissions
GRANT EXECUTE ON FUNCTION is_admin TO authenticated;
GRANT EXECUTE ON FUNCTION current_user_is_admin TO authenticated;
GRANT ALL ON admins TO authenticated;
GRANT ALL ON prescan_queue TO authenticated;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);
CREATE INDEX IF NOT EXISTS idx_prescan_queue_status ON prescan_queue(status);
