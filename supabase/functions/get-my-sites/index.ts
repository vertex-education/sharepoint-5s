/**
 * get-my-sites Edge Function
 * Fetches the user's SharePoint sites from Microsoft Graph
 * and enriches them with scan/action data from our database.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { graphFetchAllPages } from '../_shared/graph-client.ts';

interface SiteInfo {
  graph_site_id: string;
  name: string;
  display_name: string;
  web_url: string;
  description: string | null;
  has_scans: boolean;
  scan_count: number;
  latest_scan: {
    id: string;
    status: string;
    created_at: string;
    total_files: number;
    total_size_bytes: number;
  } | null;
  total_actions: number;
  actions_breakdown: {
    deletes: number;
    renames: number;
    moves: number;
  };
}

interface MySitesResponse {
  sites: SiteInfo[];
  summary: {
    total_sites: number;
    scanned_sites: number;
    total_actions: number;
    total_files_analyzed: number;
  };
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId } = await verifyAuth(req);
    const admin = getAdminClient();

    // 1. Fetch user's sites from Microsoft Graph
    // Uses Sites.Read.All permission - returns sites the user can access
    const sites: any[] = [];

    try {
      for await (const page of graphFetchAllPages(userId, '/sites?search=*')) {
        sites.push(...page);
      }
    } catch (graphErr) {
      console.error('Graph API error fetching sites:', graphErr);
      // Continue with empty sites array - user may not have Graph token
    }

    // 2. Get all scans for this user
    const { data: userScans, error: scansErr } = await admin
      .from('scans')
      .select('id, site_id, sharepoint_url, status, created_at, total_files, total_size_bytes')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (scansErr) {
      console.error('Error fetching scans:', scansErr);
      throw new Error('Failed to fetch scan history');
    }

    // 3. Get action stats per scan
    const scanIds = userScans?.map(s => s.id) || [];
    const actionStats: Record<string, { deletes: number; renames: number; moves: number; total: number }> = {};

    if (scanIds.length > 0) {
      const { data: actions } = await admin
        .from('executed_actions')
        .select('scan_id, action_type, status')
        .in('scan_id', scanIds)
        .eq('status', 'success');

      // Aggregate by scan_id
      for (const action of (actions || [])) {
        if (!actionStats[action.scan_id]) {
          actionStats[action.scan_id] = { deletes: 0, renames: 0, moves: 0, total: 0 };
        }
        actionStats[action.scan_id].total++;
        if (action.action_type === 'delete') actionStats[action.scan_id].deletes++;
        if (action.action_type === 'rename') actionStats[action.scan_id].renames++;
        if (action.action_type === 'move') actionStats[action.scan_id].moves++;
      }
    }

    // 4. Build a map of site_id -> scans
    const scansBySiteId = new Map<string, typeof userScans>();
    for (const scan of (userScans || [])) {
      const siteId = scan.site_id;
      if (siteId) {
        if (!scansBySiteId.has(siteId)) {
          scansBySiteId.set(siteId, []);
        }
        scansBySiteId.get(siteId)!.push(scan);
      }
    }

    // 5. Enrich Graph sites with our data
    const enrichedSites: SiteInfo[] = sites.map(site => {
      const siteScans = scansBySiteId.get(site.id) || [];
      const latestScan = siteScans[0]; // Already sorted by created_at desc

      // Aggregate actions across all scans for this site
      let totalActions = 0;
      let deletes = 0, renames = 0, moves = 0;

      for (const scan of siteScans) {
        const stats = actionStats[scan.id];
        if (stats) {
          totalActions += stats.total;
          deletes += stats.deletes;
          renames += stats.renames;
          moves += stats.moves;
        }
      }

      return {
        graph_site_id: site.id,
        name: site.name || '',
        display_name: site.displayName || site.name || 'Unnamed Site',
        web_url: site.webUrl || '',
        description: site.description || null,
        has_scans: siteScans.length > 0,
        scan_count: siteScans.length,
        latest_scan: latestScan ? {
          id: latestScan.id,
          status: latestScan.status,
          created_at: latestScan.created_at,
          total_files: latestScan.total_files || 0,
          total_size_bytes: latestScan.total_size_bytes || 0,
        } : null,
        total_actions: totalActions,
        actions_breakdown: { deletes, renames, moves },
      };
    });

    // 6. Add any scanned sites that aren't in the Graph response
    // (e.g., sites the user no longer has access to)
    const graphSiteIds = new Set(sites.map(s => s.id));
    for (const [siteId, scans] of scansBySiteId.entries()) {
      if (!graphSiteIds.has(siteId) && scans.length > 0) {
        const latestScan = scans[0];
        let totalActions = 0;
        let deletes = 0, renames = 0, moves = 0;

        for (const scan of scans) {
          const stats = actionStats[scan.id];
          if (stats) {
            totalActions += stats.total;
            deletes += stats.deletes;
            renames += stats.renames;
            moves += stats.moves;
          }
        }

        // Extract site name from URL
        const urlMatch = latestScan.sharepoint_url?.match(/\/sites\/([^/]+)/);
        const siteName = urlMatch ? urlMatch[1] : 'Unknown Site';

        enrichedSites.push({
          graph_site_id: siteId,
          name: siteName,
          display_name: siteName,
          web_url: latestScan.sharepoint_url || '',
          description: null,
          has_scans: true,
          scan_count: scans.length,
          latest_scan: {
            id: latestScan.id,
            status: latestScan.status,
            created_at: latestScan.created_at,
            total_files: latestScan.total_files || 0,
            total_size_bytes: latestScan.total_size_bytes || 0,
          },
          total_actions: totalActions,
          actions_breakdown: { deletes, renames, moves },
        });
      }
    }

    // Sort: sites with scans first, then by name
    enrichedSites.sort((a, b) => {
      if (a.has_scans && !b.has_scans) return -1;
      if (!a.has_scans && b.has_scans) return 1;
      return a.display_name.localeCompare(b.display_name);
    });

    // Calculate summary
    const scannedSites = enrichedSites.filter(s => s.has_scans);
    const summary = {
      total_sites: enrichedSites.length,
      scanned_sites: scannedSites.length,
      total_actions: scannedSites.reduce((sum, s) => sum + s.total_actions, 0),
      total_files_analyzed: scannedSites.reduce((sum, s) => sum + (s.latest_scan?.total_files || 0), 0),
    };

    const response: MySitesResponse = { sites: enrichedSites, summary };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('get-my-sites error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
