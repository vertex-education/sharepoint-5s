/**
 * Folder Navigation UI Component
 * Renders breadcrumb bar + clickable folder grid with issue-count badges.
 */

import { getFolderChildren, getFolderBreadcrumb } from './folder-tree.js';

/**
 * Render the folder navigation section.
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} folderTree - Root tree node from buildFolderTree()
 * @param {string} currentPath - Current folder path
 * @param {{ onNavigate: (path: string) => void }} callbacks
 */
export function renderFolderNav(container, folderTree, currentPath, { onNavigate }) {
  if (!folderTree) {
    container.innerHTML = '';
    return;
  }

  const children = getFolderChildren(folderTree, currentPath);
  const breadcrumb = getFolderBreadcrumb(currentPath);

  // Sort children by issue count descending
  const sorted = [...children].sort((a, b) => b.rollupCounts.total - a.rollupCounts.total);

  container.innerHTML = `
    <div class="folder-nav">
      <div class="folder-nav__breadcrumb">
        ${breadcrumb.map((seg, i) => {
          const isLast = i === breadcrumb.length - 1;
          const separator = i > 0 ? '<span class="folder-nav__separator">/</span>' : '';
          if (isLast) {
            return `${separator}<span class="folder-nav__crumb folder-nav__crumb--active">${escapeHtml(seg.name)}</span>`;
          }
          return `${separator}<button class="folder-nav__crumb" data-path="${escapeAttr(seg.path)}">${escapeHtml(seg.name)}</button>`;
        }).join('')}
      </div>
      ${sorted.length > 0 ? `
        <div class="folder-nav__grid">
          ${sorted.map(node => renderFolderCard(node)).join('')}
        </div>
      ` : ''}
    </div>
  `;

  // Bind breadcrumb clicks
  container.querySelectorAll('.folder-nav__crumb[data-path]').forEach(btn => {
    btn.addEventListener('click', () => onNavigate(btn.dataset.path));
  });

  // Bind folder card clicks
  container.querySelectorAll('.folder-card[data-path]').forEach(card => {
    card.addEventListener('click', () => onNavigate(card.dataset.path));
  });
}

function renderFolderCard(node) {
  const total = node.rollupCounts.total;
  const isClean = total === 0;
  const badgeClass = total > 15 ? 'folder-card__badge--hot'
    : total > 0 ? 'folder-card__badge--warm'
    : '';

  const bar = total > 0 ? renderCategoryBar(node.rollupCounts) : '';

  return `
    <div class="folder-card${isClean ? ' folder-card--clean' : ''}" data-path="${escapeAttr(node.path)}">
      <div class="folder-card__header">
        <span class="folder-card__icon">&#128193;</span>
        <span class="folder-card__name">${escapeHtml(node.name)}</span>
        <span class="folder-card__badge ${badgeClass}">${total}</span>
      </div>
      ${bar}
    </div>
  `;
}

function renderCategoryBar(counts) {
  const total = counts.total;
  if (total === 0) return '';

  const segments = [
    { category: 'delete', count: counts.delete },
    { category: 'archive', count: counts.archive },
    { category: 'rename', count: counts.rename },
    { category: 'structure', count: counts.structure },
  ].filter(s => s.count > 0);

  return `
    <div class="folder-card__bar">
      ${segments.map(s => {
        const pct = (s.count / total * 100).toFixed(1);
        return `<div class="folder-card__bar-segment folder-card__bar-segment--${s.category}" style="width:${pct}%"></div>`;
      }).join('')}
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
