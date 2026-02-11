/**
 * My Sites UI Components
 * Renders the personal dashboard showing user's SharePoint sites.
 * Supports in-place scanning with background progress.
 */

// Track active scans: { siteUrl: { scanId, status, progress, ... } }
const activeScans = new Map();

// Callbacks for scan events
let onScanComplete = null;

/**
 * Set callback for when a scan completes
 */
export function setOnScanComplete(callback) {
  onScanComplete = callback;
}

/**
 * Resume tracking any in-progress scans from the sites data.
 * Called on page load to pick up scans that were running before a refresh.
 */
export function resumeInProgressScans(sites) {
  for (const site of sites) {
    if (site.latest_scan && ['crawling', 'analyzing', 'crawled'].includes(site.latest_scan.status)) {
      const siteUrl = site.web_url;
      const scan = site.latest_scan;

      // Already tracking this scan
      if (activeScans.has(siteUrl)) continue;

      console.log(`Resuming in-progress scan for ${site.display_name}: ${scan.status}`);

      // Add to active scans and start polling
      activeScans.set(siteUrl, {
        scanId: scan.id,
        status: scan.status,
        progress: scan.crawl_progress || 0,
        totalFiles: scan.total_files || 0,
        totalFolders: scan.total_folders || 0,
        totalSize: scan.total_size_bytes || 0,
      });

      // Start polling to continue the crawl
      pollScanStatus(siteUrl, scan.id);
    }
  }
}

/**
 * Start a scan for a site (called from button click)
 */
export async function startSiteScan(siteUrl, siteName) {
  // Dynamically import to avoid circular deps
  const { startCrawl, getCrawlStatus, continueCrawl } = await import('../api.js');
  const { showToast } = await import('./toast.js');

  try {
    showToast(`Starting scan for ${siteName}...`, 'info');

    // Start the crawl
    const { scan_id } = await startCrawl(siteUrl);

    // Track the active scan
    activeScans.set(siteUrl, {
      scanId: scan_id,
      status: 'crawling',
      progress: 0,
      totalFiles: 0,
      totalFolders: 0,
      totalSize: 0,
    });

    // Update the UI immediately
    updateSiteCardProgress(siteUrl);

    // Start polling for this scan
    pollScanStatus(siteUrl, scan_id);

  } catch (err) {
    console.error('Failed to start scan:', err);
    showToast(`Failed to start scan: ${err.message}`, 'error');
    activeScans.delete(siteUrl);
  }
}

/**
 * Poll for scan status and update UI
 */
async function pollScanStatus(siteUrl, scanId) {
  const { getCrawlStatus, continueCrawl } = await import('../api.js');
  const { showToast } = await import('./toast.js');

  const poll = async () => {
    const scanInfo = activeScans.get(siteUrl);
    if (!scanInfo) return; // Scan was cancelled

    try {
      // Get current status
      const status = await getCrawlStatus(scanId);

      // If still crawling, trigger continue-crawl to process more batches
      if (status.status === 'crawling') {
        try {
          const continueResult = await continueCrawl(scanId);
          // Update with more accurate data from continue-crawl
          scanInfo.status = continueResult.status;
          scanInfo.progress = continueResult.crawl_progress || 0;
          scanInfo.totalFiles = continueResult.total_files || 0;
          scanInfo.totalFolders = continueResult.total_folders || 0;
          scanInfo.totalSize = continueResult.total_size_bytes || 0;
          scanInfo.remaining = continueResult.remaining || 0;
        } catch (e) {
          console.error('Continue crawl error:', e);
        }
      } else {
        // Use status from getCrawlStatus for non-crawling states
        scanInfo.status = status.status;
        scanInfo.progress = status.crawl_progress || 0;
        scanInfo.totalFiles = status.total_files || 0;
        scanInfo.totalFolders = status.total_folders || 0;
        scanInfo.totalSize = status.total_size_bytes || 0;
      }

      // Update UI
      updateSiteCardProgress(siteUrl);

      // Check if complete
      if (status.status === 'complete') {
        showToast(`Scan complete: ${scanInfo.totalFiles.toLocaleString()} files analyzed`, 'success');
        activeScans.delete(siteUrl);
        onScanComplete?.();
        return;
      }

      if (status.status === 'error') {
        showToast(`Scan failed: ${status.error_message || 'Unknown error'}`, 'error');
        activeScans.delete(siteUrl);
        updateSiteCardProgress(siteUrl); // Clear the progress UI
        return;
      }

      // Continue polling
      const interval = status.status === 'crawling' ? 1500 : 3000;
      setTimeout(poll, interval);

    } catch (err) {
      console.error('Poll error:', err);
      // Retry after a delay
      setTimeout(poll, 5000);
    }
  };

  poll();
}

/**
 * Update a site card to show scan progress
 */
function updateSiteCardProgress(siteUrl) {
  const card = document.querySelector(`[data-site-url="${CSS.escape(siteUrl)}"]`);
  if (!card) return;

  const scanInfo = activeScans.get(siteUrl);
  const actionsDiv = card.querySelector('.site-card__actions');
  const progressDiv = card.querySelector('.site-card__progress');

  if (!scanInfo) {
    // No active scan - restore normal actions
    if (progressDiv) progressDiv.remove();
    if (actionsDiv) actionsDiv.style.display = '';
    return;
  }

  // Hide normal actions, show progress
  if (actionsDiv) actionsDiv.style.display = 'none';

  // Create or update progress div
  let progress = progressDiv;
  if (!progress) {
    progress = document.createElement('div');
    progress.className = 'site-card__progress';
    card.appendChild(progress);
  }

  const statusText = getStatusText(scanInfo);
  const progressPercent = scanInfo.progress || 0;

  progress.innerHTML = `
    <div class="scan-progress">
      <div class="scan-progress__bar-container">
        <div class="scan-progress__bar scan-progress__bar--striped" style="width: ${progressPercent}%;"></div>
      </div>
      <div class="scan-progress__text">
        <span>${statusText}</span>
        <span>${progressPercent}%</span>
      </div>
      ${scanInfo.totalFiles > 0 ? `
        <div class="scan-progress__stats">
          ${scanInfo.totalFiles.toLocaleString()} files &middot; ${formatBytes(scanInfo.totalSize)}
        </div>
      ` : ''}
    </div>
  `;
}

function getStatusText(scanInfo) {
  switch (scanInfo.status) {
    case 'crawling':
      return scanInfo.remaining ? `Crawling... (${scanInfo.remaining} folders remaining)` : 'Crawling...';
    case 'crawled':
      return 'Starting analysis...';
    case 'analyzing':
      return 'Analyzing with AI...';
    case 'complete':
      return 'Complete!';
    case 'error':
      return 'Error';
    default:
      return 'Processing...';
  }
}

/**
 * Check if a site is currently being scanned
 */
export function isSiteScanning(siteUrl) {
  return activeScans.has(siteUrl);
}

/**
 * Render personal summary stats
 * @param {HTMLElement} container
 * @param {{ total_sites: number, scanned_sites: number, total_actions: number, total_files_analyzed: number }} summary
 */
export function renderSitesSummary(container, summary) {
  container.innerHTML = `
    <div class="my-sites__hero">
      <h1 class="my-sites__title">My SharePoint Sites</h1>
      <p class="my-sites__subtitle">Manage and track cleanup progress across your sites</p>
    </div>
    <div class="summary-stats">
      <div class="stat-card animate-fade-in-up stagger-1">
        <div class="stat-card__value">${summary.total_sites}</div>
        <div class="stat-card__label">Sites Available</div>
      </div>
      <div class="stat-card animate-fade-in-up stagger-2">
        <div class="stat-card__value">${summary.scanned_sites}</div>
        <div class="stat-card__label">Sites Scanned</div>
      </div>
      <div class="stat-card stat-card--archive animate-fade-in-up stagger-3">
        <div class="stat-card__value">${summary.total_actions}</div>
        <div class="stat-card__label">Actions Taken</div>
      </div>
      <div class="stat-card animate-fade-in-up stagger-4">
        <div class="stat-card__value">${summary.total_files_analyzed.toLocaleString()}</div>
        <div class="stat-card__label">Files Analyzed</div>
      </div>
    </div>
  `;
}

/**
 * Render filter tabs
 * @param {HTMLElement} container
 * @param {string} activeFilter
 * @param {{ all: number, scanned: number, 'not-scanned': number }} counts
 * @param {Function} onFilterChange
 */
export function renderFilterTabs(container, activeFilter, counts, onFilterChange) {
  container.innerHTML = `
    <div class="tabs">
      <button class="tab ${activeFilter === 'all' ? 'tab--active' : ''}" data-filter="all">
        All Sites <span class="tab__count">${counts.all}</span>
      </button>
      <button class="tab ${activeFilter === 'scanned' ? 'tab--active' : ''}" data-filter="scanned">
        Scanned <span class="tab__count">${counts.scanned}</span>
      </button>
      <button class="tab ${activeFilter === 'not-scanned' ? 'tab--active' : ''}" data-filter="not-scanned">
        Not Scanned <span class="tab__count">${counts['not-scanned']}</span>
      </button>
    </div>
  `;

  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      onFilterChange(tab.dataset.filter);
    });
  });
}

/**
 * Render sites grid
 * @param {HTMLElement} container
 * @param {Array} sites
 * @param {string} filter
 */
export function renderSitesList(container, sites, filter = 'all') {
  let filtered = sites;
  if (filter === 'scanned') {
    filtered = sites.filter(s => s.has_scans);
  } else if (filter === 'not-scanned') {
    filtered = sites.filter(s => !s.has_scans);
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">${getEmptyStateIcon(filter)}</div>
        <div class="empty-state__title">${getEmptyStateTitle(filter)}</div>
        <div class="empty-state__text">${getEmptyStateText(filter)}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="sites-grid">
      ${filtered.map((site, i) => renderSiteCard(site, i)).join('')}
    </div>
  `;

  // Attach click handlers for scan buttons
  container.querySelectorAll('.site-card__scan-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const siteUrl = btn.dataset.siteUrl;
      const siteName = btn.dataset.siteName;
      if (!isSiteScanning(siteUrl)) {
        startSiteScan(siteUrl, siteName);
      }
    });
  });
}

/**
 * Render a single site card
 */
function renderSiteCard(site, index) {
  const hasScans = site.has_scans;
  const latestScan = site.latest_scan;
  const staggerClass = Math.min(index + 1, 10);
  const isScanning = isSiteScanning(site.web_url);

  return `
    <div class="site-card ${hasScans ? 'site-card--scanned' : ''} ${isScanning ? 'site-card--scanning' : ''} animate-fade-in-up stagger-${staggerClass}" data-site-url="${escapeAttr(site.web_url)}">
      <div class="site-card__header">
        <div class="site-card__icon">${hasScans ? '✓' : '📁'}</div>
        <h3 class="site-card__name" title="${escapeHtml(site.display_name)}">${escapeHtml(site.display_name)}</h3>
      </div>

      ${site.description ? `<p class="site-card__description" title="${escapeHtml(site.description)}">${escapeHtml(site.description)}</p>` : ''}

      ${hasScans ? `
        <div class="site-card__stats">
          <div class="site-card__stat">
            <span class="site-card__stat-value">${site.scan_count}</span>
            <span class="site-card__stat-label">Scans</span>
          </div>
          <div class="site-card__stat">
            <span class="site-card__stat-value">${site.total_actions}</span>
            <span class="site-card__stat-label">Actions</span>
          </div>
          <div class="site-card__stat">
            <span class="site-card__stat-value">${latestScan.total_files.toLocaleString()}</span>
            <span class="site-card__stat-label">Files</span>
          </div>
        </div>
        <div class="site-card__breakdown">
          ${site.actions_breakdown.deletes > 0 ? `<span class="site-card__tag site-card__tag--delete">${site.actions_breakdown.deletes} deleted</span>` : ''}
          ${site.actions_breakdown.renames > 0 ? `<span class="site-card__tag site-card__tag--rename">${site.actions_breakdown.renames} renamed</span>` : ''}
          ${site.actions_breakdown.moves > 0 ? `<span class="site-card__tag site-card__tag--archive">${site.actions_breakdown.moves} archived</span>` : ''}
          ${site.total_actions === 0 ? `<span class="site-card__tag">No actions yet</span>` : ''}
        </div>
        <div class="site-card__footer">
          <span class="site-card__date">Last scan: ${formatDate(latestScan.created_at)}</span>
          <span class="badge badge--${latestScan.status}">${latestScan.status}</span>
        </div>
      ` : `
        <div class="site-card__cta">
          <p class="site-card__cta-text">Not yet analyzed</p>
        </div>
      `}

      <div class="site-card__actions">
        ${hasScans && latestScan.status === 'complete' ? `
          <a href="dashboard.html?scan_id=${latestScan.id}" class="btn btn--sm btn--ghost">View Results</a>
        ` : ''}
        <button class="btn btn--sm btn--primary site-card__scan-btn" data-site-url="${escapeAttr(site.web_url)}" data-site-name="${escapeAttr(site.display_name)}" ${isScanning ? 'disabled' : ''}>
          ${isScanning ? 'Scanning...' : (hasScans ? 'Rescan' : 'Scan Now')}
        </button>
      </div>
    </div>
  `;
}

/**
 * Render loading skeleton
 * @param {HTMLElement} container
 */
export function renderSitesSkeleton(container) {
  container.innerHTML = `
    <div class="sites-grid">
      ${Array(6).fill(0).map((_, i) => `
        <div class="site-card animate-fade-in-up stagger-${i + 1}">
          <div class="skeleton" style="width:100%;height:24px;margin-bottom:var(--space-3);"></div>
          <div class="skeleton" style="width:80%;height:16px;margin-bottom:var(--space-4);"></div>
          <div class="skeleton" style="width:100%;height:60px;margin-bottom:var(--space-3);"></div>
          <div class="skeleton" style="width:120px;height:32px;"></div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Helper Functions ───

function getEmptyStateIcon(filter) {
  switch (filter) {
    case 'scanned': return '🔍';
    case 'not-scanned': return '🎉';
    default: return '📁';
  }
}

function getEmptyStateTitle(filter) {
  switch (filter) {
    case 'scanned': return 'No Scanned Sites';
    case 'not-scanned': return 'All Sites Scanned!';
    default: return 'No Sites Found';
  }
}

function getEmptyStateText(filter) {
  switch (filter) {
    case 'scanned':
      return "You haven't scanned any sites yet. Start by pasting a SharePoint URL on the home page.";
    case 'not-scanned':
      return 'Great job! All your accessible sites have been scanned.';
    default:
      return "We couldn't find any SharePoint sites you have access to. Make sure you're signed in with the correct Microsoft account.";
  }
}

function formatDate(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
