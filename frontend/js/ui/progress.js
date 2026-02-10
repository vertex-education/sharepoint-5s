/**
 * Progress Component
 * Shows crawl/analysis progress with animated progress bar.
 * Supports chunked crawling by calling continue-crawl for large sites.
 */

/**
 * Render the progress section.
 * @param {HTMLElement} container
 * @param {{ status: string, crawl_progress: number, total_files: number, total_folders: number, total_size_bytes: number, error_message?: string, remaining?: number }} data
 */
export function renderProgress(container, data) {
  const remainingText = data.remaining ? ` (${data.remaining} folders remaining)` : '';
  const statusLabels = {
    pending: 'Preparing...',
    crawling: `Crawling... ${data.total_files.toLocaleString()} files found${remainingText}`,
    crawled: 'Crawl complete. Starting analysis...',
    analyzing: 'Analyzing files with AI...',
    complete: 'Analysis complete!',
    error: `Error: ${data.error_message || 'Unknown error'}`,
  };

  const isActive = ['crawling', 'analyzing'].includes(data.status);
  const isError = data.status === 'error';
  const progress = data.status === 'analyzing' ? 100 : (data.crawl_progress || 0);

  container.innerHTML = `
    <div class="progress animate-fade-in-up">
      <div class="progress__bar-container">
        <div
          class="progress__bar ${isActive ? 'progress__bar--striped' : ''}"
          style="width: ${progress}%; ${isError ? 'background: var(--accent-delete);' : ''}"
        ></div>
      </div>
      <div class="progress__text">
        <span class="progress__status" style="${isError ? 'color: var(--accent-delete);' : ''}">
          ${statusLabels[data.status] || data.status}
        </span>
        <span>${progress}%</span>
      </div>
      ${data.total_files > 0 ? `
        <div style="display:flex;gap:var(--space-6);justify-content:center;margin-top:var(--space-4);font-family:var(--font-mono);font-size:var(--text-sm);color:var(--text-secondary);">
          <span>${data.total_files.toLocaleString()} files</span>
          <span>${data.total_folders.toLocaleString()} folders</span>
          <span>${formatBytes(data.total_size_bytes)}</span>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Start polling for crawl/analysis status.
 * For chunked crawls, this also triggers continue-crawl to keep processing folders.
 * @param {string} scanId
 * @param {HTMLElement} container
 * @param {(status: object) => void} onStatusChange
 * @param {() => void} onComplete
 * @returns {{ stop: () => void }}
 */
export function startPolling(scanId, container, { onStatusChange, onComplete, onError }) {
  let active = true;
  let interval = 2000;
  let isContinuing = false; // Prevent overlapping continue-crawl calls

  async function poll() {
    if (!active) return;

    try {
      // Import dynamically to avoid circular deps
      const { getCrawlStatus, continueCrawl } = await import('../api.js');

      // First check current status
      const status = await getCrawlStatus(scanId);

      // If we're in crawling state and not already continuing, trigger continue-crawl
      // This keeps the chunked crawl moving forward for large sites
      if (status.status === 'crawling' && !isContinuing) {
        isContinuing = true;
        try {
          const continueResult = await continueCrawl(scanId);
          console.log('[Progress] Continue crawl result:', continueResult);

          // Use the continue result for the most up-to-date data
          renderProgress(container, {
            ...status,
            crawl_progress: continueResult.crawl_progress,
            total_files: continueResult.total_files,
            total_folders: continueResult.total_folders,
            total_size_bytes: continueResult.total_size_bytes,
            remaining: continueResult.remaining,
            status: continueResult.status,
          });

          // If continue-crawl finished the job, notify and exit
          if (continueResult.done && continueResult.status === 'crawled') {
            onStatusChange?.({ status: 'crawled' });
          } else if (continueResult.status === 'complete') {
            active = false;
            onComplete?.();
            isContinuing = false;
            return;
          }
        } catch (err) {
          console.error('[Progress] Continue crawl error:', err);
        }
        isContinuing = false;
      } else {
        // For non-crawling states, just render the current status
        renderProgress(container, status);
      }

      onStatusChange?.(status);

      if (status.status === 'complete') {
        active = false;
        onComplete?.();
        return;
      }

      if (status.status === 'error') {
        active = false;
        onError?.(status.error_message);
        return;
      }

      // Adaptive polling: faster during crawling to keep chunks moving, slower during analysis
      interval = status.status === 'crawling' ? 1500 : 5000;
      setTimeout(poll, interval);

    } catch (err) {
      console.error('Poll error:', err);
      isContinuing = false;
      if (active) setTimeout(poll, 5000);
    }
  }

  poll();

  return {
    stop() { active = false; },
  };
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
