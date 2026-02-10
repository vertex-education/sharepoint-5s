/**
 * My Sites UI Components
 * Renders the personal dashboard showing user's SharePoint sites.
 */

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
}

/**
 * Render a single site card
 */
function renderSiteCard(site, index) {
  const hasScans = site.has_scans;
  const latestScan = site.latest_scan;
  const staggerClass = Math.min(index + 1, 10);

  return `
    <div class="site-card ${hasScans ? 'site-card--scanned' : ''} animate-fade-in-up stagger-${staggerClass}">
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
        <a href="dashboard.html?url=${encodeURIComponent(site.web_url)}" class="btn btn--sm btn--primary">
          ${hasScans ? 'Rescan' : 'Scan Now'}
        </a>
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

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
