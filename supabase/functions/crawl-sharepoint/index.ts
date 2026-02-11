/**
 * crawl-sharepoint Edge Function
 * Accepts a SharePoint URL, resolves the site/drive, seeds the crawl queue,
 * and processes the first batch of folders.
 *
 * Uses a database-backed queue for resumable, chunked crawling of large sites.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { graphFetch, graphFetchAllPages, parseSharePointUrl } from '../_shared/graph-client.ts';

// Number of folders to process per function invocation
const BATCH_SIZE = 50;

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

    // Initialize the crawl: resolve site, seed queue, and process first batch
    const initPromise = initializeCrawl(admin, userId, scan.id, hostname, sitePath, libraryPath);

    // Use EdgeRuntime.waitUntil to continue processing after response is sent
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(initPromise);
    } else {
      initPromise.catch(err => console.error('Crawl init error:', err));
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
 * Initialize the crawl: resolve the site, seed the queue with root folders,
 * and process the first batch of folders.
 */
async function initializeCrawl(
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
      const decodedLibrary = decodeURIComponent(libraryPath).replace(/^\//, '');
      const match = drives.find((d: any) =>
        d.name.toLowerCase() === decodedLibrary.split('/')[0].toLowerCase()
      );
      targetDrives = [match || drives[0]];
    } else {
      targetDrives = drives;
    }

    console.log(`Crawling ${targetDrives.length} drive(s):`, targetDrives.map((d: any) => d.name).join(', '));

    // Store the first drive ID for reference
    await admin.from('scans').update({ drive_id: targetDrives[0].id }).eq('id', scanId);

    // 3. Seed the crawl_queue with root folders
    const queueItems: any[] = [];

    for (const drive of targetDrives) {
      let startPath = `/drives/${drive.id}/root`;

      if (libraryPath && targetDrives.length === 1) {
        const parts = decodeURIComponent(libraryPath).split('/').filter(Boolean);
        if (parts.length > 1) {
          const subPath = parts.slice(1).join('/');
          startPath = `/drives/${drive.id}/root:/${subPath}:`;
        }
      }

      queueItems.push({
        scan_id: scanId,
        drive_id: drive.id,
        graph_path: `${startPath}/children`,
        parent_item_id: null,
        depth: 0,
        folder_path: `/${drive.name}/`,
        status: 'pending',
      });
    }

    // Insert initial queue items
    const { error: queueError } = await admin.from('crawl_queue').insert(queueItems);
    if (queueError) {
      console.error('Failed to seed crawl queue:', queueError);
      throw queueError;
    }

    console.log(`Seeded ${queueItems.length} root folder(s) to queue for scan ${scanId}`);

    // 4. Process the first batch
    await processBatch(admin, userId, scanId);

  } catch (err) {
    console.error('Crawl initialization failed:', err);
    await admin.from('scans').update({
      status: 'error',
      error_message: err.message,
      updated_at: new Date().toISOString(),
    }).eq('id', scanId);
  }
}

/**
 * Process a batch of folders from the crawl queue.
 * This is the core crawl logic that can be called from both crawl-sharepoint and continue-crawl.
 */
export async function processBatch(
  admin: any,
  userId: string,
  scanId: string,
  batchSize: number = BATCH_SIZE
): Promise<{ done: boolean; processed: number; remaining: number }> {
  // First, recover any items stuck in 'processing' status (from crashed/timed out runs)
  // Items older than 2 minutes in 'processing' are considered stuck
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await admin
    .from('crawl_queue')
    .update({ status: 'pending' })
    .eq('scan_id', scanId)
    .eq('status', 'processing')
    .lt('created_at', twoMinutesAgo);

  // Fetch pending queue items
  const { data: pendingItems, error: fetchError } = await admin
    .from('crawl_queue')
    .select('*')
    .eq('scan_id', scanId)
    .eq('status', 'pending')
    .order('depth', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    console.error('Failed to fetch queue items:', fetchError);
    throw fetchError;
  }

  if (!pendingItems || pendingItems.length === 0) {
    // No more pending items - crawl is complete
    await finalizeCrawl(admin, scanId);
    return { done: true, processed: 0, remaining: 0 };
  }

  console.log(`Processing batch of ${pendingItems.length} folders for scan ${scanId}`);

  // Mark items as processing
  const itemIds = pendingItems.map((item: any) => item.id);
  await admin
    .from('crawl_queue')
    .update({ status: 'processing' })
    .in('id', itemIds);

  let processedCount = 0;
  let totalFilesAdded = 0;
  let totalFoldersAdded = 0;
  let totalSizeAdded = 0;

  // Process each folder
  for (const queueItem of pendingItems) {
    try {
      const result = await processFolder(admin, userId, scanId, queueItem);
      totalFilesAdded += result.filesAdded;
      totalFoldersAdded += result.foldersAdded;
      totalSizeAdded += result.sizeAdded;

      // Mark as done
      await admin
        .from('crawl_queue')
        .update({ status: 'done', processed_at: new Date().toISOString() })
        .eq('id', queueItem.id);

      processedCount++;
    } catch (err) {
      console.error(`Error processing folder ${queueItem.folder_path}:`, err);
      await admin
        .from('crawl_queue')
        .update({
          status: 'error',
          error_message: err.message,
          processed_at: new Date().toISOString()
        })
        .eq('id', queueItem.id);
    }
  }

  // Update scan progress
  await updateScanProgress(admin, scanId, totalFilesAdded, totalFoldersAdded, totalSizeAdded);

  // Check if there are more pending items
  const { count: remainingCount } = await admin
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .eq('status', 'pending');

  const isDone = (remainingCount || 0) === 0;

  if (isDone) {
    await finalizeCrawl(admin, scanId);
  }

  return {
    done: isDone,
    processed: processedCount,
    remaining: remainingCount || 0
  };
}

/**
 * Process a single folder: fetch its children, insert files, and add subfolders to queue.
 */
async function processFolder(
  admin: any,
  userId: string,
  scanId: string,
  queueItem: any
): Promise<{ filesAdded: number; foldersAdded: number; sizeAdded: number }> {
  let filesAdded = 0;
  let foldersAdded = 0;
  let sizeAdded = 0;

  const newQueueItems: any[] = [];
  const fileRows: any[] = [];

  // Fetch all pages of children
  for await (const items of graphFetchAllPages(userId, queueItem.graph_path)) {
    for (const item of items) {
      const isFolder = !!item.folder;
      const itemPath = `${queueItem.folder_path}${item.name}${isFolder ? '/' : ''}`;

      fileRows.push({
        scan_id: scanId,
        graph_item_id: item.id,
        name: item.name,
        file_extension: isFolder ? null : getExtension(item.name),
        mime_type: item.file?.mimeType || null,
        size_bytes: item.size || 0,
        is_folder: isFolder,
        path: itemPath,
        depth: queueItem.depth + (isFolder ? 1 : 0),
        created_at_sp: item.createdDateTime,
        modified_at_sp: item.lastModifiedDateTime,
        created_by: item.createdBy?.user?.displayName || null,
        modified_by: item.lastModifiedBy?.user?.displayName || null,
        parent_item_id: queueItem.parent_item_id,
        web_url: item.webUrl || null,
        sha256_hash: item.file?.hashes?.sha256Hash || null,
      });

      if (isFolder) {
        foldersAdded++;
        newQueueItems.push({
          scan_id: scanId,
          drive_id: queueItem.drive_id,
          graph_path: `/drives/${queueItem.drive_id}/items/${item.id}/children`,
          parent_item_id: item.id,
          depth: queueItem.depth + 1,
          folder_path: itemPath,
          status: 'pending',
        });
      } else {
        filesAdded++;
        sizeAdded += item.size || 0;
      }
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

  // Add discovered subfolders to the queue
  if (newQueueItems.length > 0) {
    const { error: queueError } = await admin
      .from('crawl_queue')
      .insert(newQueueItems);

    if (queueError) {
      console.error('Queue insert error:', queueError);
    }
  }

  return { filesAdded, foldersAdded, sizeAdded };
}

/**
 * Update the scan's progress counters.
 */
async function updateScanProgress(
  admin: any,
  scanId: string,
  filesAdded: number,
  foldersAdded: number,
  sizeAdded: number
) {
  // Get current totals
  const { data: scan } = await admin
    .from('scans')
    .select('total_files, total_folders, total_size_bytes')
    .eq('id', scanId)
    .single();

  const currentFiles = scan?.total_files || 0;
  const currentFolders = scan?.total_folders || 0;
  const currentSize = scan?.total_size_bytes || 0;

  // Get queue stats for progress calculation
  const { count: doneCount } = await admin
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .eq('status', 'done');

  const { count: totalCount } = await admin
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('scan_id', scanId);

  const progress = totalCount ? Math.min(Math.round((doneCount || 0) / totalCount * 100), 99) : 0;

  await admin.from('scans').update({
    crawl_progress: progress,
    total_files: currentFiles + filesAdded,
    total_folders: currentFolders + foldersAdded,
    total_size_bytes: currentSize + sizeAdded,
    updated_at: new Date().toISOString(),
  }).eq('id', scanId);
}

/**
 * Mark the crawl as complete (or failed if all folders errored).
 */
async function finalizeCrawl(admin: any, scanId: string) {
  console.log(`Finalizing crawl for scan ${scanId}`);

  // Check if any queue items succeeded
  const { count: doneCount } = await admin
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .eq('status', 'done');

  const { count: errorCount } = await admin
    .from('crawl_queue')
    .select('*', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .eq('status', 'error');

  // If all folders failed, mark scan as error
  if ((doneCount || 0) === 0 && (errorCount || 0) > 0) {
    // Get the first error message
    const { data: errorItem } = await admin
      .from('crawl_queue')
      .select('error_message')
      .eq('scan_id', scanId)
      .eq('status', 'error')
      .limit(1)
      .single();

    console.error(`All ${errorCount} folders failed for scan ${scanId}`);
    await admin.from('scans').update({
      status: 'error',
      error_message: errorItem?.error_message || 'All folders failed to process',
      updated_at: new Date().toISOString(),
    }).eq('id', scanId);
    return;
  }

  // Get final totals from crawled_files
  const { data: fileCounts } = await admin
    .from('crawled_files')
    .select('is_folder, size_bytes')
    .eq('scan_id', scanId);

  let totalFiles = 0;
  let totalFolders = 0;
  let totalSize = 0;

  for (const file of (fileCounts || [])) {
    if (file.is_folder) {
      totalFolders++;
    } else {
      totalFiles++;
      totalSize += file.size_bytes || 0;
    }
  }

  console.log(`Crawl complete for scan ${scanId}: ${totalFiles} files, ${totalFolders} folders`);

  await admin.from('scans').update({
    status: 'crawled',
    crawl_progress: 100,
    total_files: totalFiles,
    total_folders: totalFolders,
    total_size_bytes: totalSize,
    updated_at: new Date().toISOString(),
  }).eq('id', scanId);
}

function getExtension(filename: string): string | null {
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  return parts.pop()!.toLowerCase();
}
