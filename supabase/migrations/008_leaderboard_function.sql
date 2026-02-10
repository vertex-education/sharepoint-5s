-- Leaderboard aggregation function
-- Uses SECURITY DEFINER to bypass RLS and aggregate data across all users

CREATE OR REPLACE FUNCTION get_leaderboard_stats()
RETURNS TABLE (
    user_id UUID,
    display_name TEXT,
    total_actions BIGINT,
    total_deletes BIGINT,
    total_renames BIGINT,
    total_moves BIGINT,
    bytes_deleted BIGINT,
    scans_count BIGINT,
    last_action_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ea.user_id,
        COALESCE(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))::TEXT AS display_name,
        COUNT(*) FILTER (WHERE ea.status = 'success') AS total_actions,
        COUNT(*) FILTER (WHERE ea.action_type = 'delete' AND ea.status = 'success') AS total_deletes,
        COUNT(*) FILTER (WHERE ea.action_type = 'rename' AND ea.status = 'success') AS total_renames,
        COUNT(*) FILTER (WHERE ea.action_type = 'move' AND ea.status = 'success') AS total_moves,
        COALESCE(SUM(cf.size_bytes) FILTER (WHERE ea.action_type = 'delete' AND ea.status = 'success'), 0)::BIGINT AS bytes_deleted,
        COUNT(DISTINCT ea.scan_id) AS scans_count,
        MAX(ea.executed_at) AS last_action_at
    FROM executed_actions ea
    JOIN auth.users u ON ea.user_id = u.id
    LEFT JOIN suggestions s ON ea.suggestion_id = s.id
    LEFT JOIN crawled_files cf ON s.file_id = cf.id
    GROUP BY ea.user_id, u.raw_user_meta_data, u.email
    ORDER BY COUNT(*) FILTER (WHERE ea.status = 'success') DESC
    LIMIT 50;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_leaderboard_stats TO authenticated;
