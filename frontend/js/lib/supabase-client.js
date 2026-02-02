/**
 * Supabase Client Initialization
 *
 * IMPORTANT: Replace these values with your actual Supabase project credentials.
 * These are public (anon) keys — safe to expose in frontend code.
 */

const SUPABASE_URL = 'https://xxwfbzwxeziclqxyvynr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4d2Ziend4ZXppY2xxeHl2eW5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNjQ4NzcsImV4cCI6MjA4NTY0MDg3N30.sxNzkGgFESlTVEKOTfXpdGgPyiJYr9aA8H0r5-ujWkk';

// Import from CDN (no build step)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

export const SUPABASE_KEY = SUPABASE_ANON_KEY;
export const EDGE_FUNCTION_BASE = `${SUPABASE_URL}/functions/v1`;
