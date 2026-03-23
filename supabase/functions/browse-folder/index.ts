/**
 * Browse Folder Edge Function
 * Returns contents of a SharePoint folder for file browser UI
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getAuthenticatedUser, getAccessToken } from '../_shared/auth.ts';
import { createGraphClient, parseSharePointUrl } from '../_shared/graph-client.ts';

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCors();
  }

  try {
    // Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get access token
    const accessToken = await getAccessToken(user.id);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'No Microsoft token found' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { url, path } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const graph = createGraphClient(accessToken);

    // Parse the SharePoint URL
    const parsed = parseSharePointUrl(url);
    if (!parsed) {
      return new Response(JSON.stringify({ error: 'Invalid SharePoint URL' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get site info
    const siteInfo = await getSiteAndDrive(graph, parsed.hostname, parsed.sitePath, parsed.libraryPath);
    if (!siteInfo) {
      return new Response(JSON.stringify({ error: 'Could not access SharePoint site' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get folder contents
    const folderPath = path || '';
    const contents = await getFolderContents(graph, siteInfo.driveId, folderPath);

    return new Response(JSON.stringify({
      site: {
        name: siteInfo.siteName,
        drive: siteInfo.driveName,
        driveId: siteInfo.driveId,
      },
      currentPath: folderPath,
      items: contents,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error browsing folder:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function getSiteAndDrive(graph: any, hostname: string, sitePath: string, libraryHint?: string) {
  try {
    // Get site
    const siteResponse = await graph.api(`/sites/${hostname}:${sitePath}`).get();
    const siteId = siteResponse.id;
    const siteName = siteResponse.displayName;

    // Get drives
    const drivesResponse = await graph.api(`/sites/${siteId}/drives`).get();
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

async function getFolderContents(graph: any, driveId: string, folderPath: string) {
  try {
    const endpoint = folderPath
      ? `/drives/${driveId}/root:/${encodeURIComponent(folderPath)}:/children`
      : `/drives/${driveId}/root/children`;

    const response = await graph
      .api(endpoint)
      .select('id,name,size,folder,file,webUrl,lastModifiedDateTime')
      .orderby('name')
      .top(200)
      .get();

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
