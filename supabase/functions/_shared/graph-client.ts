/**
 * Microsoft Graph API Client
 * Handles token refresh, pagination, and throttle handling.
 */

import { getAdminClient } from './supabase-admin.ts';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com';

// Azure AD App credentials — set these as Supabase secrets
const AZURE_CLIENT_ID = Deno.env.get('AZURE_CLIENT_ID')!;
const AZURE_CLIENT_SECRET = Deno.env.get('AZURE_CLIENT_SECRET')!;
const AZURE_TENANT_ID = Deno.env.get('AZURE_TENANT_ID')!;

export interface GraphToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * Get a valid Microsoft Graph API access token for a user.
 * Refreshes the token if it's expired or about to expire (5-min buffer).
 */
export async function getGraphToken(userId: string): Promise<string> {
  const admin = getAdminClient();

  // Read stored token
  const { data: tokenRow, error } = await admin
    .from('provider_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !tokenRow) {
    throw new Error('No Graph API token found. Please sign in again.');
  }

  const expiresAt = new Date(tokenRow.expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000; // 5 minutes

  // Token still valid
  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return tokenRow.access_token;
  }

  // Token expired or about to expire — refresh it
  if (!tokenRow.refresh_token) {
    throw new Error('No refresh token available. Please sign in again.');
  }

  const refreshed = await refreshAccessToken(tokenRow.refresh_token);

  // Update stored token
  const { error: updateError } = await admin
    .from('provider_tokens')
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokenRow.refresh_token,
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (updateError) {
    console.error('Failed to update token:', updateError);
  }

  return refreshed.access_token;
}

/**
 * Refresh a Microsoft access token using the refresh token.
 */
async function refreshAccessToken(refreshToken: string) {
  const response = await fetch(
    `${TOKEN_ENDPOINT}/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'offline_access Files.ReadWrite.All Sites.Read.All',
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error('Token refresh failed:', err);
    throw new Error('Failed to refresh Microsoft token. Please sign in again.');
  }

  return response.json();
}

/**
 * Make a Graph API request with automatic token refresh and throttle handling.
 */
export async function graphFetch(
  userId: string,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = await getGraphToken(userId);

  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle throttling (429)
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
    console.log(`Graph API throttled. Retrying after ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return graphFetch(userId, path, options); // Retry
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Graph API error ${response.status}: ${errBody}`);
  }

  return response.json();
}

/**
 * Fetch all pages of a paginated Graph API response.
 * Yields each page's `value` array.
 */
export async function* graphFetchAllPages(
  userId: string,
  path: string
): AsyncGenerator<any[]> {
  let url: string | null = path;

  while (url) {
    const data = await graphFetch(userId, url);
    if (data.value) {
      yield data.value;
    }
    url = data['@odata.nextLink'] || null;
  }
}

/**
 * Parse a SharePoint URL to extract hostname, site path, and optional library/folder path.
 * Supports URLs like:
 *   https://contoso.sharepoint.com/sites/MySite
 *   https://contoso.sharepoint.com/sites/MySite/Shared Documents/SubFolder
 *   https://contoso.sharepoint.com/sites/MySite/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FMySite%2FShared%20Documents%2FFolder
 */
export function parseSharePointUrl(url: string): {
  hostname: string;
  sitePath: string;
  libraryPath: string | null;
} {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Check for ?id= query parameter (SharePoint view URLs)
  // e.g. ?id=%2Fsites%2FSiteName%2FShared%20Documents%2FFolder
  const idParam = parsed.searchParams.get('id');
  let effectivePath: string;

  if (idParam) {
    // The id param contains the real path, e.g. /sites/SiteName/Shared Documents/Folder
    effectivePath = idParam;
  } else {
    effectivePath = decodeURIComponent(parsed.pathname);
  }

  // Strip trailing /Forms/AllItems.aspx or similar view pages
  effectivePath = effectivePath.replace(/\/Forms\/AllItems\.aspx$/i, '');
  effectivePath = effectivePath.replace(/\/Forms\/[^/]+\.aspx$/i, '');

  const pathParts = effectivePath.split('/').filter(Boolean);

  // Find the site path (e.g., /sites/MySite or /teams/MyTeam)
  let siteIndex = -1;
  for (let i = 0; i < pathParts.length; i++) {
    if (pathParts[i] === 'sites' || pathParts[i] === 'teams') {
      siteIndex = i;
      break;
    }
  }

  if (siteIndex === -1 || siteIndex + 1 >= pathParts.length) {
    throw new Error('Could not parse SharePoint site from URL. Expected format: https://tenant.sharepoint.com/sites/SiteName');
  }

  const sitePath = `/${pathParts[siteIndex]}/${pathParts[siteIndex + 1]}`;

  // Everything after the site path could be a library/folder path
  const remainingParts = pathParts.slice(siteIndex + 2);
  const libraryPath = remainingParts.length > 0 ? `/${remainingParts.join('/')}` : null;

  console.log('Parsed SharePoint URL:', { hostname, sitePath, libraryPath, source: idParam ? 'id param' : 'pathname' });

  return { hostname, sitePath, libraryPath };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
