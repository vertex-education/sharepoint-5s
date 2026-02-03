/**
 * Authentication Module
 * Handles Microsoft OAuth via Supabase Auth, token storage, and session management.
 */

import { supabase } from './lib/supabase-client.js';

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
  console.log('[Auth] initAuth() starting...');

  let resolved = false;

  // Use onAuthStateChange as the sole session source (avoids getSession() deadlock)
  return new Promise((resolve) => {
    supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[Auth] Event:', event, 'has session:', !!session);

      currentSession = session;
      currentUser = session?.user ?? null;

      // On first load with a session, refresh the JWT to ensure it's valid
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && session && !resolved) {
        try {
          console.log('[Auth] Refreshing session to get fresh JWT...');
          const { data, error } = await supabase.auth.refreshSession();
          if (error || !data.session) {
            console.warn('[Auth] Session refresh failed, signing out:', error?.message);
            await supabase.auth.signOut();
            currentSession = null;
            currentUser = null;
          } else {
            currentSession = data.session;
            currentUser = data.session.user;
            console.log('[Auth] Session refreshed, user:', currentUser?.email);
          }
        } catch (err) {
          console.error('[Auth] Session refresh error:', err);
        }
      }

      // After sign-in, store provider tokens server-side
      if (event === 'SIGNED_IN' && session?.provider_token) {
        await storeProviderToken(session);
      }

      notifyListeners();

      // Resolve on the first auth event (either INITIAL_SESSION or SIGNED_IN)
      if (!resolved) {
        resolved = true;
        console.log('[Auth] initAuth() resolved, user:', currentUser?.email || 'none');
        resolve(currentUser);
      }
    });
  });
}

/**
 * Sign in with Microsoft OAuth.
 * Redirects to Microsoft login page.
 * @param {string} [redirectPath] - Path to redirect after auth (e.g., '/dashboard.html')
 */
export async function signIn(redirectPath) {
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
    const { error } = await supabase.functions.invoke('store-token', {
      body: {
        provider_token: session.provider_token,
        provider_refresh_token: session.provider_refresh_token,
        expires_in: 3600,
      },
    });

    if (error) {
      console.error('Failed to store provider token:', error);
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
