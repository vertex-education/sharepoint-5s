/**
 * Leaderboard UI Components
 * Renders the leaderboard table and aggregate statistics.
 */

/**
 * Render aggregate stats cards
 * @param {HTMLElement} container
 * @param {{ total_users: number, total_actions: number, total_bytes_cleaned: number }} aggregates
 */
export function renderAggregates(container, aggregates) {
  container.innerHTML = `
    <div class="aggregate-stats">
      <div class="stat-card stat-card--large animate-fade-in-up stagger-1">
        <div class="stat-card__value">${aggregates.total_users}</div>
        <div class="stat-card__label">Contributors</div>
      </div>
      <div class="stat-card stat-card--large stat-card--archive animate-fade-in-up stagger-2">
        <div class="stat-card__value">${aggregates.total_actions.toLocaleString()}</div>
        <div class="stat-card__label">Total Actions</div>
      </div>
      <div class="stat-card stat-card--large animate-fade-in-up stagger-3">
        <div class="stat-card__value">${formatBytes(aggregates.total_bytes_cleaned)}</div>
        <div class="stat-card__label">Data Cleaned</div>
      </div>
    </div>
  `;
}

/**
 * Render leaderboard table
 * @param {HTMLElement} container
 * @param {Array} entries
 * @param {string} currentUserId
 */
export function renderLeaderboard(container, entries, currentUserId) {
  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🏆</div>
        <div class="empty-state__title">No Activity Yet</div>
        <div class="empty-state__text">Be the first to clean up a SharePoint site!</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="leaderboard-list">
      ${entries.map((entry, i) => renderLeaderboardRow(entry, i, currentUserId)).join('')}
    </div>
  `;
}

/**
 * Render a single leaderboard row
 */
function renderLeaderboardRow(entry, index, currentUserId) {
  const isCurrentUser = entry.user_id === currentUserId;
  const rankClass = getRankClass(entry.rank);
  const avatarColor = getAvatarColor(entry.rank);
  const staggerClass = Math.min(index + 1, 10);

  return `
    <div class="leaderboard-row ${isCurrentUser ? 'leaderboard-row--current' : ''} animate-fade-in-up stagger-${staggerClass}">
      <div class="leaderboard-row__rank ${rankClass}">
        ${entry.rank <= 3 ? getMedalIcon(entry.rank) : entry.rank}
      </div>
      <div class="leaderboard-row__user">
        <span class="leaderboard-row__avatar" style="background:${avatarColor}">
          ${escapeHtml(entry.initials)}
        </span>
        <span class="leaderboard-row__name">${escapeHtml(entry.display_name)}</span>
        ${isCurrentUser ? '<span class="badge">You</span>' : ''}
      </div>
      <div class="leaderboard-row__stats">
        <div class="leaderboard-row__stat">
          <span class="leaderboard-row__stat-value">${entry.total_actions}</span>
          <span class="leaderboard-row__stat-label">Actions</span>
        </div>
        <div class="leaderboard-row__stat leaderboard-row__stat--delete">
          <span class="leaderboard-row__stat-value">${entry.total_deletes}</span>
          <span class="leaderboard-row__stat-label">Deleted</span>
        </div>
        <div class="leaderboard-row__stat leaderboard-row__stat--rename">
          <span class="leaderboard-row__stat-value">${entry.total_renames}</span>
          <span class="leaderboard-row__stat-label">Renamed</span>
        </div>
        <div class="leaderboard-row__stat">
          <span class="leaderboard-row__stat-value">${formatBytes(entry.bytes_deleted)}</span>
          <span class="leaderboard-row__stat-label">Cleaned</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render loading skeleton
 * @param {HTMLElement} container
 */
export function renderLeaderboardSkeleton(container) {
  container.innerHTML = `
    <div class="leaderboard-list">
      ${Array(5).fill(0).map((_, i) => `
        <div class="leaderboard-row skeleton-row animate-fade-in-up stagger-${i + 1}">
          <div class="skeleton" style="width:40px;height:40px;border-radius:50%;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:var(--space-2);">
            <div class="skeleton" style="width:150px;height:20px;"></div>
            <div class="skeleton" style="width:80px;height:14px;"></div>
          </div>
          <div class="skeleton" style="width:200px;height:40px;"></div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Helper Functions ───

function getMedalIcon(rank) {
  switch (rank) {
    case 1: return '🥇';
    case 2: return '🥈';
    case 3: return '🥉';
    default: return rank;
  }
}

function getRankClass(rank) {
  switch (rank) {
    case 1: return 'leaderboard-row__rank--gold';
    case 2: return 'leaderboard-row__rank--silver';
    case 3: return 'leaderboard-row__rank--bronze';
    default: return '';
  }
}

function getAvatarColor(rank) {
  const colors = [
    '#e9a820', // gold - 1st
    '#9d9a93', // silver - 2nd
    '#cd7f32', // bronze - 3rd
    '#457b9d', // blue
    '#8b7ec8', // purple
    '#2a9d8f', // teal
    '#e63946', // red
    '#6b6860', // gray
  ];
  return colors[Math.min(rank - 1, colors.length - 1)];
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
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
