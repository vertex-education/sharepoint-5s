/**
 * crawl-sharepoint Edge Function
 * Accepts a SharePoint URL, resolves the site/drive, and recursively crawls all files.
 * Returns immediately with a scan_id; crawling continues in the background.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { graphFetch, graphFetchAllPages, parseSharePointUrl } from '../_shared/graph-client.ts';

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId } = await verifyAuth(req);
    const { sharepoint_url } = await req.json();

    if (!sharepoint_url) {
      return new Response(
        JSON.stringify({ error: 'sharepoint_url is required' }),
        { status: 400, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    // Parse the URL
    const { hostname, sitePath, libraryPath } = parseSharePointUrl(sharepoint_url);

    const admin = getAdminClient();

    // Create a scan record
    const { data: scan, error: scanError } = await admin
      .from('scans')
      .insert({
        user_id: userId,
        sharepoint_url,
        status: 'crawling',
      })
      .select()
      .single();

    if (scanError) throw scanError;

    // Start crawling in the background
    const crawlPromise = performCrawl(admin, userId, scan.id, hostname, sitePath, libraryPath);

    // Use EdgeRuntime.waitUntil if available (Supabase Edge Functions support)
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(crawlPromise);
    } else {
      // Fallback: fire and forget (the function might time out for large libraries)
      crawlPromise.catch(err => console.error('Background crawl error:', err));
    }

    return new Response(
      JSON.stringify({ scan_id: scan.id }),
      { status: 200, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('crawl-sharepoint error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Perform the recursive crawl of a SharePoint document library.
 */
async function performCrawl(
  admin: any,
  userId: string,
  scanId: string,
  hostname: string,
  sitePath: string,
  libraryPath: string | null
) {
  try {
    // 1. Resolve the site ID
    const site = await graphFetch(userId, `/sites/${hostname}:${sitePath}`);
    const siteId = site.id;

    await admin.from('scans').update({ site_id: siteId }).eq('id', scanId);

    // 2. Get drives (document libraries) for the site
    const drivesData = await graphFetch(userId, `/sites/${siteId}/drives`);
    const drives = drivesData.value || [];

    if (drives.length === 0) {
      throw new Error('No document libraries found on this site.');
    }

    // Determine which drives to crawl
    let targetDrives: any[] = [];

    if (libraryPath) {
      // Specific library requested — find the matching drive
      const decodedLibrary = decodeURIComponent(libraryPath).replace(/^\//, '');
      const match = drives.find((d: any) =>
        d.name.toLowerCase() === decodedLibrary.split('/')[0].toLowerCase()
      );
      targetDrives = [match || drives[0]];
    } else {
      // No specific library — crawl ALL drives on the site
      targetDrives = drives;
    }

    console.log(`Crawling ${targetDrives.length} drive(s):`, targetDrives.map((d: any) => d.name).join(', '));

    // Store the first drive ID for reference
    await admin.from('scans').update({ drive_id: targetDrives[0].id }).eq('id', scanId);

    // 3. BFS crawl of all target drives
    let totalFiles = 0;
    let totalFolders = 0;
    let totalSize = 0;
    let processedFolders = 0;

    // Queue of folder paths to crawl
    interface QueueItem {
      driveId: string;
      graphPath: string;
      parentItemId: string | null;
      depth: number;
      folderPath: string;
    }

    const queue: QueueItem[] = [];

    // Seed the queue with root of each target drive
    for (const drive of targetDrives) {
      let startPath = `/drives/${drive.id}/root`;

      // If a specific subfolder was requested (only for single-drive mode)
      if (libraryPath && targetDrives.length === 1) {
        const parts = decodeURIComponent(libraryPath).split('/').filter(Boolean);
        if (parts.length > 1) {
          const subPath = parts.slice(1).join('/');
          startPath = `/drives/${drive.id}/root:/${subPath}:`;
        }
      }

      queue.push({
        driveId: drive.id,
        graphPath: `${startPath}/children`,
        parentItemId: null,
        depth: 0,
        folderPath: `/${drive.name}/`,
      });
    }

    // Estimate total folders for progress
    let estimatedTotalFolders = targetDrives.length;

    while (queue.length > 0) {
      const current = queue.shift()!;

      try {
        for await (const items of graphFetchAllPages(userId, current.graphPath)) {
          const fileRows: any[] = [];

          for (const item of items) {
            const isFolder = !!item.folder;
            const itemPath = `${current.folderPath}${item.name}${isFolder ? '/' : ''}`;

            fileRows.push({
              scan_id: scanId,
              graph_item_id: item.id,
              name: item.name,
              file_extension: isFolder ? null : getExtension(item.name),
              mime_type: item.file?.mimeType || null,
              size_bytes: item.size || 0,
              is_folder: isFolder,
              path: itemPath,
              depth: current.depth + (isFolder ? 1 : 0),
              created_at_sp: item.createdDateTime,
              modified_at_sp: item.lastModifiedDateTime,
              created_by: item.createdBy?.user?.displayName || null,
              modified_by: item.lastModifiedBy?.user?.displayName || null,
              parent_item_id: current.parentItemId,
              web_url: item.webUrl || null,
              sha256_hash: item.file?.hashes?.sha256Hash || null,
            });

            if (isFolder) {
              totalFolders++;
              estimatedTotalFolders++;
              queue.push({
                driveId: current.driveId,
                graphPath: `/drives/${current.driveId}/items/${item.id}/children`,
                parentItemId: item.id,
                depth: current.depth + 1,
                folderPath: itemPath,
              });
            } else {
              totalFiles++;
              totalSize += item.size || 0;
            }
          }

          // Batch insert files
          if (fileRows.length > 0) {
            const { error: insertError } = await admin
              .from('crawled_files')
              .insert(fileRows);

            if (insertError) {
              console.error('Batch insert error:', insertError);
            }
          }
        }
      } catch (folderErr) {
        console.error(`Error crawling ${current.folderPath}:`, folderErr);
        // Continue with other folders
      }

      processedFolders++;

      // Update progress every 5 folders
      if (processedFolders % 5 === 0 || queue.length === 0) {
        const progress = Math.min(
          Math.round((processedFolders / estimatedTotalFolders) * 100),
          99
        );

        await admin.from('scans').update({
          crawl_progress: progress,
          total_files: totalFiles,
          total_folders: totalFolders,
          total_size_bytes: totalSize,
          updated_at: new Date().toISOString(),
        }).eq('id', scanId);
      }
    }

    // Crawl complete
    await admin.from('scans').update({
      status: 'crawled',
      crawl_progress: 100,
      total_files: totalFiles,
      total_folders: totalFolders,
      total_size_bytes: totalSize,
      updated_at: new Date().toISOString(),
    }).eq('id', scanId);

  } catch (err) {
    console.error('Crawl failed:', err);
    await admin.from('scans').update({
      status: 'error',
      error_message: err.message,
      updated_at: new Date().toISOString(),
    }).eq('id', scanId);
  }
}

function getExtension(filename: string): string | null {
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  return parts.pop()!.toLowerCase();
}
