// utils.js — Shared utility functions for LYS OPS Tracker
// Must be loaded before dashboard.js and project.js

// ---------------------------------------------------------------------------
// API fetch wrapper
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== undefined && body !== null) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch (_) { /* ignore parse errors */ }
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
function fmtCurrency(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0';
  return '$' + Math.round(n).toLocaleString('en-SG');
}

function fmtCurrencyShort(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '0.0%';
  return parseFloat(n).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
function statusBadge(status) {
  const map = {
    'On Track':                'badge-green',
    'Completed':               'badge-grey',
    'Delayed':                 'badge-red',
    'On Hold':                 'badge-amber',
    'Pending':                 'badge-amber',
    'In Progress':             'badge-blue',
    'Done':                    'badge-green',
    'Not Started':             'badge-grey',
    'Not Submitted':           'badge-grey',
    'Submitted for Approval':  'badge-amber',
    'Approved':                'badge-green',
    'Rejected':                'badge-red'
  };
  const cls = map[status] || 'badge-grey';
  const escaped = (status || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="badge ${cls}">${escaped}</span>`;
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = msg;
  toast.className = 'toast' + (type ? ' ' + type : '') + ' show';

  clearTimeout(toast._hideTimeout);
  toast._hideTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function fmtDate(str) {
  if (!str) return '';
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day   = String(d.getUTCDate()).padStart(2, '0');
  const month = months[d.getUTCMonth()];
  const year  = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function slugify(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Delete confirmation with reason — returns Promise<{reason}> or null if cancelled
// Usage: const result = await confirmDelete('Remove this document?');
//        if (!result) return; // cancelled
//        console.log(result.reason); // e.g. "Duplicate entry"
// ---------------------------------------------------------------------------
const DELETE_REASONS = [
  'Duplicate entry',
  'Created by mistake',
  'No longer needed',
  'Replaced by another',
  'Data entered wrongly',
  'Client / scope change',
  'Other',
];

function confirmDelete(title, itemName) {
  // Self-contained escape — works on pages that don't load utils.js
  const _esc = typeof escHtml === 'function' ? escHtml : (typeof esc === 'function' ? esc : function(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); });

  return new Promise(resolve => {
    const old = document.getElementById('delete-reason-modal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'delete-reason-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;max-width:400px;width:100%;">' +
        '<div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">' + _esc(title || 'Confirm Delete') + '</div>' +
        (itemName ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">' + _esc(itemName) + '</div>' : '<div style="margin-bottom:12px;"></div>') +
        '<div style="margin-bottom:12px;">' +
          '<label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:4px;">Reason for deletion</label>' +
          '<select id="delete-reason-select" style="width:100%;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px;">' +
            '<option value="">-- Select a reason --</option>' +
            DELETE_REASONS.map(r => '<option value="' + _esc(r) + '">' + _esc(r) + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div id="delete-reason-error" style="display:none;font-size:12px;color:var(--red);margin-bottom:8px;">Please select a reason.</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button type="button" id="delete-cancel-btn" class="btn btn-ghost" style="padding:8px 16px;">Cancel</button>' +
          '<button type="button" id="delete-confirm-btn" class="btn btn-primary" style="padding:8px 16px;background:var(--red);border-color:var(--red);">Delete</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    const sel = overlay.querySelector('#delete-reason-select');
    const errDiv = overlay.querySelector('#delete-reason-error');
    const confirmBtn = overlay.querySelector('#delete-confirm-btn');
    const cancelBtn = overlay.querySelector('#delete-cancel-btn');

    const cleanup = () => overlay.remove();

    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });

    confirmBtn.addEventListener('click', () => {
      if (!sel.value) { errDiv.style.display = 'block'; sel.focus(); return; }
      const reason = sel.value;
      cleanup();
      resolve({ reason });
    });

    sel.focus();
  });
}
