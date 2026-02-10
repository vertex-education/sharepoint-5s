/**
 * Suggestion Card Component
 * Individual suggestion with approve/reject actions.
 */

const FILE_ICONS = {
  docx: '\uD83D\uDCC4', doc: '\uD83D\uDCC4', pdf: '\uD83D\uDCC4',
  xlsx: '\uD83D\uDCCA', xls: '\uD83D\uDCCA', csv: '\uD83D\uDCCA',
  pptx: '\uD83D\uDCCA', ppt: '\uD83D\uDCCA',
  jpg: '\uD83D\uDDBC', jpeg: '\uD83D\uDDBC', png: '\uD83D\uDDBC', gif: '\uD83D\uDDBC', svg: '\uD83D\uDDBC',
  mp4: '\uD83C\uDFA5', avi: '\uD83C\uDFA5', mov: '\uD83C\uDFA5',
  zip: '\uD83D\uDCE6', rar: '\uD83D\uDCE6', '7z': '\uD83D\uDCE6',
  txt: '\uD83D\uDCDD', md: '\uD83D\uDCDD',
  default: '\uD83D\uDCC1',
  folder: '\uD83D\uDCC2',
};

/**
 * Create a suggestion card element.
 * @param {object} suggestion - Suggestion data from API
 * @param {{ onApprove: (id: string) => void, onReject: (id: string) => void }} callbacks
 * @returns {HTMLElement}
 */
export function createSuggestionCard(suggestion, { onApprove, onReject }) {
  const el = document.createElement('div');
  el.className = `suggestion-card ${getDecisionClass(suggestion.user_decision)}`;
  el.dataset.category = suggestion.category;
  el.dataset.id = suggestion.id;

  const file = suggestion.crawled_files;
  const ext = file?.name?.split('.').pop()?.toLowerCase() || 'default';
  const icon = file?.is_folder ? FILE_ICONS.folder : (FILE_ICONS[ext] || FILE_ICONS.default);
  const isDecided = suggestion.user_decision !== 'pending';
  const isExecuted = suggestion.user_decision === 'executed';

  el.innerHTML = `
    <div class="suggestion-card__icon">${icon}</div>
    <div>
      <div class="suggestion-card__header">
        <span class="suggestion-card__title">${escapeHtml(suggestion.title)}</span>
        ${suggestion.source === 'ai' ? '<span class="suggestion-card__source-badge">AI</span>' : ''}
        <span class="suggestion-card__severity suggestion-card__severity--${suggestion.severity}">
          ${suggestion.severity}
        </span>
      </div>
      <div class="suggestion-card__path" title="${escapeHtml(suggestion.current_value || '')}">
        ${escapeHtml(suggestion.current_value || file?.path || '')}
      </div>
    </div>
    <div></div>

    <div class="suggestion-card__description">
      ${escapeHtml(suggestion.description)}
    </div>

    ${suggestion.category === 'rename' && suggestion.suggested_value ? `
      <div class="suggestion-card__rename">
        <span class="suggestion-card__rename-old">${escapeHtml(getFilename(suggestion.current_value))}</span>
        <span class="suggestion-card__rename-arrow">\u2192</span>
        <span class="suggestion-card__rename-new">${escapeHtml(suggestion.suggested_value)}</span>
      </div>
    ` : ''}

    <div class="suggestion-card__actions">
      <span class="suggestion-card__confidence">
        ${Math.round(suggestion.confidence * 100)}% confidence
      </span>
      <div class="suggestion-card__buttons">
        ${!isDecided ? `
          <button class="btn btn--sm btn--ghost" data-action="reject" aria-label="Reject suggestion">
            \u2717 REJECT
          </button>
          <button class="btn btn--sm" style="background:var(--accent-approve);color:var(--bg-primary);border-color:var(--accent-approve);" data-action="approve" aria-label="Approve suggestion">
            \u2713 APPROVE
          </button>
        ` : `
          <span class="badge" style="${
            isExecuted ? 'color:var(--accent-approve);border-color:var(--accent-approve);background:var(--accent-approve-dim);'
            : suggestion.user_decision === 'approved' ? 'color:var(--accent-approve);border-color:var(--accent-approve);'
            : 'color:var(--text-tertiary);'
          }">
            ${isExecuted ? '\u2713 DONE' : suggestion.user_decision.toUpperCase()}
          </span>
        `}
      </div>
    </div>
  `;

  // Attach event handlers
  const approveBtn = el.querySelector('[data-action="approve"]');
  const rejectBtn = el.querySelector('[data-action="reject"]');

  approveBtn?.addEventListener('click', () => {
    el.classList.add('animate-approve', 'suggestion-card--approved');
    onApprove(suggestion.id);
  });

  rejectBtn?.addEventListener('click', () => {
    el.classList.add('animate-reject', 'suggestion-card--rejected');
    onReject(suggestion.id);
  });

  return el;
}

function getDecisionClass(decision) {
  if (decision === 'executed') return 'suggestion-card--executed';
  if (decision === 'approved') return 'suggestion-card--approved';
  if (decision === 'rejected') return 'suggestion-card--rejected';
  return '';
}

function getFilename(path) {
  if (!path) return '';
  return path.split('/').pop() || path;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
