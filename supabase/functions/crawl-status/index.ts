/**
 * crawl-status Edge Function
 * Returns the current status and progress of a crawl.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId } = await verifyAuth(req);

    // Accept scan_id from body (POST) or query params (GET)
    let scanId: string | null = null;
    if (req.method === 'POST') {
      const body = await req.json();
      scanId = body.scan_id;
    } else {
      const url = new URL(req.url);
      scanId = url.searchParams.get('scan_id');
    }

    if (!scanId) {
      return new Response(
        JSON.stringify({ error: 'scan_id is required' }),
        { status: 400, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    const admin = getAdminClient();
    const { data: scan, error } = await admin
      .from('scans')
      .select('status, crawl_progress, total_files, total_folders, total_size_bytes, error_message')
      .eq('id', scanId)
      .eq('user_id', userId)
      .single();

    if (error || !scan) {
      return new Response(
        JSON.stringify({ error: 'Scan not found' }),
        { status: 404, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify(scan),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('crawl-status error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
