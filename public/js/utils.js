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
