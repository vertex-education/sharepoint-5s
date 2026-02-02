/**
 * CORS Headers for Edge Functions
 * Allows requests from the GitHub Pages frontend domain.
 *
 * IMPORTANT: Update ALLOWED_ORIGINS with your actual GitHub Pages URL.
 */

const ALLOWED_ORIGINS = [
  'http://localhost:3000',          // Local dev
  'http://127.0.0.1:3000',         // Local dev alt
  'https://vertex-education.github.io',  // GitHub Pages (org)
];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
    'Access-Control-Max-Age': '86400',
  };
}

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req),
    });
  }
  return null;
}
