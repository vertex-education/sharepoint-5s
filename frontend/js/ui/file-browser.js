/**
 * File Browser Component
 * Browse SharePoint folders and select one to scan
 */

import { callEdgeFunction } from '../api.js';

/**
 * Create a file browser component
 * @param {HTMLElement} container - Container element
 * @param {Object} options
 * @param {Function} options.onSelectFolder - Called when a folder is selected for scanning
 * @returns {Object} - Browser controller
 */
export function createFileBrowser(container, { onSelectFolder }) {
  let currentUrl = '';
  let currentPath = '';
  let siteInfo = null;

  function render() {
    container.innerHTML = `
      <div class="file-browser">
        <div class="file-browser__header">
          <div class="input-group">
            <input type="text" class="input file-browser__url" placeholder="Paste SharePoint site or folder URL" value="${escapeHtml(currentUrl)}">
            <button class="btn btn--primary file-browser__load">Load</button>
          </div>
        </div>

        <div class="file-browser__content" style="display:none;">
          <div class="file-browser__breadcrumb"></div>
          <div class="file-browser__list"></div>
          <div class="file-browser__actions">
            <button class="btn btn--go file-browser__scan-btn">Scan This Folder</button>
          </div>
        </div>

        <div class="file-browser__loading" style="display:none;">
          <span class="loading-spinner"></span> Loading...
        </div>

        <div class="file-browser__error" style="display:none;"></div>
      </div>
    `;

    setupEventListeners();
  }

  function setupEventListeners() {
    const urlInput = container.querySelector('.file-browser__url');
    const loadBtn = container.querySelector('.file-browser__load');
    const scanBtn = container.querySelector('.file-browser__scan-btn');

    loadBtn.addEventListener('click', () => loadFolder(urlInput.value.trim()));
    urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') loadFolder(urlInput.value.trim());
    });

    scanBtn?.addEventListener('click', () => {
      if (onSelectFolder) {
        onSelectFolder({
          url: currentUrl,
          path: currentPath,
          site: siteInfo,
        });
      }
    });
  }

  async function loadFolder(url, path = '') {
    if (!url) return;

    currentUrl = url;
    currentPath = path;

    const content = container.querySelector('.file-browser__content');
    const loading = container.querySelector('.file-browser__loading');
    const error = container.querySelector('.file-browser__error');

    content.style.display = 'none';
    error.style.display = 'none';
    loading.style.display = 'flex';

    try {
      const result = await callEdgeFunction('browse-folder', { url, path });

      siteInfo = result.site;
      renderBreadcrumb(result.currentPath);
      renderList(result.items);

      loading.style.display = 'none';
      content.style.display = 'block';

    } catch (err) {
      console.error('Error loading folder:', err);
      loading.style.display = 'none';
      error.style.display = 'block';
      error.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">⚠️</div>
          <div>${escapeHtml(err.message)}</div>
        </div>
      `;
    }
  }

  function renderBreadcrumb(path) {
    const breadcrumb = container.querySelector('.file-browser__breadcrumb');
    const parts = path ? path.split('/').filter(Boolean) : [];

    let html = `<span class="file-browser__crumb" data-path="">📁 ${escapeHtml(siteInfo?.drive || 'Root')}</span>`;

    let currentPartPath = '';
    for (const part of parts) {
      currentPartPath += '/' + part;
      html += ` / <span class="file-browser__crumb" data-path="${escapeHtml(currentPartPath)}">${escapeHtml(part)}</span>`;
    }

    breadcrumb.innerHTML = html;

    // Add click handlers
    breadcrumb.querySelectorAll('.file-browser__crumb').forEach(crumb => {
      crumb.addEventListener('click', () => {
        loadFolder(currentUrl, crumb.dataset.path);
      });
    });
  }

  function renderList(items) {
    const list = container.querySelector('.file-browser__list');

    if (!items || items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📂</div>
          <div>This folder is empty</div>
        </div>
      `;
      return;
    }

    // Sort: folders first, then files
    const sorted = [...items].sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    list.innerHTML = sorted.map(item => `
      <div class="file-browser__item ${item.isFolder ? 'file-browser__item--folder' : ''}" data-path="${escapeHtml(currentPath ? currentPath + '/' + item.name : item.name)}" data-is-folder="${item.isFolder}">
        <span class="file-browser__item-icon">${item.isFolder ? '📁' : getFileIcon(item.name)}</span>
        <span class="file-browser__item-name">${escapeHtml(item.name)}</span>
        <span class="file-browser__item-size">${item.isFolder ? `${item.childCount} items` : formatBytes(item.size)}</span>
      </div>
    `).join('');

    // Add click handlers for folders
    list.querySelectorAll('.file-browser__item--folder').forEach(item => {
      item.addEventListener('click', () => {
        loadFolder(currentUrl, item.dataset.path);
      });
    });
  }

  function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    const icons = {
      pdf: '📄', doc: '📄', docx: '📄',
      xls: '📊', xlsx: '📊', csv: '📊',
      ppt: '📊', pptx: '📊',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
      mp4: '🎥', mov: '🎥', avi: '🎥',
      zip: '📦', rar: '📦',
      txt: '📝', md: '📝',
    };
    return icons[ext] || '📄';
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

  // Initialize
  render();

  return {
    loadFolder,
    getCurrentPath: () => currentPath,
    getSiteInfo: () => siteInfo,
  };
}
