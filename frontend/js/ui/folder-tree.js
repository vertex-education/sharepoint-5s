/**
 * Folder Tree — Pure Logic Module
 * Builds a nested folder hierarchy from flat crawled_files data + suggestions.
 * No DOM manipulation — data only.
 */

/**
 * Build a folder tree from flat folder records and suggestions.
 * @param {Array} folders - Array of { id, name, path, depth, parent_item_id }
 * @param {Array} suggestions - Array of suggestion objects with crawled_files.path
 * @returns {object} Root tree node
 */
export function buildFolderTree(folders, suggestions) {
  // Root node
  const root = {
    name: '/',
    path: '/',
    depth: 0,
    children: [],
    directCounts: { delete: 0, archive: 0, rename: 0, structure: 0, total: 0 },
    rollupCounts: { delete: 0, archive: 0, rename: 0, structure: 0, total: 0 },
  };

  // Index folders by path for quick lookup
  const nodeMap = new Map();
  nodeMap.set('/', root);

  // Sort folders by depth so parents are created before children
  const sorted = [...folders].sort((a, b) => a.depth - b.depth);

  for (const folder of sorted) {
    const node = {
      name: folder.name,
      path: folder.path,
      depth: folder.depth,
      children: [],
      directCounts: { delete: 0, archive: 0, rename: 0, structure: 0, total: 0 },
      rollupCounts: { delete: 0, archive: 0, rename: 0, structure: 0, total: 0 },
    };
    nodeMap.set(folder.path, node);

    // Find parent by trimming path
    const parentPath = getParentPath(folder.path);
    const parent = nodeMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      // If parent not found, attach to root
      root.children.push(node);
    }
  }

  // Assign suggestion counts to the containing folder
  for (const s of suggestions) {
    const filePath = s.crawled_files?.path || s.current_value || '';
    const folderPath = getContainingFolder(filePath);
    const category = s.category;

    const node = nodeMap.get(folderPath);
    if (node && node.directCounts.hasOwnProperty(category)) {
      node.directCounts[category]++;
      node.directCounts.total++;
    } else {
      // File's folder not in tree — count at root
      if (root.directCounts.hasOwnProperty(category)) {
        root.directCounts[category]++;
        root.directCounts.total++;
      }
    }
  }

  // Roll up counts from leaves to root (post-order traversal)
  rollUp(root);

  return root;
}

/**
 * Get immediate children folder nodes for a given path in the tree.
 * @param {object} tree - Root tree node
 * @param {string} path - Folder path to look up
 * @returns {Array} Child folder nodes
 */
export function getFolderChildren(tree, path) {
  const node = findNode(tree, path);
  if (!node) return [];
  return node.children;
}

/**
 * Get the rollup counts for a given folder path.
 * @param {object} tree - Root tree node
 * @param {string} path - Folder path
 * @returns {object|null} Rollup counts or null
 */
export function getFolderCounts(tree, path) {
  const node = findNode(tree, path);
  return node ? node.rollupCounts : null;
}

/**
 * Split a path into breadcrumb segments.
 * @param {string} path - e.g. "/Documents/HR/Onboarding/"
 * @returns {Array<{name: string, path: string}>}
 */
export function getFolderBreadcrumb(path) {
  if (!path || path === '/') {
    return [{ name: 'All', path: '/' }];
  }

  const segments = [{ name: 'All', path: '/' }];
  const parts = path.split('/').filter(Boolean);
  let accumulated = '/';

  for (const part of parts) {
    accumulated += part + '/';
    segments.push({ name: part, path: accumulated });
  }

  return segments;
}

// ── Internal helpers ──

function getParentPath(folderPath) {
  // "/Documents/HR/Onboarding/" → "/Documents/HR/"
  const trimmed = folderPath.replace(/\/$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return trimmed.substring(0, lastSlash + 1);
}

function getContainingFolder(filePath) {
  if (!filePath) return '/';
  // If path ends with /, it IS a folder — use its parent for folder-level suggestions
  // If path doesn't end with /, it's a file — get its containing folder
  const isFolder = filePath.endsWith('/');
  if (isFolder) {
    // For folder-level suggestions (e.g., "spaces in folder name"),
    // count them in the parent folder so they appear when browsing the parent
    return getParentPath(filePath);
  }
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return filePath.substring(0, lastSlash + 1);
}

function rollUp(node) {
  // Start with direct counts
  node.rollupCounts.delete = node.directCounts.delete;
  node.rollupCounts.archive = node.directCounts.archive;
  node.rollupCounts.rename = node.directCounts.rename;
  node.rollupCounts.structure = node.directCounts.structure;
  node.rollupCounts.total = node.directCounts.total;

  for (const child of node.children) {
    rollUp(child);
    node.rollupCounts.delete += child.rollupCounts.delete;
    node.rollupCounts.archive += child.rollupCounts.archive;
    node.rollupCounts.rename += child.rollupCounts.rename;
    node.rollupCounts.structure += child.rollupCounts.structure;
    node.rollupCounts.total += child.rollupCounts.total;
  }
}

function findNode(tree, path) {
  if (tree.path === path) return tree;
  for (const child of tree.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
