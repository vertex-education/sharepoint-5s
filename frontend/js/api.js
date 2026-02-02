/**
 * API Module
 * Wrapper for all Supabase Edge Function calls.
 */

import { supabase } from './lib/supabase-client.js';

/**
 * Make an authenticated request to a Supabase Edge Function.
 * Uses supabase.functions.invoke() which handles auth headers automatically.
 */
async function callEdgeFunction(name, { body = null } = {}) {
  const { data, error } = await supabase.functions.invoke(name, {
    body: body,
  });

  if (error) {
    throw new Error(error.message || `Edge Function "${name}" failed`);
  }

  return data;
}

/**
 * Start a SharePoint crawl.
 * @param {string} sharepointUrl - The SharePoint URL to crawl
 * @returns {{ scan_id: string }}
 */
export async function startCrawl(sharepointUrl) {
  return callEdgeFunction('crawl-sharepoint', {
    body: { sharepoint_url: sharepointUrl },
  });
}

/**
 * Get the status of a crawl.
 * @param {string} scanId
 * @returns {{ status, crawl_progress, total_files, total_folders, total_size_bytes, error_message }}
 */
export async function getCrawlStatus(scanId) {
  return callEdgeFunction('crawl-status', {
    body: { scan_id: scanId },
  });
}

/**
 * Start AI analysis on a completed crawl.
 * @param {string} scanId
 * @returns {{ suggestion_count, categories }}
 */
export async function startAnalysis(scanId) {
  return callEdgeFunction('analyze', {
    body: { scan_id: scanId },
  });
}

/**
 * Execute approved suggestions against SharePoint.
 * @param {string[]} suggestionIds - Array of approved suggestion UUIDs
 * @returns {{ results: Array<{ suggestion_id, status, error? }> }}
 */
export async function executeActions(suggestionIds) {
  return callEdgeFunction('execute-actions', {
    body: { suggestion_ids: suggestionIds },
  });
}

/**
 * Fetch suggestions for a scan directly from the Supabase table (via RLS).
 * @param {string} scanId
 * @param {object} [filters] - Optional filters
 * @returns {Array} suggestions
 */
export async function getSuggestions(scanId, { category = null, decision = null, sortBy = 'severity' } = {}) {
  let query = supabase
    .from('suggestions')
    .select('*, crawled_files(name, path, web_url, size_bytes, modified_at_sp)')
    .eq('scan_id', scanId);

  if (category) {
    query = query.eq('category', category);
  }

  if (decision) {
    query = query.eq('user_decision', decision);
  }

  // Sort order
  const sortMap = {
    severity: { column: 'severity', ascending: true },
    confidence: { column: 'confidence', ascending: false },
    name: { column: 'current_value', ascending: true },
  };

  const sort = sortMap[sortBy] || sortMap.severity;
  query = query.order(sort.column, { ascending: sort.ascending });

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Update a suggestion's user decision.
 * @param {string} suggestionId
 * @param {'approved'|'rejected'|'skipped'} decision
 */
export async function updateSuggestionDecision(suggestionId, decision) {
  const { error } = await supabase
    .from('suggestions')
    .update({
      user_decision: decision,
      decided_at: new Date().toISOString(),
    })
    .eq('id', suggestionId);

  if (error) throw error;
}

/**
 * Get scan details.
 * @param {string} scanId
 */
export async function getScan(scanId) {
  const { data, error } = await supabase
    .from('scans')
    .select('*')
    .eq('id', scanId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get recent scans for the current user.
 * @param {number} [limit=10]
 */
export async function getRecentScans(limit = 10) {
  const { data, error } = await supabase
    .from('scans')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

/**
 * Get file statistics for a scan.
 * @param {string} scanId
 */
export async function getFileStats(scanId) {
  const { data, error } = await supabase
    .from('crawled_files')
    .select('file_extension, size_bytes, is_folder, depth, modified_at_sp')
    .eq('scan_id', scanId);

  if (error) throw error;

  // Aggregate stats client-side
  const stats = {
    totalFiles: 0,
    totalFolders: 0,
    totalSize: 0,
    typeDistribution: {},
    avgAge: 0,
    maxDepth: 0,
    filesOlderThan2yr: 0,
    filesOlderThan4yr: 0,
  };

  const now = Date.now();
  const TWO_YEARS = 2 * 365.25 * 24 * 60 * 60 * 1000;
  const FOUR_YEARS = 4 * 365.25 * 24 * 60 * 60 * 1000;
  let totalAge = 0;

  data.forEach(file => {
    if (file.is_folder) {
      stats.totalFolders++;
    } else {
      stats.totalFiles++;
      stats.totalSize += file.size_bytes || 0;

      const ext = (file.file_extension || 'unknown').toLowerCase();
      stats.typeDistribution[ext] = (stats.typeDistribution[ext] || 0) + 1;

      if (file.modified_at_sp) {
        const age = now - new Date(file.modified_at_sp).getTime();
        totalAge += age;
        if (age > TWO_YEARS) stats.filesOlderThan2yr++;
        if (age > FOUR_YEARS) stats.filesOlderThan4yr++;
      }
    }

    if (file.depth > stats.maxDepth) {
      stats.maxDepth = file.depth;
    }
  });

  stats.avgAge = stats.totalFiles > 0 ? Math.round(totalAge / stats.totalFiles / (24 * 60 * 60 * 1000)) : 0;

  return stats;
}
