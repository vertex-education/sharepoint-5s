/**
 * execute-actions Edge Function
 * Executes approved suggestions against SharePoint via Graph API.
 * Processes actions sequentially with per-item error handling.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { graphFetch } from '../_shared/graph-client.ts';

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId } = await verifyAuth(req);
    const { suggestion_ids } = await req.json();

    if (!suggestion_ids || !Array.isArray(suggestion_ids) || suggestion_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: 'suggestion_ids array is required' }),
        { status: 400, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    const admin = getAdminClient();

    // Fetch all suggestions with their file data
    const { data: suggestions, error: fetchErr } = await admin
      .from('suggestions')
      .select('*, crawled_files(*)')
      .in('id', suggestion_ids);

    if (fetchErr) throw fetchErr;

    if (!suggestions || suggestions.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No suggestions found' }),
        { status: 404, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    // Verify all suggestions belong to user's scans
    const scanIds = [...new Set(suggestions.map(s => s.scan_id))];
    const { data: scans } = await admin
      .from('scans')
      .select('id')
      .in('id', scanIds)
      .eq('user_id', userId);

    const validScanIds = new Set(scans?.map(s => s.id) || []);
    const validSuggestions = suggestions.filter(s => validScanIds.has(s.scan_id));

    if (validSuggestions.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No valid suggestions found for this user' }),
        { status: 403, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    // Get the site_id from the scan to resolve drives
    const { data: scanData } = await admin
      .from('scans')
      .select('site_id, drive_id')
      .eq('id', validSuggestions[0].scan_id)
      .single();

    if (!scanData?.drive_id && !scanData?.site_id) {
      return new Response(
        JSON.stringify({ error: 'Drive/Site ID not found for scan' }),
        { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    // Build a map of drive name → drive ID by fetching all drives for the site
    const driveNameMap = new Map<string, string>();
    const fallbackDriveId = scanData.drive_id;

    if (scanData.site_id) {
      try {
        const drivesData = await graphFetch(userId, `/sites/${scanData.site_id}/drives`);
        for (const d of (drivesData.value || [])) {
          driveNameMap.set(d.name.toLowerCase(), d.id);
        }
      } catch (err) {
        console.warn('Could not fetch drives for site, using fallback driveId:', err.message);
      }
    }

    // Helper: resolve the driveId for a file based on its path
    function resolveDriveId(filePath: string): string {
      // Path format: /DriveName/folder/file.ext
      if (filePath && filePath.startsWith('/')) {
        const parts = filePath.split('/').filter(Boolean);
        if (parts.length > 0) {
          const driveName = parts[0].toLowerCase();
          const mapped = driveNameMap.get(driveName);
          if (mapped) return mapped;
        }
      }
      return fallbackDriveId;
    }

    // Execute each action sequentially
    const results: any[] = [];

    for (const suggestion of validSuggestions) {
      const file = suggestion.crawled_files;
      if (!file) {
        results.push({
          suggestion_id: suggestion.id,
          status: 'failed',
          error: 'Associated file not found',
        });
        continue;
      }

      let actionType: string;
      let payload: any = {};
      let graphResponse: any = null;
      let status = 'success';
      let errorMessage: string | null = null;

      try {
        const fileDriveId = resolveDriveId(file.path);

        switch (suggestion.category) {
          case 'delete': {
            actionType = 'delete';
            graphResponse = await graphFetch(
              userId,
              `/drives/${fileDriveId}/items/${file.graph_item_id}`,
              { method: 'DELETE' }
            );
            break;
          }

          case 'rename': {
            actionType = 'rename';
            if (!suggestion.suggested_value) {
              throw new Error('No suggested name provided');
            }
            payload = { name: suggestion.suggested_value };
            graphResponse = await graphFetch(
              userId,
              `/drives/${fileDriveId}/items/${file.graph_item_id}`,
              {
                method: 'PATCH',
                body: JSON.stringify(payload),
              }
            );
            break;
          }

          case 'archive': {
            // For archive, we'd move to an archive folder
            // This requires knowing the archive folder ID — for now, flag as needing manual setup
            actionType = 'move';
            status = 'failed';
            errorMessage = 'Archive folder not configured. Move files manually to your archive location.';
            break;
          }

          case 'structure': {
            // Structure changes are complex (folder creation, moves)
            // Flag for manual action
            actionType = 'create_folder';
            status = 'failed';
            errorMessage = 'Structure changes require manual review. Use the suggestion description as guidance.';
            break;
          }

          default:
            actionType = suggestion.category;
            status = 'failed';
            errorMessage = 'Unknown action type';
        }
      } catch (err) {
        status = 'failed';
        errorMessage = err.message;
      }

      // Record the action
      await admin.from('executed_actions').insert({
        suggestion_id: suggestion.id,
        scan_id: suggestion.scan_id,
        user_id: userId,
        action_type: actionType!,
        target_item_id: file.graph_item_id,
        payload,
        status,
        graph_response: graphResponse,
        error_message: errorMessage,
      });

      // Update suggestion decision — mark as 'executed' on success so the UI knows it's done
      await admin.from('suggestions').update({
        user_decision: status === 'success' ? 'executed' : 'approved',
        decided_at: new Date().toISOString(),
      }).eq('id', suggestion.id);

      results.push({
        suggestion_id: suggestion.id,
        status,
        error: errorMessage,
      });

      // Small delay between actions to avoid throttling
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return new Response(
      JSON.stringify({ results }),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('execute-actions error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
