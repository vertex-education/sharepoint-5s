/**
 * Browse Folder Edge Function
 * Returns contents of a SharePoint folder for file browser UI
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/auth.ts';
import { graphFetch, parseSharePointUrl } from '../_shared/graph-client.ts';

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate user
    const { userId } = await verifyAuth(req);

    const { url, path } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Parse the SharePoint URL
    const parsed = parseSharePointUrl(url);

    // Get site info
    const siteInfo = await getSiteAndDrive(userId, parsed.hostname, parsed.sitePath, parsed.libraryPath);
    if (!siteInfo) {
      return new Response(JSON.stringify({ error: 'Could not access SharePoint site' }), {
        status: 400,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Get folder contents
    const folderPath = path || '';
    const contents = await getFolderContents(userId, siteInfo.driveId, folderPath);

    return new Response(JSON.stringify({
      site: {
        name: siteInfo.siteName,
        drive: siteInfo.driveName,
        driveId: siteInfo.driveId,
      },
      currentPath: folderPath,
      items: contents,
    }), {
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error browsing folder:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});

async function getSiteAndDrive(userId: string, hostname: string, sitePath: string, libraryHint?: string | null) {
  try {
    // Get site
    const siteResponse = await graphFetch(userId, `/sites/${hostname}:${sitePath}`);
    const siteId = siteResponse.id;
    const siteName = siteResponse.displayName;

    // Get drives
    const drivesResponse = await graphFetch(userId, `/sites/${siteId}/drives`);
    const drives = drivesResponse.value;

    // Find the right drive
    let drive = drives.find((d: any) =>
      d.name === libraryHint ||
      d.name === 'Documents' ||
      d.name === 'Shared Documents'
    ) || drives[0];

    return {
      siteId,
      siteName,
      driveId: drive.id,
      driveName: drive.name,
    };
  } catch (error) {
    console.error('Error getting site info:', error);
    return null;
  }
}

async function getFolderContents(userId: string, driveId: string, folderPath: string) {
  try {
    let endpoint: string;
    if (folderPath) {
      // Encode each path segment separately, not the whole path
      const encodedPath = folderPath.split('/').map(encodeURIComponent).join('/');
      endpoint = `/drives/${driveId}/root:/${encodedPath}:/children?$select=id,name,size,folder,file,webUrl,lastModifiedDateTime&$orderby=name&$top=200`;
    } else {
      endpoint = `/drives/${driveId}/root/children?$select=id,name,size,folder,file,webUrl,lastModifiedDateTime&$orderby=name&$top=200`;
    }

    console.log('getFolderContents endpoint:', endpoint);
    const response = await graphFetch(userId, endpoint);

    return response.value.map((item: any) => ({
      id: item.id,
      name: item.name,
      isFolder: !!item.folder,
      size: item.size || 0,
      childCount: item.folder?.childCount || 0,
      webUrl: item.webUrl,
      lastModified: item.lastModifiedDateTime,
      mimeType: item.file?.mimeType,
    }));
  } catch (error) {
    console.error('Error getting folder contents:', error);
    throw error;
  }
}
