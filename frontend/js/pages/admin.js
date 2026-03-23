/**
 * Admin Page
 * Manage admins and pre-scan large folders
 */

import { supabase } from '../lib/supabase-client.js';
import { initAuth, requireAuth, getCurrentUser } from '../auth.js';
import { callEdgeFunction } from '../api.js';

// DOM Elements
const accessDenied = document.getElementById('accessDenied');
const adminContent = document.getElementById('adminContent');
const adminList = document.getElementById('adminList');
const newAdminEmail = document.getElementById('newAdminEmail');
const addAdminBtn = document.getElementById('addAdminBtn');
const prescanSiteUrl = document.getElementById('prescanSiteUrl');
const scanForLargeFoldersBtn = document.getElementById('scanForLargeFoldersBtn');
const largeFoldersList = document.getElementById('largeFoldersList');
const prescanQueue = document.getElementById('prescanQueue');

let isAdmin = false;

async function init() {
  await initAuth();
  await requireAuth();

  // Check if user is admin
  isAdmin = await checkIfAdmin();

  if (isAdmin) {
    accessDenied.style.display = 'none';
    adminContent.style.display = 'block';
    await loadAdminList();
    await loadPrescanQueue();
    setupEventListeners();
  } else {
    accessDenied.style.display = 'block';
    adminContent.style.display = 'none';
  }
}

async function checkIfAdmin() {
  try {
    const { data, error } = await supabase.rpc('current_user_is_admin');
    if (error) {
      console.error('Error checking admin status:', error);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error('Error checking admin status:', err);
    return false;
  }
}

async function loadAdminList() {
  const { data, error } = await supabase
    .from('admins')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error loading admins:', error);
    adminList.innerHTML = '<div class="empty-state">Error loading admins</div>';
    return;
  }

  if (!data || data.length === 0) {
    adminList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">👤</div>
        <div>No admins configured yet</div>
      </div>
    `;
    return;
  }

  adminList.innerHTML = data.map(admin => `
    <div class="admin-item" data-id="${admin.id}">
      <span class="admin-item__email">${escapeHtml(admin.email)}</span>
      <button class="admin-item__remove" data-email="${escapeHtml(admin.email)}">Remove</button>
    </div>
  `).join('');

  // Add remove handlers
  adminList.querySelectorAll('.admin-item__remove').forEach(btn => {
    btn.addEventListener('click', () => removeAdmin(btn.dataset.email));
  });
}

async function addAdmin() {
  const email = newAdminEmail.value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address');
    return;
  }

  addAdminBtn.disabled = true;
  addAdminBtn.textContent = 'Adding...';

  try {
    const user = await getCurrentUser();
    const { error } = await supabase
      .from('admins')
      .insert({ email, created_by: user.id });

    if (error) {
      if (error.code === '23505') {
        alert('This email is already an admin');
      } else {
        alert('Error adding admin: ' + error.message);
      }
      return;
    }

    newAdminEmail.value = '';
    await loadAdminList();
  } catch (err) {
    console.error('Error adding admin:', err);
    alert('Error adding admin');
  } finally {
    addAdminBtn.disabled = false;
    addAdminBtn.textContent = 'Add Admin';
  }
}

async function removeAdmin(email) {
  if (!confirm(`Remove ${email} as admin?`)) return;

  const { error } = await supabase
    .from('admins')
    .delete()
    .eq('email', email);

  if (error) {
    alert('Error removing admin: ' + error.message);
    return;
  }

  await loadAdminList();
}

async function scanForLargeFolders() {
  const url = prescanSiteUrl.value.trim();
  if (!url) {
    alert('Please enter a SharePoint URL');
    return;
  }

  scanForLargeFoldersBtn.disabled = true;
  scanForLargeFoldersBtn.innerHTML = '<span class="loading-spinner"></span> Scanning...';
  largeFoldersList.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span> Finding large folders...</div>';

  try {
    const result = await callEdgeFunction('list-large-folders', { url, minSizeGB: 1 });

    if (!result.folders || result.folders.length === 0) {
      largeFoldersList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📁</div>
          <div>No folders larger than 1GB found</div>
        </div>
      `;
      return;
    }

    largeFoldersList.innerHTML = result.folders.map(folder => `
      <div class="folder-item">
        <div class="folder-item__info">
          <div class="folder-item__name">${escapeHtml(folder.name)}</div>
          <div class="folder-item__path">${escapeHtml(folder.path)}</div>
        </div>
        <div class="folder-item__size">${formatBytes(folder.size)}</div>
        <button class="btn btn--sm btn--primary" data-path="${escapeHtml(folder.path)}" data-name="${escapeHtml(folder.name)}" data-size="${folder.size}">
          Pre-scan
        </button>
      </div>
    `).join('');

    // Add pre-scan handlers
    largeFoldersList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => addToPrescanQueue(
        url,
        btn.dataset.path,
        btn.dataset.name,
        parseInt(btn.dataset.size)
      ));
    });

  } catch (err) {
    console.error('Error scanning for large folders:', err);
    largeFoldersList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <div>Error: ${escapeHtml(err.message)}</div>
      </div>
    `;
  } finally {
    scanForLargeFoldersBtn.disabled = false;
    scanForLargeFoldersBtn.textContent = 'Find Large Folders';
  }
}

async function addToPrescanQueue(siteUrl, folderPath, folderName, sizeBytes) {
  const user = await getCurrentUser();

  const { error } = await supabase
    .from('prescan_queue')
    .insert({
      site_url: siteUrl,
      folder_path: folderPath,
      folder_name: folderName,
      size_bytes: sizeBytes,
      created_by: user.id
    });

  if (error) {
    alert('Error adding to queue: ' + error.message);
    return;
  }

  await loadPrescanQueue();

  // Start the pre-scan
  startPrescan();
}

async function loadPrescanQueue() {
  const { data, error } = await supabase
    .from('prescan_queue')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error loading prescan queue:', error);
    return;
  }

  if (!data || data.length === 0) {
    prescanQueue.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div>No pre-scans queued</div>
      </div>
    `;
    return;
  }

  prescanQueue.innerHTML = data.map(item => `
    <div class="queue-item queue-item--${item.status}">
      <div class="queue-item__info">
        <div class="queue-item__name">${escapeHtml(item.folder_name || 'Root')}</div>
        <div class="queue-item__path">${escapeHtml(item.folder_path || item.site_url)}</div>
      </div>
      <div class="folder-item__size">${formatBytes(item.size_bytes)}</div>
      <span class="queue-item__status queue-item__status--${item.status}">
        ${item.status === 'scanning' ? '<span class="loading-spinner"></span>' : ''}
        ${item.status.charAt(0).toUpperCase() + item.status.slice(1)}
      </span>
    </div>
  `).join('');
}

async function startPrescan() {
  // Get next pending item
  const { data: pending } = await supabase
    .from('prescan_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!pending) return;

  // Mark as scanning
  await supabase
    .from('prescan_queue')
    .update({ status: 'scanning', started_at: new Date().toISOString() })
    .eq('id', pending.id);

  await loadPrescanQueue();

  try {
    // Start the crawl
    const result = await callEdgeFunction('crawl-sharepoint', {
      url: pending.site_url,
      folderPath: pending.folder_path
    });

    // Update queue with scan ID
    await supabase
      .from('prescan_queue')
      .update({
        scan_id: result.scanId,
        status: 'complete',
        completed_at: new Date().toISOString()
      })
      .eq('id', pending.id);

  } catch (err) {
    await supabase
      .from('prescan_queue')
      .update({
        status: 'error',
        error_message: err.message,
        completed_at: new Date().toISOString()
      })
      .eq('id', pending.id);
  }

  await loadPrescanQueue();

  // Process next item
  startPrescan();
}

function setupEventListeners() {
  addAdminBtn.addEventListener('click', addAdmin);
  newAdminEmail.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addAdmin();
  });

  scanForLargeFoldersBtn.addEventListener('click', scanForLargeFolders);
  prescanSiteUrl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') scanForLargeFolders();
  });

  // Poll for queue updates
  setInterval(loadPrescanQueue, 10000);
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
init();
