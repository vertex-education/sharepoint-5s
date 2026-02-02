/**
 * Authentication Module
 * Handles Microsoft OAuth via Supabase Auth, token storage, and session management.
 */

import { supabase, EDGE_FUNCTION_BASE } from './lib/supabase-client.js';

/** Current user state */
let currentUser = null;
let currentSession = null;

/** Auth state change listeners */
const listeners = new Set();

/**
 * Subscribe to auth state changes.
 * @param {(user: object|null) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(callback) {
  listeners.add(callback);
  // Fire immediately with current state
  callback(currentUser);
  return () => listeners.delete(callback);
}

function notifyListeners() {
  listeners.forEach(fn => fn(currentUser));
}

/**
 * Initialize auth — listen for session changes.
 * Call this once on page load.
 */
export async function initAuth() {
  // Listen for auth state changes
  supabase.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;
    currentUser = session?.user ?? null;
    notifyListeners();

    // After sign-in, store provider tokens server-side
    if (event === 'SIGNED_IN' && session?.provider_token) {
      await storeProviderToken(session);
    }
  });

  // Get initial session
  const { data: { session } } = await supabase.auth.getSession();
  currentSession = session;
  currentUser = session?.user ?? null;
  notifyListeners();

  return currentUser;
}

/**
 * Sign in with Microsoft OAuth.
 * Redirects to Microsoft login page.
 * @param {string} [redirectPath] - Path to redirect after auth (e.g., '/dashboard.html')
 */
export async function signIn(redirectPath) {
  // Store pending URL if provided
  const pendingUrl = sessionStorage.getItem('pending_sharepoint_url');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'offline_access Files.ReadWrite.All Sites.Read.All',
      redirectTo: `${window.location.origin}/sharepoint-5s${redirectPath || '/callback.html'}`,
    },
  });

  if (error) {
    console.error('Sign-in error:', error);
    throw error;
  }
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('Sign-out error:', error);
    throw error;
  }
  currentUser = null;
  currentSession = null;
  notifyListeners();
}

/**
 * Get current user, or null if not signed in.
 */
export function getUser() {
  return currentUser;
}

/**
 * Get the current Supabase session (includes JWT for Edge Function calls).
 */
export function getSession() {
  return currentSession;
}

/**
 * Check if the user is currently signed in.
 */
export function isSignedIn() {
  return currentUser !== null;
}

/**
 * Store the Microsoft provider token server-side via Edge Function.
 * This is called automatically after sign-in.
 */
async function storeProviderToken(session) {
  try {
    const response = await fetch(`${EDGE_FUNCTION_BASE}/store-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        provider_token: session.provider_token,
        provider_refresh_token: session.provider_refresh_token,
        expires_in: 3600, // Microsoft tokens typically last 1 hour
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Failed to store provider token:', err);
    }
  } catch (err) {
    console.error('Error storing provider token:', err);
  }
}

/**
 * Get user display info for the header.
 */
export function getUserDisplay() {
  if (!currentUser) return null;
  return {
    email: currentUser.email,
    name: currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'User',
    initials: getInitials(currentUser.user_metadata?.full_name || currentUser.email || ''),
  };
}

function getInitials(name) {
  return name
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0].toUpperCase())
    .join('');
}
