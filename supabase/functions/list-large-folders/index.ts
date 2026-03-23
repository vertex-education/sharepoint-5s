/**
 * List Large Folders Edge Function
 * Finds folders larger than specified size in a SharePoint site
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getAuthenticatedUser, getAccessToken } from '../_shared/auth.ts';
import { createGraphClient } from '../_shared/graph-client.ts';

const MIN_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB default

// Folders to skip - these are typically Teams channel folders or system folders
const TEAMS_CHANNEL_PATTERNS = [
  /^General$/i,
  /^Private$/i,
  /^Shared$/i,
  /^Wiki$/i,
  /^_private$/i,
  /^Microsoft Teams Chat Files$/i,
  /^Notebooks$/i,
];

// System folders to always skip
const SYSTEM_FOLDERS = [
  'Forms',
  '_catalogs',
  '_cts',
  'SiteAssets',
  'SitePages',
  'Style Library',
];

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Get access token
    const accessToken = await getAccessToken(user.id);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'No Microsoft token found' }), {
        status: 401,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const { url, minSizeGB = 1 } = await req.json();
    const minSizeBytes = minSizeGB * 1024 * 1024 * 1024;

    // Parse SharePoint URL
    const parsedUrl = parseSharePointUrl(url);
    if (!parsedUrl) {
      return new Response(JSON.stringify({ error: 'Invalid SharePoint URL' }), {
        status: 400,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const graph = createGraphClient(accessToken);

    // Get site and drive info
    const siteInfo = await getSiteInfo(graph, parsedUrl);
    if (!siteInfo) {
      return new Response(JSON.stringify({ error: 'Could not access SharePoint site' }), {
        status: 400,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Find large folders (exclude Teams channel folders if Teams site)
    const folders = await findLargeFolders(graph, siteInfo.driveId, minSizeBytes, siteInfo.isTeamsSite);

    return new Response(JSON.stringify({
      folders,
      siteInfo: {
        siteName: siteInfo.siteName,
        driveName: siteInfo.driveName,
        isTeamsSite: siteInfo.isTeamsSite,
      }
    }), {
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error listing large folders:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});

function parseSharePointUrl(url: string) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    if (!hostname.includes('sharepoint.com')) {
      return null;
    }

    // Extract site path
    const pathMatch = urlObj.pathname.match(/\/sites\/([^\/]+)/i);
    const sitePath = pathMatch ? `/sites/${pathMatch[1]}` : null;

    // Extract library name if present
    const libMatch = urlObj.pathname.match(/\/([^\/]+)\/Forms\/AllItems\.aspx/i) ||
                     urlObj.pathname.match(/\/Shared%20Documents/i) ||
                     urlObj.pathname.match(/\/([^\/]+)(?:\/|$)/);

    return {
      hostname,
      sitePath,
      libraryHint: libMatch ? decodeURIComponent(libMatch[1]) : null,
    };
  } catch {
    return null;
  }
}

async function getSiteInfo(graph: any, parsed: any) {
  try {
    // Get site
    const siteResponse = await graph.api(`/sites/${parsed.hostname}:${parsed.sitePath}`).get();
    const siteId = siteResponse.id;
    const siteName = siteResponse.displayName;

    // Check if this is a Teams site (connected to a Microsoft 365 Group)
    const isTeamsSite = parsed.sitePath?.toLowerCase().includes('/teams/') ||
      siteResponse.webTemplate === 'GROUP' ||
      siteResponse.root?.webTemplate === 'GROUP#0';

    // Get drives
    const drivesResponse = await graph.api(`/sites/${siteId}/drives`).get();
    const drives = drivesResponse.value;

    // Find the right drive
    let drive = drives.find((d: any) =>
      d.name === parsed.libraryHint ||
      d.name === 'Documents' ||
      d.name === 'Shared Documents'
    ) || drives[0];

    return {
      siteId,
      siteName,
      driveId: drive.id,
      driveName: drive.name,
      isTeamsSite,
    };
  } catch (error) {
    console.error('Error getting site info:', error);
    return null;
  }
}

async function findLargeFolders(graph: any, driveId: string, minSizeBytes: number, isTeamsSite: boolean = false) {
  const largeFolders: any[] = [];

  // Helper to check if a folder should be skipped
  const shouldSkipFolder = (name: string, isRootLevel: boolean): boolean => {
    // Always skip system folders
    if (SYSTEM_FOLDERS.includes(name)) {
      return true;
    }

    // For Teams sites, skip root-level channel folders
    if (isTeamsSite && isRootLevel) {
      if (TEAMS_CHANNEL_PATTERNS.some(pattern => pattern.test(name))) {
        console.log(`Skipping Teams channel folder: ${name}`);
        return true;
      }
    }

    return false;
  };

  // Get root children
  const rootResponse = await graph
    .api(`/drives/${driveId}/root/children`)
    .select('id,name,size,folder,parentReference')
    .top(100)
    .get();

  // Check each folder
  for (const item of rootResponse.value) {
    if (item.folder) {
      // Skip Teams channel folders and system folders
      if (shouldSkipFolder(item.name, true)) {
        continue;
      }

      const folderSize = await getFolderSize(graph, driveId, item.id);
      if (folderSize >= minSizeBytes) {
        largeFolders.push({
          id: item.id,
          name: item.name,
          path: `/${item.name}`,
          size: folderSize,
        });
      }

      // Also check immediate subfolders
      try {
        const subResponse = await graph
          .api(`/drives/${driveId}/items/${item.id}/children`)
          .select('id,name,size,folder,parentReference')
          .top(50)
          .get();

        for (const subItem of subResponse.value) {
          if (subItem.folder) {
            // Skip system folders at any level
            if (shouldSkipFolder(subItem.name, false)) {
              continue;
            }

            const subSize = await getFolderSize(graph, driveId, subItem.id);
            if (subSize >= minSizeBytes) {
              largeFolders.push({
                id: subItem.id,
                name: subItem.name,
                path: `/${item.name}/${subItem.name}`,
                size: subSize,
              });
            }
          }
        }
      } catch (err) {
        console.error(`Error checking subfolders of ${item.name}:`, err);
      }
    }
  }

  // Sort by size descending
  largeFolders.sort((a, b) => b.size - a.size);

  return largeFolders;
}

async function getFolderSize(graph: any, driveId: string, folderId: string): Promise<number> {
  try {
    // Get folder details which includes size
    const folderInfo = await graph
      .api(`/drives/${driveId}/items/${folderId}`)
      .select('size,folder')
      .get();

    // The size property on a folder represents the total size of contents
    return folderInfo.size || 0;
  } catch (error) {
    console.error('Error getting folder size:', error);
    return 0;
  }
}
