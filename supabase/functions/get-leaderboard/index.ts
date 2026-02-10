/**
 * get-leaderboard Edge Function
 * Returns aggregated leaderboard statistics across all users.
 * Uses a SECURITY DEFINER database function to bypass RLS.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';

interface LeaderboardEntry {
  user_id: string;
  display_name: string;
  initials: string;
  total_actions: number;
  total_deletes: number;
  total_renames: number;
  total_moves: number;
  bytes_deleted: number;
  scans_count: number;
  last_action_at: string | null;
  rank: number;
}

interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  aggregates: {
    total_users: number;
    total_actions: number;
    total_bytes_cleaned: number;
  };
  current_user_id: string;
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Require authentication to access leaderboard
    const { userId } = await verifyAuth(req);

    const admin = getAdminClient();

    // Call the SECURITY DEFINER function to get cross-user stats
    const { data, error } = await admin.rpc('get_leaderboard_stats');

    if (error) {
      console.error('get_leaderboard_stats error:', error);
      throw new Error('Failed to fetch leaderboard data');
    }

    // Format the response with ranks and initials
    const leaderboard: LeaderboardEntry[] = (data || []).map((row: any, index: number) => ({
      user_id: row.user_id,
      display_name: row.display_name || 'Anonymous',
      initials: getInitials(row.display_name || 'Anonymous'),
      total_actions: Number(row.total_actions) || 0,
      total_deletes: Number(row.total_deletes) || 0,
      total_renames: Number(row.total_renames) || 0,
      total_moves: Number(row.total_moves) || 0,
      bytes_deleted: Number(row.bytes_deleted) || 0,
      scans_count: Number(row.scans_count) || 0,
      last_action_at: row.last_action_at,
      rank: index + 1,
    }));

    // Calculate aggregate stats
    const aggregates = {
      total_users: leaderboard.length,
      total_actions: leaderboard.reduce((sum, e) => sum + e.total_actions, 0),
      total_bytes_cleaned: leaderboard.reduce((sum, e) => sum + e.bytes_deleted, 0),
    };

    const response: LeaderboardResponse = {
      leaderboard,
      aggregates,
      current_user_id: userId,
    };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('get-leaderboard error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Extract initials from a name.
 */
function getInitials(name: string): string {
  return name
    .split(/[\s@._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0].toUpperCase())
    .join('');
}
