/* ─────────────────────────────────────────────
   project.js  —  LYS OPS Tracker  —  Project Detail
   ───────────────────────────────────────────── */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let project = null;
const params = new URLSearchParams(window.location.search);
const projectId = params.get('id');

if (!projectId) {
  alert('No project ID specified.');
  window.location.href = 'index.html';
}

// ── Default document definitions ────────────────────────────────────────────
const DEFAULT_DOCUMENTS = [
  { name: 'Risk Assessment',       group: 'Safety Documents', allowMultiple: false },
  { name: 'Method Statement',      group: 'Safety Documents', allowMultiple: true  },
  { name: 'Safe Work Procedure',   group: 'Safety Documents', allowMultiple: false },
  { name: 'Name List',             group: 'Safety Documents', allowMultiple: false },
  { name: 'Permit to Work (PTW)',  group: 'Safety Documents', allowMultiple: true  },
  { name: 'Letter of Appointment', group: 'Safety Documents', allowMultiple: true  },
  { name: 'Lifting Plan',          group: 'Safety Documents', allowMultiple: false },
  { name: 'Fall Prevention Plan',  group: 'Safety Documents', allowMultiple: false },
  { name: 'Schedule Submission',   group: 'Submissions',      allowMultiple: false },
  { name: 'SIC Submission',        group: 'Submissions',      allowMultiple: false },
];

// ── Utility: save debounce ──────────────────────────────────────────────────
const debouncedSave = debounce(saveProject, 300);

// ── Staff map (for email lookup) ────────────────────────────────────────────
let staffMap = {};

function lookupEmail(ownerName) {
  if (!ownerName) return null;
  const entry = staffMap[ownerName];
  return entry ? entry.email : null;
}

function populateStaffDatalist(map) {
  // Build unique staff name list
  const names = new Set();
  Object.values(map).forEach(v => { if (v.name) names.add(v.name); });
  const sortedNames = [...names].sort();

  // Populate datalist (for stage owner / actionBy free-text fields)
  const dl = document.getElementById('staff-list');
  if (dl) dl.innerHTML = sortedNames.map(n => `<option value="${escHtml(n)}">`).join('');

  // Populate all <select> dropdowns (team + actionBy)
  const teamFields = ['projectManager','qs','factoryManager','drafter','purchaser','sales','siteEngineer'];
  const optionsHtml = '<option value="">— Select —</option>' +
    sortedNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  teamFields.forEach(key => {
    const sel = document.getElementById(`field-${key}`);
    if (sel) sel.innerHTML = optionsHtml;
  });
}

// ── Helper: staff name options HTML ─────────────────────────────────────────
function staffOptionsHtml(selected) {
  const names = new Set();
  Object.values(staffMap).forEach(v => { if (v.name) names.add(v.name); });
  return '<option value="">— Select —</option>' +
    [...names].sort().map(n =>
      `<option value="${escHtml(n)}"${n === selected ? ' selected' : ''}>${escHtml(n)}</option>`
    ).join('');
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [proj, staff] = await Promise.all([
      api('GET', `/api/projects/${projectId}`),
      api('GET', '/api/staff'),
    ]);
    project = proj;
    staffMap = staff || {};
    populateStaffDatalist(staffMap);
    ensureStages();
    ensureDocuments();
    renderAll();
    bindHeaderEvents();
    bindTabEvents();
  } catch (err) {
    console.error('[LYS OPS] Load failed:', err);
    const page = document.querySelector('.page');
    if (page) page.innerHTML = `
      <div style="padding:40px; text-align:center; color:var(--red);">
        <div style="font-size:24px; margin-bottom:12px;">⚠️</div>
        <div style="font-size:16px; font-weight:600; margin-bottom:8px;">Failed to load project</div>
        <div style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">${err.message}</div>
        <a href="index.html" class="btn btn-primary">← Back to Dashboard</a>
      </div>
    `;
  }
}

function ensureStages() {
  if (!Array.isArray(project.stages)) project.stages = [];
  // Ensure refs array exists on all stages
  project.stages.forEach(s => { if (!Array.isArray(s.refs)) s.refs = []; });
}

function ensureDocuments() {
  if (!Array.isArray(project.documents) || project.documents.length === 0) {
    project.documents = DEFAULT_DOCUMENTS.map(d => ({
      name: d.name,
      status: 'Not Submitted',
      submitted: '',
      approved: '',
      notes: '',
    }));
  } else {
    DEFAULT_DOCUMENTS.forEach(def => {
      const existing = project.documents.find(d => d.name === def.name);
      if (!existing) {
        project.documents.push({
          name: def.name,
          status: 'Not Submitted',
          submitted: '',
          approved: '',
          notes: '',
        });
      }
    });
  }
}

// ── Project Timeline bar ─────────────────────────────────────────────────────
function renderProjectTimeline() {
  const el = document.getElementById('project-timeline-display');
  if (!el) return;
  const start = project.startDate ? new Date(project.startDate) : null;
  const end   = project.endDate   ? new Date(project.endDate)   : null;
  const today = new Date();

  if (!start || !end || isNaN(start) || isNaN(end)) {
    el.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">Set start and end date to see timeline</span>';
    return;
  }

  const totalDays = Math.round((end - start) / 86400000);
  const elapsed   = Math.round((today - start) / 86400000);
  const pct       = Math.min(Math.max(Math.round(elapsed / totalDays * 100), 0), 100);
  const isOverdue = today > end;
  const daysLeft  = Math.round((end - today) / 86400000);
  const months    = Math.round(totalDays / 30);
  const durationStr = months >= 2 ? `${months} months` : `${totalDays} days`;
  const color  = isOverdue ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)';
  const label  = isOverdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d remaining`;

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-bottom:4px;">
      <span>${start.toLocaleDateString('en-SG', {day:'numeric',month:'short',year:'numeric'})}</span>
      <span style="color:${color}; font-weight:600;">${label}</span>
      <span>${end.toLocaleDateString('en-SG', {day:'numeric',month:'short',year:'numeric'})}</span>
    </div>
    <div class="progress-bar" style="height:8px; position:relative;">
      <div class="progress-fill" style="width:${pct}%; background:${color};"></div>
      <div style="position:absolute; top:-2px; left:${pct}%; transform:translateX(-50%); width:3px; height:12px; background:${color}; border-radius:2px;"></div>
    </div>
    <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Duration: ${durationStr} · ${pct}% elapsed</div>
  `;
}

// ── Render everything ───────────────────────────────────────────────────────
function renderAll() {
  renderTopbar();
  renderHeader();
  renderFinBar();
  renderFields();
  renderDocuments();
  renderDrawings();
  renderProjectTimeline();
  renderFabrication();
  renderInstallation();
  renderDeliveryRequestsTab();
  renderPayment();
  renderMeetings();
  renderSummaryTab();
}

// ── Topbar ──────────────────────────────────────────────────────────────────
function renderTopbar() {
  document.getElementById('topbar-name').textContent =
    `${project.jobCode || '—'}  ${project.projectName || ''}`;
  document.getElementById('topbar-badge').innerHTML =
    statusBadge(project.status || 'On Track');
}

// ── Project Header ──────────────────────────────────────────────────────────
function renderHeader() {
  document.getElementById('header-jobcode').value = project.jobCode || '';
  document.getElementById('header-name').value = project.projectName || '';
  document.title = `${project.jobCode || 'Project'} — LYS OPS`;

  const sel = document.getElementById('field-status');
  sel.value = project.status || 'On Track';
  applyStatusColour(sel);
}

function applyStatusColour(sel) {
  sel.classList.remove('status-ontrack','status-delayed','status-onhold','status-completed');
  const map = { 'On Track':'status-ontrack', 'Delayed':'status-delayed', 'On Hold':'status-onhold', 'Completed':'status-completed' };
  if (map[sel.value]) sel.classList.add(map[sel.value]);
}

function bindHeaderEvents() {
  // Editable Job Code
  document.getElementById('header-jobcode').addEventListener('input', function () {
    project.jobCode = this.value;
    renderTopbar();
    debouncedSave();
  });

  // Editable Project Name
  document.getElementById('header-name').addEventListener('input', function () {
    project.projectName = this.value;
    renderTopbar();
    debouncedSave();
  });

  document.getElementById('field-status').addEventListener('change', function () {
    project.status = this.value;
    applyStatusColour(this);
    renderTopbar();
    saveProject();
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    // Check if PIN is configured
    const pinStatus = await api('GET', '/api/admin/pin');
    if (!pinStatus.pinSet) {
      alert('Admin PIN not configured. Please set one in Admin Settings (⚙) before deleting projects.');
      return;
    }
    showPinModal(async (pin) => {
      const result = await api('POST', '/api/admin/pin', { action: 'verify', pin });
      if (!result.ok) return false;
      await api('DELETE', `/api/projects/${projectId}`, { pin });
      window.location.href = 'index.html';
      return true;
    });
  });
}

// ── PIN Modal ────────────────────────────────────────────────────────────────
function showPinModal(onConfirm) {
  const modal   = document.getElementById('pin-modal');
  const input   = document.getElementById('pin-input');
  const errDiv  = document.getElementById('pin-error');
  const confirm = document.getElementById('pin-confirm');
  const cancel  = document.getElementById('pin-cancel');

  input.value = '';
  errDiv.style.display = 'none';
  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 50);

  const cleanup = () => { modal.style.display = 'none'; confirm.removeEventListener('click', doConfirm); cancel.removeEventListener('click', doCancel); };

  const doConfirm = async () => {
    const pin = input.value.trim();
    if (!/^\d{4}$/.test(pin)) { errDiv.textContent = 'Enter a 4-digit PIN.'; errDiv.style.display = 'block'; return; }
    confirm.disabled = true;
    confirm.textContent = '…';
    try {
      const ok = await onConfirm(pin);
      if (ok === false) { errDiv.textContent = 'Incorrect PIN.'; errDiv.style.display = 'block'; confirm.disabled = false; confirm.textContent = 'Delete Project'; }
      else { cleanup(); }
    } catch (err) { errDiv.textContent = 'Error. Try again.'; errDiv.style.display = 'block'; confirm.disabled = false; confirm.textContent = 'Delete Project'; }
  };
  const doCancel = () => cleanup();

  confirm.addEventListener('click', doConfirm, { once: true });
  cancel.addEventListener('click', doCancel, { once: true });
  modal.addEventListener('click', e => { if (e.target === modal) doCancel(); }, { once: true });

  // Note: closing brace for bindHeaderEvents is removed — we now close it above
  // This is intentional — showPinModal is a standalone function
}

// ── Financial Bar ───────────────────────────────────────────────────────────
function renderFinBar() {
  const cv    = Number(project.contractValue) || 0;
  const vv    = Number(project.voValue)       || 0;
  const total = cv + vv;

  // ── Live calculations from sub-arrays (never stale) ──────────────────────
  // paidAmount: sum of Paid milestones
  const milestones = project.paymentMilestones || [];
  const pa = milestones
    .filter(m => m.status === 'Paid' || m.paid === true)
    .reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);
  project.paidAmount = pa; // keep in sync

  // fabPercent: live from fabrication rows
  const fabRows  = project.fabrication || [];
  const fabTotal = fabRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const fabDone  = fabRows.reduce((s, r) => s + (parseFloat(r.qtyDone)  || 0), 0);
  const fabPct   = fabTotal > 0 ? Math.round(fabDone / fabTotal * 100) : 0;
  project.fabPercent = fabPct;

  // installPercent: live from installation rows
  const instRows  = project.installation || [];
  const instTotal = instRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const instDone  = instRows.reduce((s, r) => s + (parseFloat(r.doneQty)  || 0), 0);
  const instPct   = instTotal > 0 ? Math.round(instDone / instTotal * 100) : 0;
  project.installPercent = instPct;

  const claimPct = total > 0 ? (pa / total * 100) : 0;

  document.getElementById('fin-contract').textContent  = fmtCurrency(cv);
  document.getElementById('fin-vo').textContent        = fmtCurrency(vv);
  document.getElementById('fin-total').textContent     = fmtCurrency(total);
  document.getElementById('fin-paid').textContent      = fmtCurrency(pa);
  document.getElementById('fin-claimpct').textContent  = fmtPct(claimPct);
  document.getElementById('fin-fabpct').textContent    = fmtPct(fabPct);
  document.getElementById('fin-installpct').textContent = fmtPct(instPct);

  const fabBarEl  = document.getElementById('fin-fab-bar');
  if (fabBarEl)  fabBarEl.style.width  = fabPct  + '%';
  const instBarEl = document.getElementById('fin-install-bar');
  if (instBarEl) instBarEl.style.width = instPct + '%';
}

// ── Main Info Fields ─────────────────────────────────────────────────────────
function renderFields() {
  // paidAmount is excluded — it's derived from payment milestones, not user-editable
  const textFields = [
    'client', 'contact', 'mainCon', 'consultant',
    'startDate', 'endDate', 'contractValue', 'voValue',
    'fabLeadTimeDays',
    'projectManager', 'qs', 'factoryManager', 'drafter',
    'purchaser', 'sales', 'siteEngineer',
    'latestNotes',
  ];
  textFields.forEach(key => {
    const el = document.getElementById(`field-${key}`);
    if (el) el.value = project[key] != null ? project[key] : '';
  });

  // Product scope table + scope notes
  renderProductScope();
  const sn = document.getElementById('field-scopeNotes');
  if (sn) {
    sn.value = project.scopeNotes || '';
    sn.addEventListener('input', () => { project.scopeNotes = sn.value; debouncedSave(); });
  }

  // Bind change events
  textFields.forEach(key => {
    const el = document.getElementById(`field-${key}`);
    if (!el) return;
    const isText = el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number';
    if (isText) {
      el.addEventListener('input', () => {
        project[key] = el.type === 'number' ? Number(el.value) || 0 : el.value;
        if (key === 'contractValue' || key === 'voValue') renderFinBar();
        debouncedSave();
      });
    } else {
      el.addEventListener('change', () => {
        project[key] = el.value;
        if (key === 'startDate' || key === 'endDate') renderProjectTimeline();
        debouncedSave();
      });
    }
  });
}

// ── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.proj-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.proj-tab-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.classList.add('active');
  if (tab === 'summary') renderSummaryTab();
  if (tab === 'payment') renderClaimsTab();
  if (tab === 'history') renderHistoryTab();
  // Save to URL hash so refresh restores the same tab
  history.replaceState(null, '', '#' + tab);
}

function bindTabEvents() {
  document.querySelectorAll('.proj-tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // On load, restore tab from URL hash
  const hash = location.hash.replace('#', '');
  const validTabs = ['overview','fabrication','installation','payment','documents','summary','info','drawings','delivery','meetings','history'];
  if (hash && validTabs.includes(hash)) {
    switchTab(hash);
  }
}

// ── Summary Tab ──────────────────────────────────────────────────────────────
async function renderSummaryTab() {
  const container = document.getElementById('tab-summary');
  if (!container) return;
  // Always paint a loading state so the tab is never mysteriously blank.
  container.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-size:13px;">Loading summary…</div>';
  if (!project) {
    container.innerHTML = '<div style="padding:24px;color:var(--red);font-size:13px;">Project data not loaded.</div>';
    return;
  }
  try {
    await _renderSummaryTabInner(container);
  } catch (err) {
    console.error('[renderSummaryTab] failed:', err);
    container.innerHTML = _renderSummaryFallback(err);
    container.querySelectorAll('[data-retry-summary]').forEach(b =>
      b.addEventListener('click', () => renderSummaryTab())
    );
  }
}

function _renderSummaryFallback(err) {
  const p = project || {};
  const cv   = parseFloat(p.contractValue) || 0;
  const vo   = parseFloat(p.voValue)       || 0;
  const paid = parseFloat(p.paidAmount)    || 0;
  const claimsPct = (cv + vo) > 0 ? Math.round(paid / (cv + vo) * 100) : 0;
  const fabPct  = Number.isFinite(+p.fabPercent)     ? Math.round(+p.fabPercent)     : 0;
  const instPct = Number.isFinite(+p.installPercent) ? Math.round(+p.installPercent) : 0;
  const stages = Array.isArray(p.stages) ? p.stages : [];
  const stagesDone = stages.filter(s => s.status === 'Completed').length;
  const stagesList = stages.map(s => {
    const color = s.status === 'Completed'   ? 'var(--green)'
               : s.status === 'In Progress' ? 'var(--accent)'
               : 'var(--text-muted)';
    return `<li style="padding:4px 0;color:${color};font-size:12px;">
      <strong>${escHtml(s.name || '—')}</strong>
      <span style="color:var(--text-muted);margin-left:6px;">${escHtml(s.status || '—')}</span>
    </li>`;
  }).join('');
  return `
    <div style="padding:8px;">
      <div style="background:rgba(226,68,92,0.08);border:1px solid rgba(226,68,92,0.3);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:700;color:var(--red);margin-bottom:4px;">⚠️ Summary rendering error</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">${escHtml(err && err.message || String(err))}</div>
        <button data-retry-summary style="font-size:11px;padding:4px 12px;border-radius:12px;background:var(--bg3);border:1px solid var(--border);color:var(--text);cursor:pointer;">↻ Retry</button>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Project Health</div>
        <div style="font-size:13px;line-height:1.9;">
          <div>Status: <strong>${escHtml(p.status || 'On Track')}</strong></div>
          <div>Contract Value: <strong>$${cv.toLocaleString()}</strong>${vo ? ' <span style="color:var(--text-muted);">(+ VO $' + vo.toLocaleString() + ')</span>' : ''}</div>
          <div>Claims: <strong>${claimsPct}%</strong> <span style="color:var(--text-muted);">($${(paid/1000).toFixed(0)}k paid)</span></div>
          <div>Fabrication: <strong>${fabPct}%</strong></div>
          <div>Installation: <strong>${instPct}%</strong></div>
        </div>
      </div>
      ${p.latestNotes ? `
        <div class="card" style="margin-bottom:14px;">
          <div class="section-label">Latest Notes</div>
          <div style="font-size:13px;white-space:pre-wrap;line-height:1.5;">${escHtml(p.latestNotes)}</div>
        </div>` : ''}
      ${stages.length ? `
        <div class="card" style="margin-bottom:14px;">
          <div class="section-label">Stages (${stagesDone}/${stages.length} done)</div>
          <ul style="list-style:none;padding:0;margin:0;">${stagesList}</ul>
        </div>` : ''}
    </div>`;
}

async function _renderSummaryTabInner(container) {
  const fabRows     = project.fabrication   || [];
  const installRows = project.installation || [];
  const cv   = parseFloat(project.contractValue) || 0;
  const vo   = parseFloat(project.voValue)       || 0;
  const paid = parseFloat(project.paidAmount)    || 0;
  const claimsPct = (cv + vo) > 0 ? Math.round(paid / (cv + vo) * 100) : 0;

  const activeStageForSummary = (project.stages || []).find(s => s.status === 'In Progress')
    || (project.stages || []).find(s => s.status === 'Not Started');
  const nextActionOwner = activeStageForSummary ? (activeStageForSummary.owner || '—') : '—';
  const currentStageName = activeStageForSummary ? activeStageForSummary.name : 'All stages complete';

  // ── Fabrication Pipeline HTML ────────────────────────────────────────────
  const fabPipelineHtml = (() => {
    const STEPS = ['Not Started', 'In Progress', 'QC Check', 'Ready for Delivery', 'Delivered'];
    const stepColors = {
      'Not Started':       { bg: 'rgba(107,114,148,0.15)', color: 'var(--text-muted)', border: 'rgba(107,114,148,0.3)' },
      'In Progress':       { bg: 'rgba(51,102,255,0.15)',  color: 'var(--accent)',     border: 'var(--accent)' },
      'QC Check':          { bg: 'rgba(217,119,6,0.15)',   color: 'var(--amber)',      border: 'var(--amber)' },
      'Ready for Delivery':{ bg: 'rgba(16,185,129,0.15)',  color: 'var(--green)',      border: 'var(--green)' },
      'Delivered':         { bg: 'rgba(16,185,129,0.22)',  color: 'var(--green)',      border: 'var(--green)' },
    };
    if (!fabRows.length) {
      return `
        <div class="card" style="margin-bottom:14px;">
          <div class="section-label">Fabrication Pipeline</div>
          <div style="font-size:12px;color:var(--text-muted);padding:6px 0;">
            No FAB items yet — add in <button class="btn btn-ghost btn-sm" onclick="switchTab('info')" style="font-size:11px;padding:2px 8px;">Product Scope tab →</button>
          </div>
        </div>`;
    }
    const rows = fabRows.map(r => {
      const current = r.status || 'Not Started';
      const curIdx = STEPS.indexOf(current) === -1
        ? (current === 'Completed' ? 4 : 0)
        : STEPS.indexOf(current);
      const chips = STEPS.map((step, i) => {
        const active = i === curIdx;
        const passed = i < curIdx;
        const c = active ? stepColors[step] : passed
          ? { bg: 'rgba(16,185,129,0.08)', color: 'rgba(16,185,129,0.6)', border: 'rgba(16,185,129,0.25)' }
          : { bg: 'transparent', color: 'var(--text-muted)', border: 'rgba(255,255,255,0.1)' };
        return `<span style="display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:${active?'700':'400'};background:${c.bg};color:${c.color};border:1px solid ${c.border};white-space:nowrap;">${step}</span>`;
      });
      const arrows = chips.flatMap((s, i) =>
        i < chips.length - 1 ? [s, `<span style="color:rgba(255,255,255,0.2);font-size:10px;">›</span>`] : [s]
      );
      return `
        <div style="margin-bottom:10px;">
          <div style="font-size:12px;font-weight:600;margin-bottom:5px;color:var(--text);">
            ${escHtml(r.item||'Item')}
            <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px;">
              Qty: ${r.totalQty||'—'}${r.unit ? ' ' + escHtml(r.unit) : ''}
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${arrows.join('')}</div>
        </div>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Fabrication Pipeline</div>
        ${rows}
      </div>`;
  })();

  // ── Installation Pipeline HTML ───────────────────────────────────────────
  const installPipelineHtml = (() => {
    const STEPS = ['Not Started', 'In Progress', 'Installed', 'Verified'];
    const stepColors = {
      'Not Started': { bg: 'rgba(107,114,148,0.15)', color: 'var(--text-muted)', border: 'rgba(107,114,148,0.3)' },
      'In Progress': { bg: 'rgba(51,102,255,0.15)',  color: 'var(--accent)',     border: 'var(--accent)' },
      'Installed':   { bg: 'rgba(16,185,129,0.15)',  color: 'var(--green)',      border: 'var(--green)' },
      'Verified':    { bg: 'rgba(16,185,129,0.22)',  color: 'var(--green)',      border: 'var(--green)' },
    };
    if (!installRows.length) {
      return `
        <div class="card" style="margin-bottom:14px;">
          <div class="section-label">Installation Pipeline</div>
          <div style="font-size:12px;color:var(--text-muted);padding:6px 0;">No installation items yet</div>
        </div>`;
    }
    const rows = installRows.map(r => {
      const total = parseFloat(r.totalQty) || 0;
      const done  = parseFloat(r.doneQty)  || 0;
      let curIdx;
      if (r.status && STEPS.indexOf(r.status) !== -1)      curIdx = STEPS.indexOf(r.status);
      else if (total > 0 && done >= total)                 curIdx = 2;
      else if (done > 0)                                   curIdx = 1;
      else                                                 curIdx = 0;
      const chips = STEPS.map((step, i) => {
        const active = i === curIdx;
        const passed = i < curIdx;
        const c = active ? stepColors[step] : passed
          ? { bg: 'rgba(16,185,129,0.08)', color: 'rgba(16,185,129,0.6)', border: 'rgba(16,185,129,0.25)' }
          : { bg: 'transparent', color: 'var(--text-muted)', border: 'rgba(255,255,255,0.1)' };
        return `<span style="display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:${active?'700':'400'};background:${c.bg};color:${c.color};border:1px solid ${c.border};white-space:nowrap;">${step}</span>`;
      });
      const arrows = chips.flatMap((s, i) =>
        i < chips.length - 1 ? [s, `<span style="color:rgba(255,255,255,0.2);font-size:10px;">›</span>`] : [s]
      );
      return `
        <div style="margin-bottom:10px;">
          <div style="font-size:12px;font-weight:600;margin-bottom:5px;color:var(--text);">
            ${escHtml(r.item||'Item')}
            <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:6px;">
              ${done} / ${total}${r.unit ? ' ' + escHtml(r.unit) : ''}
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${arrows.join('')}</div>
        </div>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Installation Pipeline</div>
        ${rows}
      </div>`;
  })();

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <span style="font-size:11px; color:var(--text-muted);">Summary</span>
      <button class="btn btn-ghost btn-sm" onclick="switchTab('info')" style="font-size:12px;">Edit Project Info →</button>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <div class="section-label">Overview</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px 14px;font-size:12px;margin-bottom:10px;">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Contract</div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">$${cv.toLocaleString()}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">VO</div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">$${vo.toLocaleString()}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Claims</div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">${claimsPct}%</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">$${(paid/1000).toFixed(0)}k / $${((cv+vo)/1000).toFixed(0)}k</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Current Stage</div>
          <div style="font-size:13px;font-weight:600;color:var(--accent);">${escHtml(currentStageName)}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">Next: ${escHtml(nextActionOwner)}</div>
        </div>
      </div>
    </div>

    ${fabPipelineHtml}

    ${installPipelineHtml}

    ${project.latestNotes ? `
    <div class="card" style="margin-bottom:14px;">
      <div class="section-label">Latest Notes</div>
      <div style="font-size:13px;white-space:pre-wrap;line-height:1.5;color:var(--text);">${escHtml(project.latestNotes)}</div>
    </div>` : ''}
  `;
}


// ── Helper: days since a date string ────────────────────────────────────────
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}


// ── TAB: Documents — Collapsed List View ────────────────────────────────────
function renderDocuments() {
  const list = document.getElementById('documents-list');
  if (!list) return;
  if (!Array.isArray(project.documents)) project.documents = [];
  list.innerHTML = '';

  const groups = {};
  project.documents.forEach((doc, idx) => {
    const g = doc.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push({ doc, idx });
  });

  const groupOrder = ['Safety Documents', 'Submissions', 'Other'];
  const allGroups = [...new Set([...groupOrder, ...Object.keys(groups)])];

  allGroups.forEach(groupName => {
    if (!groups[groupName]) return;
    const header = document.createElement('div');
    header.className = 'doc-group-header';
    header.textContent = groupName;
    list.appendChild(header);
    const groupEl = document.createElement('div');
    groupEl.className = 'doc-group';
    list.appendChild(groupEl);
    groups[groupName].forEach(({ doc, idx }) => {
      groupEl.appendChild(buildDocRow(doc, idx));
    });
  });

  const addBtn = document.getElementById('doc-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      project.documents.push({ name: 'New Document', group: 'Other', allowMultiple: false, status: 'Not Submitted', submitted: '', approved: '', notes: '', files: [] });
      renderDocuments();
      debouncedSave();
    };
  }

  // Wire "+ New Group" button
  const newGroupBtn = document.getElementById('doc-new-group-btn');
  if (newGroupBtn) {
    newGroupBtn.onclick = () => {
      const name = prompt('Group name:');
      if (!name || !name.trim()) return;
      project.documents.push({
        name: 'New Document',
        group: name.trim(),
        allowMultiple: false,
        status: 'Not Submitted',
        submitted: '', approved: '', notes: '', files: []
      });
      debouncedSave();
      renderDocuments();
    };
  }
}

function buildDocRow(doc, idx) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.dataset.idx = idx;

  const statusColors = { 'Approved': 'var(--green)', 'Submitted for Approval': 'var(--amber)', 'Not Submitted': 'var(--text-muted)', 'Rejected': 'var(--red)' };
  const statusDots  = { 'Approved': '\u{1F7E2}', 'Submitted for Approval': '\u{1F7E1}', 'Not Submitted': '\u{1F534}', 'Rejected': '\u{1F534}' };
  const dot = statusDots[doc.status] || '\u26AA';
  const files = Array.isArray(doc.files) ? doc.files.filter(f => f.fileName) : [];
  const fileIndicator = files.length > 0
    ? '<span class="doc-file-indicator">\u{1F4C4} ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '</span>'
    : '';

  row.innerHTML =
    '<div class="doc-row-summary">' +
      '<span class="doc-row-name">' + escHtml(doc.name || 'Unnamed') + '</span>' +
      '<span class="doc-row-status" style="color:' + (statusColors[doc.status] || 'var(--text-muted)') + ';">' + dot + ' ' + escHtml(doc.status || 'Not Submitted') + '</span>' +
      fileIndicator +
      '<button class="doc-row-toggle btn btn-ghost btn-sm">\u25BE</button>' +
    '</div>' +
    '<div class="doc-row-detail" style="display:none;">' +
      '<div class="doc-detail-grid">' +
        '<div class="field" style="margin:0;">' +
          '<label>Status</label>' +
          '<select class="doc-status-sel tbl-select">' +
            '<option' + (doc.status === 'Not Submitted' ? ' selected' : '') + '>Not Submitted</option>' +
            '<option' + (doc.status === 'Submitted for Approval' ? ' selected' : '') + '>Submitted for Approval</option>' +
            '<option' + (doc.status === 'Approved' ? ' selected' : '') + '>Approved</option>' +
            '<option' + (doc.status === 'Rejected' ? ' selected' : '') + '>Rejected</option>' +
          '</select>' +
        '</div>' +
        '<div class="field" style="margin:0;">' +
          '<label>Submitted</label>' +
          '<input type="date" class="doc-submitted tbl-input" value="' + escHtml(doc.submitted || '') + '">' +
        '</div>' +
        '<div class="field" style="margin:0;">' +
          '<label>Approved</label>' +
          '<input type="date" class="doc-approved tbl-input" value="' + escHtml(doc.approved || '') + '">' +
        '</div>' +
        '<div class="field" style="margin:0; grid-column:1/-1;">' +
          '<label>Notes</label>' +
          '<input type="text" class="doc-notes tbl-input" value="' + escHtml(doc.notes || '') + '" placeholder="Notes\u2026">' +
        '</div>' +
      '</div>' +
      '<div class="doc-files-section">' +
        '<div class="doc-files-list" id="doc-files-' + idx + '">' +
          files.map((f, fi) =>
            '<div class="doc-file-item">' +
              '<a href="/uploads/' + escHtml(f.fileName) + '" target="_blank" class="doc-file-link">\u{1F4C4} ' + escHtml(f.fileName.replace(/^\d+-/, '')) + '</a>' +
              '<button class="btn btn-ghost btn-sm doc-remove-file" data-fi="' + fi + '" style="color:var(--red);">\u{1F5D1}</button>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<label class="btn-upload-pdf" style="margin-top:6px; cursor:pointer;">' +
          '\u{1F4CE} ' + (doc.allowMultiple && files.length > 0 ? 'Upload Another PDF' : 'Upload PDF') +
          '<input type="file" accept=".pdf" class="doc-file-input" style="display:none;">' +
        '</label>' +
      '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--border);">' +
        '<input type="text" class="doc-name-edit tbl-input" value="' + escHtml(doc.name || '') + '" placeholder="Document name" style="flex:1; margin-right:8px;">' +
        '<button class="btn btn-ghost btn-sm doc-del-btn" style="color:var(--red); flex-shrink:0;">Remove</button>' +
      '</div>' +
    '</div>';

  const toggleBtn = row.querySelector('.doc-row-toggle');
  const detail    = row.querySelector('.doc-row-detail');
  toggleBtn.addEventListener('click', () => {
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'block';
    toggleBtn.textContent = isOpen ? '\u25BE' : '\u25B4';
    row.classList.toggle('doc-row-open', !isOpen);
  });

  row.querySelector('.doc-status-sel').addEventListener('change', function() {
    project.documents[idx].status = this.value;
    const statusEl = row.querySelector('.doc-row-status');
    statusEl.textContent = (statusDots[this.value] || '\u26AA') + ' ' + this.value;
    statusEl.style.color = statusColors[this.value] || 'var(--text-muted)';
    debouncedSave();
  });

  row.querySelector('.doc-submitted').addEventListener('change', function() { project.documents[idx].submitted = this.value; debouncedSave(); });
  row.querySelector('.doc-approved').addEventListener('change', function() { project.documents[idx].approved = this.value; debouncedSave(); });
  row.querySelector('.doc-notes').addEventListener('input', function() { project.documents[idx].notes = this.value; debouncedSave(); });
  row.querySelector('.doc-name-edit').addEventListener('input', function() {
    project.documents[idx].name = this.value;
    row.querySelector('.doc-row-name').textContent = this.value || 'Unnamed';
    debouncedSave();
  });

  row.querySelector('.doc-del-btn').addEventListener('click', () => {
    if (!confirm('Remove this document?')) return;
    project.documents.splice(idx, 1);
    renderDocuments();
    saveProject();
  });

  row.querySelector('.doc-file-input').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/projects/' + projectId + '/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.filename) {
        if (!Array.isArray(project.documents[idx].files)) project.documents[idx].files = [];
        project.documents[idx].files.push({ fileName: data.filename, uploadedAt: new Date().toISOString() });
        await saveProject();
        renderDocuments();
        showToast('PDF uploaded', 'success');
      }
    } catch { showToast('Upload failed', 'error'); }
  });

  row.querySelectorAll('.doc-remove-file').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this file?')) return;
      const fi = parseInt(btn.dataset.fi);
      const fileName = project.documents[idx].files[fi] && project.documents[idx].files[fi].fileName;
      if (fileName) {
        await fetch('/api/projects/' + projectId + '/documents/' + idx + '/file', { method: 'DELETE' });
      }
      project.documents[idx].files.splice(fi, 1);
      await saveProject();
      renderDocuments();
    });
  });

  return row;
}


// ── Drawings Tab ─────────────────────────────────────────────────────────────
function renderDrawings() {
  const container = document.getElementById('drawings-grid');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(project.drawings)) project.drawings = [];
  if (!Array.isArray(project.drawingFolders)) project.drawingFolders = ['General'];

  // Ensure all drawings have a folder
  project.drawings.forEach(d => { if (!d.folder) d.folder = 'General'; });

  // Build folder list: defined folders + any folder referenced by a drawing
  const allFolders = [...new Set([
    ...project.drawingFolders,
    ...project.drawings.map(d => d.folder || 'General')
  ])];

  allFolders.forEach(folderName => {
    const folderItems = project.drawings
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => (d.folder || 'General') === folderName);

    const canDelete = folderName !== 'General' && folderItems.length === 0;

    const folderEl = document.createElement('div');
    folderEl.className = 'drawing-folder';
    folderEl.innerHTML = `
      <div class="drawing-folder-header">
        <span class="drawing-folder-toggle">▾</span>
        <span>📁</span>
        <span class="drawing-folder-name">${escHtml(folderName)}</span>
        <span class="drawing-folder-count">${folderItems.length}</span>
        ${canDelete ? `<button class="btn btn-danger btn-xs del-folder-btn" data-folder="${escHtml(folderName)}">✕</button>` : ''}
      </div>
      <div class="drawing-folder-body"></div>
    `;

    const body = folderEl.querySelector('.drawing-folder-body');

    // Drawing cards
    folderItems.forEach(({ d, i }) => body.appendChild(buildDrawingCard(d, i)));

    // Per-folder "Add Drawing" button
    const addToBtn = document.createElement('button');
    addToBtn.className = 'btn btn-ghost btn-sm';
    addToBtn.style.cssText = 'grid-column:1/-1;margin-top:4px;';
    addToBtn.textContent = `📎 Add Drawing`;
    addToBtn.addEventListener('click', () => {
      project.drawings.push({ name: '', drawingNumber: '', revision: '', status: 'For Approval', file: '', folder: folderName });
      renderDrawings();
      debouncedSave();
    });
    body.appendChild(addToBtn);

    // Toggle collapse
    folderEl.querySelector('.drawing-folder-header').addEventListener('click', e => {
      if (e.target.closest('button')) return;
      folderEl.classList.toggle('collapsed');
    });

    container.appendChild(folderEl);
  });

  // Delete folder buttons
  container.querySelectorAll('.del-folder-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fname = btn.dataset.folder;
      project.drawingFolders = project.drawingFolders.filter(f => f !== fname);
      debouncedSave();
      renderDrawings();
    });
  });

  // Top-level "+ Add Drawing" button → adds to General
  const addBtn = document.getElementById('drawing-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      project.drawings.push({ name: '', drawingNumber: '', revision: '', status: 'For Approval', file: '', folder: 'General' });
      renderDrawings();
      debouncedSave();
    };
  }

  // "+ New Folder" button
  const newFolderBtn = document.getElementById('drawing-new-folder-btn');
  if (newFolderBtn) {
    newFolderBtn.onclick = () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (!Array.isArray(project.drawingFolders)) project.drawingFolders = ['General'];
      if (project.drawingFolders.includes(trimmed)) { showToast('Folder already exists', 'error'); return; }
      project.drawingFolders.push(trimmed);
      debouncedSave();
      renderDrawings();
    };
  }
}

function buildDrawingCard(drawing, idx) {
  const card = document.createElement('div');
  card.className = 'doc-card';

  const fileLink = drawing.file
    ? `<a class="doc-file-link" href="/uploads/${escHtml(drawing.file)}" target="_blank" rel="noopener">📄 ${escHtml(drawing.file.replace(/^\d+-/, ''))}</a>
       <button class="btn btn-ghost btn-sm doc-remove-file" title="Remove PDF" style="margin-left:4px;color:var(--red);">🗑</button>`
    : '';

  card.innerHTML = `
    <div class="doc-card-header">
      <input class="doc-name-input" value="${escHtml(drawing.name || '')}" placeholder="Drawing name">
      <button class="btn btn-ghost btn-sm drw-del-btn" title="Remove">✕</button>
    </div>
    <div class="doc-status-row" style="gap:6px;">
      <input class="tbl-input" value="${escHtml(drawing.drawingNumber || '')}" placeholder="Drawing No." style="flex:1;">
      <input class="tbl-input" value="${escHtml(drawing.revision || '')}" placeholder="Rev" style="width:50px;">
    </div>
    <div class="doc-status-row">
      <select class="drw-status-sel tbl-select">
        <option${drawing.status === 'For Approval' ? ' selected' : ''}>For Approval</option>
        <option${drawing.status === 'Approved'     ? ' selected' : ''}>Approved</option>
        <option${drawing.status === 'Superseded'   ? ' selected' : ''}>Superseded</option>
      </select>
    </div>
    <div class="doc-upload-area">
      <label class="btn-upload-pdf" style="display:${drawing.file ? 'none' : ''}">
        📎 Upload PDF
        <input type="file" accept=".pdf" class="drw-file-input" style="display:none;">
      </label>
      <span class="doc-file-display">${fileLink}</span>
    </div>
  `;

  card.querySelector('.doc-name-input').addEventListener('input', function () {
    project.drawings[idx].name = this.value; debouncedSave();
  });
  const [numInput, revInput] = card.querySelectorAll('input.tbl-input');
  numInput.addEventListener('input', function () { project.drawings[idx].drawingNumber = this.value; debouncedSave(); });
  revInput.addEventListener('input', function () { project.drawings[idx].revision = this.value; debouncedSave(); });
  card.querySelector('.drw-status-sel').addEventListener('change', function () {
    project.drawings[idx].status = this.value; saveProject();
  });
  card.querySelector('.drw-del-btn').addEventListener('click', () => {
    project.drawings.splice(idx, 1); renderDrawings(); saveProject();
  });

  const fileInput   = card.querySelector('.drw-file-input');
  const fileDisplay = card.querySelector('.doc-file-display');
  fileInput.addEventListener('change', async function () {
    if (!this.files || !this.files[0]) return;
    const formData = new FormData();
    formData.append('file', this.files[0]);
    try {
      const res = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: formData });
      if (!res.ok) throw new Error();
      const data = await res.json();
      project.drawings[idx].file = data.filename;
      fileDisplay.innerHTML = `<a class="doc-file-link" href="/uploads/${escHtml(data.filename)}" target="_blank" rel="noopener">📄 ${escHtml(data.originalName)}</a>
        <button class="btn btn-ghost btn-sm doc-remove-file" title="Remove PDF" style="margin-left:4px;color:var(--red);">🗑</button>`;
      card.querySelector('label.btn-upload-pdf').style.display = 'none';
      bindRemovePdf(fileDisplay, 'drawings', idx);
      showToast('PDF uploaded.', 'success');
      debouncedSave();
    } catch { showToast('Upload failed.', 'error'); }
  });
  bindRemovePdf(fileDisplay, 'drawings', idx);

  return card;
}

// ── Bind Remove PDF (drawings) ───────────────────────────────────────────────
function bindRemovePdf(fileDisplay, section, idx) {
  const btn = fileDisplay.querySelector('.doc-remove-file');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Remove this file?')) return;
    const fileName = section === 'drawings' ? project.drawings[idx]?.file : null;
    if (fileName) {
      try {
        await fetch(`/api/projects/${projectId}/drawings/${idx}/file`, { method: 'DELETE' });
      } catch (e) { /* ignore */ }
    }
    if (section === 'drawings') project.drawings[idx].file = '';
    fileDisplay.innerHTML = '';
    const card = fileDisplay.closest('.drawing-card');
    if (card) card.querySelector('label.btn-upload-pdf').style.display = '';
    debouncedSave();
    showToast('File removed.', 'success');
  });
}

// ── Product Scope Table ───────────────────────────────────────────────────────
function renderProductScope() {
  const tbody = document.getElementById('product-scope-tbody');
  if (!tbody) return;

  // Migrate old product string to array
  if (!Array.isArray(project.productScope)) {
    project.productScope = project.product
      ? [{ item: project.product, qty: 1, unit: 'units' }]
      : [];
  }
  if (project.productScope.length === 0) {
    project.productScope.push({ item: '', qty: 1, unit: 'units' });
  }

  tbody.innerHTML = '';
  project.productScope.forEach((row, idx) => {
    const tr = document.createElement('tr');
    const zoneLabelHtml = row.unit === 'zone'
      ? `<input class="tbl-input zone-label-input" type="text" value="${escHtml(row.zoneLabel || '')}" placeholder="e.g. Zone A" style="width:80px; margin-left:4px;">`
      : `<input class="tbl-input zone-label-input" type="text" value="${escHtml(row.zoneLabel || '')}" placeholder="e.g. Zone A" style="width:80px; margin-left:4px; display:none;">`;
    // Default new rows to Local Fabrication / Fixed / Parts: No
    if (row.type == null)       row.type       = 'Local Fabrication';
    if (row.itemType == null)   row.itemType   = 'Fixed';
    if (row.partsRequired == null) row.partsRequired = false;

    tr.innerHTML = `
      <td><input class="tbl-input ps-item" value="${escHtml(row.item || '')}" placeholder="e.g. SP30 Fixed Bollard" style="min-width:160px; width:100%;"></td>
      <td><input class="tbl-input ps-qty" type="number" value="${row.qty || 1}" min="1" style="width:60px;"></td>
      <td style="white-space:nowrap;">
        <select class="tbl-input unit-select" style="width:100px;">
          <option value="units"     ${row.unit === 'units'     ? 'selected' : ''}>units</option>
          <option value="sets"      ${row.unit === 'sets'      ? 'selected' : ''}>sets</option>
          <option value="set-of-1"  ${row.unit === 'set-of-1'  ? 'selected' : ''}>Set of 1</option>
          <option value="set-of-2"  ${row.unit === 'set-of-2'  ? 'selected' : ''}>Set of 2</option>
          <option value="set-of-3"  ${row.unit === 'set-of-3'  ? 'selected' : ''}>Set of 3</option>
          <option value="set-of-4"  ${row.unit === 'set-of-4'  ? 'selected' : ''}>Set of 4</option>
          <option value="m"         ${row.unit === 'm'         ? 'selected' : ''}>m</option>
          <option value="pcs"       ${row.unit === 'pcs'       ? 'selected' : ''}>pcs</option>
          <option value="zone"      ${row.unit === 'zone'      ? 'selected' : ''}>Zone</option>
        </select>${zoneLabelHtml}
      </td>
      <td>
        <select class="tbl-input ps-type" style="width:140px;">
          <option value="Local Fabrication" ${row.type === 'Local Fabrication' ? 'selected' : ''}>Local Fabrication</option>
          <option value="Overseas Order"    ${row.type === 'Overseas Order'    ? 'selected' : ''}>Overseas Order</option>
          <option value="Purchase Item"     ${row.type === 'Purchase Item'     ? 'selected' : ''}>Purchase Item</option>
        </select>
      </td>
      <td>
        <select class="tbl-input ps-itemtype" style="width:100px;">
          <option value="Fixed"      ${row.itemType === 'Fixed'      ? 'selected' : ''}>Fixed</option>
          <option value="Mechanical" ${row.itemType === 'Mechanical' ? 'selected' : ''}>Mechanical</option>
        </select>
      </td>
      <td style="text-align:center;">
        <input type="checkbox" class="ps-parts" ${row.partsRequired ? 'checked' : ''} style="width:16px;height:16px;">
      </td>
      <td><button class="btn btn-ghost btn-sm del-row-btn" title="Remove">✕</button></td>
    `;
    const iItem = tr.querySelector('input.ps-item');
    const iQty  = tr.querySelector('input.ps-qty');
    const iUnit = tr.querySelector('select.unit-select');
    const iZoneLabel = tr.querySelector('.zone-label-input');
    const iType = tr.querySelector('select.ps-type');
    const iItemType = tr.querySelector('select.ps-itemtype');
    const iParts = tr.querySelector('input.ps-parts');
    const sync = () => {
      project.productScope[idx].item      = iItem.value;
      project.productScope[idx].qty       = Number(iQty.value) || 1;
      project.productScope[idx].unit      = iUnit.value;
      project.productScope[idx].zoneLabel = iUnit.value === 'zone' ? iZoneLabel.value : '';
      project.productScope[idx].type      = iType.value;
      project.productScope[idx].itemType  = iItemType.value;
      project.productScope[idx].partsRequired = !!iParts.checked;
      // Keep legacy product string for dashboard display
      project.product = project.productScope
        .filter(r => r.item)
        .map(r => `${r.qty}x ${r.item}`)
        .join(', ');
      debouncedSave();
    };
    [iItem, iQty, iZoneLabel].forEach(el => el.addEventListener('input', sync));
    iQty.addEventListener('change', sync);
    iType.addEventListener('change', sync);
    iItemType.addEventListener('change', sync);
    iParts.addEventListener('change', sync);
    iUnit.addEventListener('change', () => {
      iZoneLabel.style.display = iUnit.value === 'zone' ? 'inline-block' : 'none';
      sync();
    });
    tr.querySelector('.del-row-btn').addEventListener('click', () => {
      project.productScope.splice(idx, 1);
      renderProductScope();
      debouncedSave();
    });
    tbody.appendChild(tr);
  });

  // Add row button
  const addBtn = document.getElementById('product-scope-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      project.productScope.push({ item: '', qty: 1, unit: 'units' });
      renderProductScope();
    };
  }

  // Sync button
  const syncBtn = document.getElementById('btn-sync-scope');
  if (syncBtn) {
    syncBtn.onclick = () => {
      if (!Array.isArray(project.fabrication)) project.fabrication = [];
      if (!Array.isArray(project.installation)) project.installation = [];

      // Sync each product scope row as-is — no merging, preserve individual rows
      const items = project.productScope.filter(r => r.item && r.item.trim());

      // Rebuild FAB: keep existing progress (qtyDone, status etc), just update totalQty
      // Match by index first, then fall back to name match for existing rows
      const newFab = items.map((scopeRow, i) => {
        const existingByIndex = project.fabrication[i];
        const key = scopeRow.item.trim().toLowerCase();
        // Use same-index row if it matches the item name, else find by name
        const existing = (existingByIndex && existingByIndex.item && existingByIndex.item.trim().toLowerCase() === key)
          ? existingByIndex
          : project.fabrication.find(r => r.item && r.item.trim().toLowerCase() === key);
        if (existing) {
          return Object.assign({}, existing, { item: scopeRow.item.trim(), totalQty: scopeRow.qty });
        }
        return { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units', qtyDone: 0, qtySent: 0, status: 'Not Started', started: '', done: '' };
      });
      project.fabrication = newFab;

      // Rebuild Install the same way
      const newInst = items.map((scopeRow, i) => {
        const existingByIndex = project.installation[i];
        const key = scopeRow.item.trim().toLowerCase();
        const existing = (existingByIndex && existingByIndex.item && existingByIndex.item.trim().toLowerCase() === key)
          ? existingByIndex
          : project.installation.find(r => r.item && r.item.trim().toLowerCase() === key);
        if (existing) {
          return Object.assign({}, existing, { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units' });
        }
        return { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units', doneQty: 0, notes: '' };
      });
      project.installation = newInst;

      renderFabrication();
      updateFabPct(); updateFabLiveSummary();
      renderInstallation();
      debouncedSave();

      const orig = syncBtn.textContent;
      syncBtn.textContent = '↻ Synced!';
      setTimeout(() => { syncBtn.textContent = orig; }, 1500);
      showToast(`Synced ${items.length} item${items.length !== 1 ? 's' : ''} to FAB and Install`, 'success');
    };
  }
}

// ── TAB 3: Fabrication ───────────────────────────────────────────────────────
const FAB_DONE_STATUSES = ['Ready for Delivery', 'Delivered', 'Completed'];
let _fabDragIdx = null;

function renderFabrication() {
  const tbody = document.getElementById('fab-tbody');
  tbody.innerHTML = '';

  if (!Array.isArray(project.fabrication)) project.fabrication = [];

  if (!project.fabrication.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No fabrication items — add via /factory</td></tr>';
  } else {
    project.fabrication.forEach((row) => {
      const totalQty = Number(row.totalQty) || 0;
      const doneQty  = Number(row.qtyDone)  || 0;
      const isDone   = FAB_DONE_STATUSES.includes(row.status) && doneQty >= totalQty && totalQty > 0;
      const tr = document.createElement('tr');
      if (isDone) { tr.style.background = 'rgba(0,200,117,0.06)'; tr.style.borderLeft = '3px solid var(--green)'; }
      tr.innerHTML = `
        <td style="padding:8px 10px;font-size:13px;">${escHtml(row.item || '—')}</td>
        <td style="padding:8px 10px;font-size:13px;text-align:right;">${totalQty || '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.unit || '—')}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.process || '—')}</td>
        <td style="padding:8px 10px;font-size:13px;text-align:right;font-weight:600;color:${doneQty >= totalQty && totalQty > 0 ? 'var(--green)' : 'var(--text)'};">${doneQty}</td>
        <td style="padding:8px 10px;"><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,0.07);">${escHtml(row.status || '—')}</span></td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.started || '—')}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.done || '—')}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.targetDeliveryDate || '—')}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateFabPct(); updateFabLiveSummary(); renderProcessTimeline();
}

function buildFabRow(row, idx) {
  const tr = document.createElement('tr');
  const isReady = row.readyForDelivery || false;
  tr.innerHTML = `
    <td><input class="fab-item tbl-input" value="${escHtml(row.item || '')}" placeholder="Item" style="min-width:120px;"></td>
    <td><input class="fab-totalqty tbl-input" type="number" value="${row.totalQty || 0}" min="0" style="min-width:60px;"></td>
    <td>
      <select class="fab-unit tbl-input" style="min-width:100px;">
        ${['units','set-of-1','set-of-2','set-of-3','set-of-4','set-of-5','pairs','lots']
          .map(u => `<option value="${u}"${(row.unit||'units') === u ? ' selected' : ''}>${u}</option>`).join('')}
      </select>
    </td>
    <td>
      <select class="fab-process tbl-input" style="min-width:140px;">
        <option value="">— Process —</option>
        ${['Cutting','Welding','Drilling','Tapping','Steel Fabrication','Galvanizing','Powder Coating','Painting','Assembly','Concrete Works','Electrical Works','Testing & Commissioning','Packing','Other']
          .map(p => `<option value="${p}"${row.process === p ? ' selected' : ''}>${p}</option>`).join('')}
      </select>
    </td>
    <td><input class="fab-qtydone tbl-input" type="number" value="${row.qtyDone || 0}" min="0" style="min-width:60px;"></td>
    <td><input class="fab-qtysent tbl-input" type="number" value="${row.qtySent || 0}" min="0" style="min-width:60px;"></td>
    <td>
      <select class="fab-status tbl-input" style="min-width:120px;">
        ${['Not Started','In Progress','QC Check','Ready for Delivery','Delivered','Completed']
          .map(s => `<option value="${s}"${row.status === s ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
    </td>
    <td><input class="fab-started tbl-input" type="date" value="${escHtml(row.started || '')}"></td>
    <td><input class="fab-done tbl-input" type="date" value="${escHtml(row.done || '')}"></td>
    <td><input class="fab-targetdate tbl-input" type="date" value="${escHtml(row.targetDeliveryDate || '')}" title="Target delivery date"></td>
    <td class="fab-ready-cell">
      ${isReady
        ? `<button class="btn btn-sm btn-unmark-ready" style="background:var(--bg3);color:var(--text-muted);white-space:nowrap;font-size:11px;">✓ Ready · Unmark</button>`
        : `<button class="btn btn-sm btn-mark-ready-row" style="background:var(--green);color:#fff;white-space:nowrap;">Mark Ready</button>`
      }
    </td>
    <td style="white-space:nowrap;">
      <button class="btn btn-ghost btn-sm btn-log-step" title="Log a process step" style="font-size:10px;padding:2px 5px;margin-right:2px;">+ Log</button>
      <button class="btn btn-ghost btn-sm del-row-btn" title="Remove">✕</button>
    </td>
  `;

  // Fab tab is read-only — editing happens on the Factory page
  tr.querySelectorAll('input, select').forEach(el => { el.disabled = true; el.style.opacity = '0.8'; });
  // Hide edit-only buttons
  const logBtn = tr.querySelector('.btn-log-step');
  if (logBtn) logBtn.style.display = 'none';
  const delBtn = tr.querySelector('.del-row-btn');
  if (delBtn) delBtn.style.display = 'none';
  const readyBtn = tr.querySelector('.btn-mark-ready-row') || tr.querySelector('.btn-unmark-ready');
  if (readyBtn) readyBtn.style.display = 'none';

  const iItem       = tr.querySelector('.fab-item');
  const iTotalQty   = tr.querySelector('.fab-totalqty');
  const iUnit       = tr.querySelector('.fab-unit');
  const iProcess    = tr.querySelector('.fab-process');
  const iQtyDone    = tr.querySelector('.fab-qtydone');
  const iQtySent    = tr.querySelector('.fab-qtysent');
  const iStatus     = tr.querySelector('.fab-status');
  const iStarted    = tr.querySelector('.fab-started');
  const iDone       = tr.querySelector('.fab-done');
  const iTargetDate = tr.querySelector('.fab-targetdate');

  const sync = () => {
    project.fabrication[idx].item               = iItem.value;
    project.fabrication[idx].totalQty           = Number(iTotalQty.value) || 0;
    project.fabrication[idx].unit               = iUnit.value;
    project.fabrication[idx].process            = iProcess.value;
    project.fabrication[idx].qtyDone            = Number(iQtyDone.value) || 0;
    project.fabrication[idx].qtySent            = Number(iQtySent.value) || 0;
    project.fabrication[idx].status             = iStatus.value;
    project.fabrication[idx].started            = iStarted.value;
    project.fabrication[idx].done               = iDone.value;
    project.fabrication[idx].targetDeliveryDate = iTargetDate.value;
    updateFabPct();
    debouncedSave();
  };

  // Auto-log when process changes
  iProcess.addEventListener('change', () => {
    const newProcess = iProcess.value;
    if (!newProcess) return;
    const fabRow = project.fabrication[idx];
    if (!Array.isArray(fabRow.processLog)) fabRow.processLog = [];
    const today = new Date().toISOString().split('T')[0];
    const existing = fabRow.processLog.find(e => e.process === newProcess);
    if (!existing) {
      fabRow.processLog.push({ process: newProcess, startedAt: today, completedAt: '', notes: '' });
      renderProcessTimeline();
    }
  });

  // Auto-update completedAt when status becomes a done status
  iStatus.addEventListener('change', () => {
    const newStatus = iStatus.value;
    const fabRow = project.fabrication[idx];
    if (!Array.isArray(fabRow.processLog)) return;
    if (FAB_DONE_STATUSES.includes(newStatus)) {
      const today = new Date().toISOString().split('T')[0];
      const activeEntry = fabRow.processLog.find(e => e.process === fabRow.process && !e.completedAt);
      if (activeEntry) {
        activeEntry.completedAt = today;
        renderProcessTimeline();
      }
    }
  });

  iItem.addEventListener('input', sync);
  [iTotalQty, iQtyDone, iQtySent].forEach(el => el.addEventListener('input', sync));
  [iStarted, iDone, iTargetDate].forEach(el => el.addEventListener('change', sync));
  [iUnit, iProcess, iStatus].forEach(el => el.addEventListener('change', sync));

  // + Log Step button
  tr.querySelector('.btn-log-step').addEventListener('click', () => {
    const existingForm = document.getElementById(`fab-log-form-${idx}`);
    if (existingForm) { existingForm.remove(); return; }
    const formTr = document.createElement('tr');
    formTr.id = `fab-log-form-${idx}`;
    const LOG_PROCESSES = ['Cutting','Welding','Drilling','Tapping','Steel Fabrication','Galvanizing','Powder Coating','QC Check','Packing'];
    formTr.innerHTML = `
      <td colspan="13" style="background:var(--bg3); padding:10px 14px; border-top:1px dashed var(--border);">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
          <div>
            <label style="font-size:10px; color:var(--text-muted); display:block; margin-bottom:3px;">Process</label>
            <select id="logp-proc-${idx}" class="tbl-input" style="min-width:160px;">
              <option value="">— Select —</option>
              ${LOG_PROCESSES.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:10px; color:var(--text-muted); display:block; margin-bottom:3px;">Started</label>
            <input type="date" id="logp-start-${idx}" class="tbl-input">
          </div>
          <div>
            <label style="font-size:10px; color:var(--text-muted); display:block; margin-bottom:3px;">Completed</label>
            <input type="date" id="logp-done-${idx}" class="tbl-input">
          </div>
          <div style="flex:1; min-width:140px;">
            <label style="font-size:10px; color:var(--text-muted); display:block; margin-bottom:3px;">Notes</label>
            <input type="text" id="logp-notes-${idx}" class="tbl-input" placeholder="Optional…" style="width:100%;">
          </div>
          <button class="btn btn-primary btn-sm" id="logp-save-${idx}">Save</button>
          <button class="btn btn-ghost btn-sm" id="logp-cancel-${idx}">Cancel</button>
        </div>
      </td>
    `;
    tr.insertAdjacentElement('afterend', formTr);
    document.getElementById(`logp-cancel-${idx}`).onclick = () => formTr.remove();
    document.getElementById(`logp-save-${idx}`).onclick = () => {
      const proc    = document.getElementById(`logp-proc-${idx}`).value;
      const started = document.getElementById(`logp-start-${idx}`).value;
      const done    = document.getElementById(`logp-done-${idx}`).value;
      const notes   = document.getElementById(`logp-notes-${idx}`).value;
      if (!proc) { showToast('Select a process', 'error'); return; }
      const fabRow = project.fabrication[idx];
      if (!Array.isArray(fabRow.processLog)) fabRow.processLog = [];
      const existing = fabRow.processLog.find(e => e.process === proc);
      if (existing) {
        if (started)  existing.startedAt   = started;
        if (done)     existing.completedAt = done;
        if (notes)    existing.notes       = notes;
      } else {
        fabRow.processLog.push({ process: proc, startedAt: started, completedAt: done, notes });
      }
      formTr.remove();
      renderProcessTimeline();
      debouncedSave();
      showToast('Step logged', 'success');
    };
  });

  // Mark Ready / Unmark toggle
  const markReadyBtn = tr.querySelector('.btn-mark-ready-row');
  if (markReadyBtn) {
    markReadyBtn.addEventListener('click', () => {
      project.fabrication[idx].readyForDelivery = true;
      project.fabrication[idx].readyAt = new Date().toISOString();
      debouncedSave();
      renderFabrication();
    });
  }
  const unmarkBtn = tr.querySelector('.btn-unmark-ready');
  if (unmarkBtn) {
    unmarkBtn.addEventListener('click', () => {
      project.fabrication[idx].readyForDelivery = false;
      project.fabrication[idx].readyAt = null;
      debouncedSave();
      renderFabrication();
    });
  }

  tr.querySelector('.del-row-btn').addEventListener('click', async () => {
    if (!confirm('Delete this fabrication row? Linked site-requests will have their row-pointer cleared.')) return;
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(project.id) + '/fabrication/' + idx, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || ('Delete failed (' + res.status + ')'));
      }
      const data = await res.json();
      // Mirror the server-side splice on the local project object so
      // subsequent edits work against correct indices without a reload.
      project.fabrication.splice(idx, 1);
      renderFabrication();
      if (data && (data.srReindexed || data.srNulled)) {
        showToast(`Deleted. Reindexed ${data.srReindexed} site-request${data.srReindexed !== 1 ? 's' : ''}, cleared ${data.srNulled}.`, 'success');
      } else {
        showToast('Fabrication row deleted', 'success');
      }
    } catch (e) {
      console.error('delete fab row failed:', e);
      alert('Delete failed: ' + e.message);
    }
  });

  return tr;
}

function updateFabPct() {
  const fab = project.fabrication || [];
  const totalQty = fab.reduce((s, r) => s + (Number(r.totalQty) || 0), 0);
  const doneQty  = fab.reduce((s, r) => s + (Number(r.qtyDone)  || 0), 0);
  const pct = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;
  project.fabPercent = pct;
  const el = document.getElementById('fab-pct-display');
  if (el) el.textContent = `${pct}%`;
  document.getElementById('fin-fabpct').textContent = fmtPct(pct);
  const fabBarEl = document.getElementById('fin-fab-bar');
  if (fabBarEl) fabBarEl.style.width = pct + '%';
}

// ── Fabrication live summary (read-friendly header) ──────────────────────────
function updateFabLiveSummary() {
  const el = document.getElementById('fab-live-summary');
  if (!el || !project.fabrication) return;

  // Drop zone: drag row from Progress → Completion = mark Ready for Delivery
  el.ondragover = e => { e.preventDefault(); el.style.outline = '2px dashed var(--green)'; };
  el.ondragleave = () => el.style.outline = '';
  el.ondrop = e => {
    e.preventDefault();
    el.style.outline = '';
    if (_fabDragIdx === null) return;
    const row = project.fabrication[_fabDragIdx];
    const total = Number(row.totalQty) || 0;
    if (Number(row.qtyDone) < total) { showToast('Qty Done must be 100% first', 'error'); _fabDragIdx = null; return; }
    if (Number(row.qtySent) < total) { showToast('Qty Sent must be 100% first', 'error'); _fabDragIdx = null; return; }
    row.status = 'Ready for Delivery';
    row.readyForDelivery = true;
    row.readyAt = new Date().toISOString();
    _fabDragIdx = null;
    renderFabrication(); updateFabLiveSummary(); debouncedSave();
    showToast('Marked Ready for Delivery ✓', 'success');
  };

  const allFab = project.fabrication.filter(f => f.totalQty > 0);
  // Completion: status done AND qty done AND qty sent all at 100%
  const doneFab = allFab.filter(f =>
    FAB_DONE_STATUSES.includes(f.status) &&
    Number(f.qtyDone) > 0 && Number(f.qtyDone) >= Number(f.totalQty) &&
    Number(f.qtySent) > 0 && Number(f.qtySent) >= Number(f.totalQty)
  );

  if (!doneFab.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No items marked ready or completed yet.</div>';
    return;
  }

  const totalQty = allFab.reduce((s, f) => s + (Number(f.totalQty) || 0), 0);
  const doneQty  = allFab.reduce((s, f) => s + (Number(f.qtyDone)  || 0), 0);
  const pct = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;
  const color = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';
  const statusColors = { 'Ready for Delivery': 'var(--green)', 'Delivered': 'var(--green)', 'Completed': 'var(--green)' };

  const cards = doneFab.map(f => {
    const sc = statusColors[f.status] || 'var(--green)';
    const fabIdx = project.fabrication.indexOf(f);
    return `<div draggable="true" data-fab-done-idx="${fabIdx}" title="Drag up to move back to Progress"
      style="background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--green); border-radius:6px; padding:8px 12px; min-width:140px; cursor:grab;">
      <div style="font-size:12px; font-weight:600; margin-bottom:4px;">${escHtml(f.item || '')}</div>
      <div style="font-size:11px; color:var(--text-muted);">${f.qtyDone || 0}/${f.totalQty || 0} ${escHtml(f.unit || 'units')}</div>
      <div style="font-size:10px; color:${sc}; margin-top:2px;">✓ ${escHtml(f.status)}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--card-bg); border-radius:8px; margin-bottom:10px;">
      <div style="flex:1;">
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Overall Fabrication</div>
        <div class="progress-bar" style="height:8px;">
          <div class="progress-fill" style="width:${pct}%; background:${color};"></div>
        </div>
      </div>
      <div style="font-size:22px; font-weight:700; color:${color}; min-width:52px; text-align:right;">${pct}%</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">${cards}</div>
  `;

  // Wire dragstart on completion cards so they can be dragged back to Progress
  el.querySelectorAll('[data-fab-done-idx]').forEach(card => {
    card.addEventListener('dragstart', e => {
      _fabDragIdx = parseInt(card.dataset.fabDoneIdx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.style.opacity = '0.4', 0);
    });
    card.addEventListener('dragend', () => card.style.opacity = '');
  });
}

// ── Fabrication Process Timeline ─────────────────────────────────────────────
function renderProcessTimeline() {
  const container = document.getElementById('fab-process-timeline');
  if (!container) return;

  const fab = project.fabrication || [];
  const withLogs = fab.filter(row => Array.isArray(row.processLog) && row.processLog.length > 0);

  if (!withLogs.length) {
    container.innerHTML = '';
    return;
  }

  const today = new Date();

  const itemHtml = withLogs.map(row => {
    const currentProcess = row.process;
    const logs = row.processLog;

    const stepsHtml = logs.map((entry, i) => {
      const isDone   = !!entry.completedAt;
      const isActive = !isDone && entry.process === currentProcess;
      const color    = isDone ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--text-muted)';
      const bgColor  = isDone ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--bg3)';
      const icon     = isDone ? '✓' : isActive ? '▶' : '○';

      let durationHtml = '';
      if (entry.startedAt && entry.completedAt) {
        const days = Math.max(1, Math.round(
          (new Date(entry.completedAt) - new Date(entry.startedAt)) / 86400000
        ));
        durationHtml = `<div style="font-size:9px;color:var(--green);margin-top:1px;">${days}d</div>`;
      } else if (entry.startedAt && isActive) {
        const days = Math.max(0, Math.round(
          (today - new Date(entry.startedAt)) / 86400000
        ));
        durationHtml = `<div style="font-size:9px;color:var(--accent);margin-top:1px;">${days}d in</div>`;
      }

      const connector = i > 0
        ? `<div style="flex:1;height:2px;background:${isDone ? 'var(--green)' : 'var(--border)'};margin-top:13px;min-width:16px;max-width:32px;"></div>`
        : '';

      return `${connector}<div style="display:flex;flex-direction:column;align-items:center;min-width:80px;max-width:100px;">
        <div style="width:26px;height:26px;border-radius:50%;background:${bgColor};border:2px solid ${color};
                    display:flex;align-items:center;justify-content:center;font-size:10px;
                    color:${isDone || isActive ? '#fff' : 'var(--text-muted)'};">${icon}</div>
        <div style="font-size:10px;font-weight:600;color:${color};text-align:center;margin-top:4px;line-height:1.2;">${escHtml(entry.process)}</div>
        ${entry.startedAt ? `<div style="font-size:9px;color:var(--text-muted);">↑ ${entry.startedAt}</div>` : ''}
        ${entry.completedAt ? `<div style="font-size:9px;color:var(--text-muted);">↓ ${entry.completedAt}</div>` : ''}
        ${durationHtml}
      </div>`;
    }).join('');

    return `<div style="margin-bottom:12px;padding:12px 16px;background:var(--card-bg);border-radius:8px;border:1px solid var(--border);">
      <div style="font-size:12px;font-weight:600;margin-bottom:10px;color:var(--text);">${escHtml(row.item || '—')}</div>
      <div style="display:flex;align-items:flex-start;overflow-x:auto;gap:0;padding-bottom:4px;">${stepsHtml}</div>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="section-label" style="margin-bottom:10px;">Process Timeline</div>
    ${itemHtml}
  `;
}

// ── TAB: Installation ────────────────────────────────────────────────────────
function renderInstallation() {
  const tbody = document.getElementById('install-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!Array.isArray(project.installation)) project.installation = [];

  if (!project.installation.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No installation items — add via /installation</td></tr>';
  } else {
    project.installation.forEach((row) => {
      const totalQty = Number(row.totalQty) || 0;
      const doneQty  = Number(row.doneQty)  || 0;
      const pct      = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;
      const pctColor = pct >= 100 ? 'var(--green)' : pct > 0 ? 'var(--amber)' : 'var(--text-muted)';
      const isDone   = totalQty > 0 && doneQty >= totalQty;
      const tr = document.createElement('tr');
      if (isDone) { tr.style.background = 'rgba(0,200,117,0.06)'; tr.style.borderLeft = '3px solid var(--green)'; }
      tr.innerHTML = `
        <td style="padding:8px 10px;font-size:13px;">${escHtml(row.item || '—')}</td>
        <td style="padding:8px 10px;font-size:13px;text-align:right;">${totalQty || '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.unit || '—')}</td>
        <td style="padding:8px 10px;font-size:13px;text-align:right;font-weight:600;color:${pct >= 100 ? 'var(--green)' : 'var(--text)'};">${doneQty}</td>
        <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${pctColor};">${pct}%</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-muted);">${escHtml(row.notes || '—')}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateInstallPct();
}

function buildInstallRow(row, idx) {
  const tr = document.createElement('tr');
  const totalQty = Number(row.totalQty) || 0;
  const doneQty  = Number(row.doneQty)  || 0;
  const pct = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;
  const pctColor = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--text-muted)';

  tr.innerHTML = `
    <td><input class="tbl-input inst-item" value="${escHtml(row.item||'')}" placeholder="Item" style="min-width:120px;"></td>
    <td><input class="tbl-input inst-totalqty" type="number" value="${totalQty}" min="0" style="width:70px;"></td>
    <td>
      <select class="tbl-input inst-unit" style="min-width:100px;">
        ${['units','set-of-1','set-of-2','set-of-3','set-of-4','set-of-5','pairs','lots']
          .map(u => `<option value="${u}"${(row.unit||'units') === u ? ' selected' : ''}>${u}</option>`).join('')}
      </select>
    </td>
    <td><input class="tbl-input inst-doneqty" type="number" value="${doneQty}" min="0" style="width:70px;"></td>
    <td><span class="install-pct-cell" style="font-weight:600; color:${pctColor};">${pct}%</span></td>
    <td>
      <select class="tbl-input inst-claimbasis" style="min-width:100px;">
        <option value="">—</option>
        <option value="Per unit"${row.claimBasis==='Per unit'?' selected':''}>Per unit</option>
        <option value="Lump sum"${row.claimBasis==='Lump sum'?' selected':''}>Lump sum</option>
        <option value="% complete"${row.claimBasis==='% complete'?' selected':''}>% complete</option>
        <option value="Milestone"${row.claimBasis==='Milestone'?' selected':''}>Milestone</option>
      </select>
    </td>
    <td><input class="tbl-input inst-notes" value="${escHtml(row.notes||'')}" placeholder="Notes" style="min-width:100px;"></td>
    <td><button class="btn btn-ghost btn-sm del-row-btn">✕</button></td>
  `;

  // Install tab is read-only — editing happens on the Installation page
  tr.querySelectorAll('input, select').forEach(el => { el.disabled = true; el.style.opacity = '0.8'; });
  const delBtn = tr.querySelector('.del-row-btn');
  if (delBtn) delBtn.style.display = 'none';

  // Show install log photo count if logs exist
  const logs = Array.isArray(row.logs) ? row.logs : [];
  if (logs.length) {
    const photoCount = logs.filter(l => l.photoPath).length;
    const td = document.createElement('td');
    td.innerHTML = `<span style="font-size:11px;color:var(--accent);">${photoCount} photo${photoCount !== 1 ? 's' : ''}</span>`;
    tr.appendChild(td);
  }

  const iItem       = tr.querySelector('.inst-item');
  const iTotalQty   = tr.querySelector('.inst-totalqty');
  const iUnit       = tr.querySelector('.inst-unit');
  const iDoneQty    = tr.querySelector('.inst-doneqty');
  const iClaimBasis = tr.querySelector('.inst-claimbasis');
  const iNotes      = tr.querySelector('.inst-notes');
  const pctSpan     = tr.querySelector('.install-pct-cell');

  const sync = () => {
    project.installation[idx].item       = iItem.value;
    project.installation[idx].totalQty   = Number(iTotalQty.value) || 0;
    project.installation[idx].unit       = iUnit.value;
    project.installation[idx].doneQty    = Number(iDoneQty.value)  || 0;
    project.installation[idx].claimBasis = iClaimBasis ? iClaimBasis.value : '';
    project.installation[idx].notes      = iNotes ? iNotes.value : '';
    const t = Number(iTotalQty.value) || 0;
    const d = Number(iDoneQty.value)  || 0;
    const p = t > 0 ? Math.round(d / t * 100) : 0;
    const c = p >= 80 ? 'var(--green)' : p >= 40 ? 'var(--amber)' : 'var(--text-muted)';
    pctSpan.textContent = p + '%';
    pctSpan.style.color = c;
    updateInstallPct();
    debouncedSave();
  };

  [iItem, iNotes].forEach(el => el && el.addEventListener('input', sync));
  [iTotalQty, iDoneQty].forEach(el => el && el.addEventListener('input', sync));
  [iUnit, iClaimBasis].forEach(el => el && el.addEventListener('change', sync));

  tr.querySelector('.del-row-btn').addEventListener('click', () => {
    project.installation.splice(idx, 1);
    renderInstallation();
    saveProject();
  });

  return tr;
}

function updateInstallPct() {
  const inst = project.installation || [];
  const total = inst.reduce((s, r) => s + (Number(r.totalQty) || 0), 0);
  const done  = inst.reduce((s, r) => s + (Number(r.doneQty)  || 0), 0);
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  project.installPercent = pct;

  const el = document.getElementById('install-pct-display');
  if (el) el.textContent = pct + '%';

  const finEl = document.getElementById('fin-installpct');
  if (finEl) finEl.textContent = fmtPct(pct);
  const barEl = document.getElementById('fin-install-bar');
  if (barEl) barEl.style.width = pct + '%';

  const contractVal = project.contractValue || 0;
  const claimable = contractVal * (pct / 100);
  const cvEl = document.getElementById('install-contract-value');
  const clEl = document.getElementById('install-claimable');
  if (cvEl) cvEl.textContent = fmtCurrency(contractVal);
  if (clEl) clEl.textContent = fmtCurrency(claimable);

  updateInstallLiveSummary();
}

function updateInstallLiveSummary() {
  const el = document.getElementById('install-live-summary');
  if (!el || !project.installation) return;
  const inst = project.installation.filter(f => f.totalQty > 0);
  if (!inst.length) { el.innerHTML = ''; return; }

  const totalQty = inst.reduce((s, f) => s + (Number(f.totalQty) || 0), 0);
  const doneQty  = inst.reduce((s, f) => s + (Number(f.doneQty)  || 0), 0);
  const pct = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;
  const color = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';

  // Only show fully installed items in Completion
  const doneInst = inst.filter(f => f.totalQty > 0 && Number(f.doneQty) >= Number(f.totalQty));
  if (!doneInst.length) {
    el.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--card-bg); border-radius:8px; margin-bottom:10px;">
        <div style="flex:1;">
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Overall Installation</div>
          <div class="progress-bar" style="height:8px;"><div class="progress-fill" style="width:${pct}%; background:${color};"></div></div>
        </div>
        <div style="font-size:22px; font-weight:700; color:${color}; min-width:52px; text-align:right;">${pct}%</div>
      </div>
      <div style="color:var(--text-muted);font-size:13px;padding:4px 0;">No items fully installed yet.</div>
    `;
    return;
  }

  const cards = doneInst.map(f => {
    const instIdx = project.installation.indexOf(f);
    return `<div draggable="true" data-inst-done-idx="${instIdx}" title="Drag up to move back to Progress"
      style="background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--green); border-radius:6px; padding:8px 12px; min-width:140px; cursor:grab;">
      <div style="font-size:12px; font-weight:600; margin-bottom:4px;">${escHtml(f.item || '')}</div>
      <div style="font-size:11px; color:var(--text-muted);">${f.doneQty || 0}/${f.totalQty || 0} ${escHtml(f.unit || 'units')}</div>
      <div style="font-size:10px; color:var(--green); margin-top:2px;">✓ Fully Installed</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--card-bg); border-radius:8px; margin-bottom:10px;">
      <div style="flex:1;">
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Overall Installation</div>
        <div class="progress-bar" style="height:8px;">
          <div class="progress-fill" style="width:${pct}%; background:${color};"></div>
        </div>
      </div>
      <div style="font-size:22px; font-weight:700; color:${color}; min-width:52px; text-align:right;">${pct}%</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">${cards}</div>
  `;

  // Wire dragstart on completion cards — drag back up to Progress resets to 0
  el.querySelectorAll('[data-inst-done-idx]').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.instDoneIdx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.style.opacity = '0.4', 0);
    });
    card.addEventListener('dragend', () => card.style.opacity = '');
  });

  const tbody = document.getElementById('install-tbody');
  if (tbody) {
    tbody.ondragover = e => { e.preventDefault(); tbody.style.outline = '2px dashed var(--amber)'; };
    tbody.ondragleave = () => tbody.style.outline = '';
    tbody.ondrop = e => {
      e.preventDefault();
      tbody.style.outline = '';
      const idx = parseInt(e.dataTransfer.getData('text/plain'));
      if (isNaN(idx)) return;
      project.installation[idx].doneQty = 0;
      renderInstallation(); updateInstallLiveSummary(); debouncedSave();
      showToast('Moved back to Progress', 'success');
    };
  }
}

// ── Tab: Site Requests (read-only consolidation) ─────────────────────────────
// Site requests are pulls from the install team, raised on /installation.
// This tab is read-only on /project — creating/editing happens on the ops pages.
async function renderDeliveryRequestsTab() {
  const list = document.getElementById('delivery-requests-list');
  if (!list) return;

  const hdrLabel = document.querySelector('[data-tab-label="delivery-requests"]');
  if (hdrLabel) hdrLabel.textContent = 'Site Requests';

  const addBtn = document.getElementById('delivery-add-btn');
  if (addBtn) addBtn.style.display = 'none';

  list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Loading…</p>';

  let srs = [];
  try {
    const res = await fetch('/api/site-requests');
    if (res.ok) srs = await res.json();
  } catch (e) { console.error('[project] site-requests fetch failed:', e); }

  const mine = (srs || []).filter(r => r.projectId === project.id);
  list.innerHTML = '';

  if (!mine.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No site requests for this project yet. The install team raises these from the Installation page.</p>';
    return;
  }

  mine.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  mine.forEach(sr => list.appendChild(buildSiteRequestCardReadonly(sr)));
}

function buildSiteRequestCardReadonly(sr) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate = d => {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.getDate() + ' ' + months[dt.getMonth()] + ' ' + dt.getFullYear();
  };
  const status = sr.status || 'New';
  const statusColors = {
    'New':          ['#fef3c7', '#92400e'],
    'Acknowledged': ['#dbeafe', '#1e40af'],
    'Ready':        ['#dcfce7', '#166534'],
    'Delivered':    ['#e5e7eb', '#374151'],
    'Issue':        ['#fee2e2', '#991b1b'],
  };
  const [bg, fg] = statusColors[status] || ['#e5e7eb', '#374151'];

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:10px; padding:12px;';
  card.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <span style="font-size:13px; font-weight:600; flex:1;">${escHtml(sr.item || '(no item)')}</span>
      <span style="font-size:11px; color:var(--text-muted);">${sr.quantity || sr.qtyRequested || '—'} ${escHtml(sr.unit || '')}</span>
      ${sr.neededByDate ? `<span style="font-size:11px; color:var(--text-muted);">Needed by ${fmtDate(sr.neededByDate)}</span>` : ''}
      <span style="background:${bg}; color:${fg}; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;">${status}</span>
    </div>
    <div style="margin-top:6px; font-size:11px; color:var(--text-muted);">
      Requested${sr.requestedBy ? ' by ' + escHtml(sr.requestedBy) : ''}${sr.createdAt ? ' on ' + fmtDate(sr.createdAt) : ''}
      ${sr.acknowledgedAt ? ' · Seen ' + fmtDate(sr.acknowledgedAt) : ''}
      ${sr.deliveredAt ? ' · Delivered ' + fmtDate(sr.deliveredAt) : ''}
    </div>
  `;
  return card;
}


// ── TAB 6: Payment Milestones ─────────────────────────────────────────────────
function renderPayment() {
  const tbody = document.getElementById('payment-tbody');
  tbody.innerHTML = '';

  if (!Array.isArray(project.paymentMilestones)) project.paymentMilestones = [];

  project.paymentMilestones.forEach((row, idx) => {
    tbody.appendChild(buildPaymentRow(row, idx));
  });

  updatePaymentSummary();

  document.getElementById('payment-add-btn').onclick = () => {
    project.paymentMilestones.push({
      milestone: '', type: 'Contract', basis: '', pct: 0,
      qty: 0, unitRate: 0, amount: 0, status: 'Not Due', date: '', ref: '',
    });
    const idx = project.paymentMilestones.length - 1;
    tbody.appendChild(buildPaymentRow(project.paymentMilestones[idx], idx));
    updatePaymentSummary();
    debouncedSave();
  };
}

function buildPaymentRow(row, idx) {
  const sn = idx + 1;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${sn}</td>
    <td><input class="tbl-input" value="${escHtml(row.milestone || '')}" placeholder="Milestone" style="min-width:140px;"></td>
    <td>
      <select class="tbl-select pay-type">
        <option${row.type === 'Contract' ? ' selected' : ''}>Contract</option>
        <option${row.type === 'VO'       ? ' selected' : ''}>VO</option>
      </select>
    </td>
    <td><input class="tbl-input" value="${escHtml(row.basis || '')}" placeholder="Basis" style="min-width:100px;"></td>
    <td><input class="tbl-input" type="number" value="${Number(row.pct) || 0}" min="0" max="100" style="min-width:55px;"></td>
    <td><input class="tbl-input" type="number" value="${Number(row.qty) || 0}" min="0" style="min-width:55px;"></td>
    <td><input class="tbl-input" type="number" value="${Number(row.unitRate) || 0}" min="0" step="0.01" style="min-width:80px;"></td>
    <td><input class="tbl-input" type="number" value="${Number(row.amount) || 0}" min="0" step="0.01" style="min-width:90px;"></td>
    <td>
      <select class="tbl-select pay-status">
        <option${row.status === 'Not Due'  ? ' selected' : ''}>Not Due</option>
        <option${row.status === 'Due'      ? ' selected' : ''}>Due</option>
        <option${row.status === 'Claimed'  ? ' selected' : ''}>Claimed</option>
        <option${row.status === 'Paid'     ? ' selected' : ''}>Paid</option>
      </select>
    </td>
    <td><input class="tbl-input" type="date" value="${escHtml(row.date || '')}"></td>
    <td><input class="tbl-input" value="${escHtml(row.ref || '')}" placeholder="Ref" style="min-width:80px;"></td>
    <td><button class="btn btn-ghost btn-sm del-row-btn" title="Remove">✕</button></td>
  `;

  const inputs = tr.querySelectorAll('input');
  const [iMilestone, iBasis, iPct, iQty, iUnitRate, iAmount, iDate, iRef] = inputs;
  const iType   = tr.querySelector('.pay-type');
  const iStatus = tr.querySelector('.pay-status');

  const sync = () => {
    project.paymentMilestones[idx].milestone = iMilestone.value;
    project.paymentMilestones[idx].type      = iType.value;
    project.paymentMilestones[idx].basis     = iBasis.value;
    project.paymentMilestones[idx].pct       = Number(iPct.value) || 0;
    project.paymentMilestones[idx].qty       = Number(iQty.value) || 0;
    project.paymentMilestones[idx].unitRate  = Number(iUnitRate.value) || 0;
    project.paymentMilestones[idx].amount    = Number(iAmount.value) || 0;
    project.paymentMilestones[idx].status    = iStatus.value;
    project.paymentMilestones[idx].date      = iDate.value;
    project.paymentMilestones[idx].ref       = iRef.value;
    updatePaymentSummary();
    debouncedSave();
  };

  inputs.forEach(inp => inp.addEventListener(inp.type === 'number' || inp.type === 'date' ? 'change' : 'input', sync));
  iType.addEventListener('change', sync);
  iStatus.addEventListener('change', sync);

  tr.querySelector('.del-row-btn').addEventListener('click', () => {
    project.paymentMilestones.splice(idx, 1);
    renderPayment();
    saveProject();
  });

  return tr;
}

function updatePaymentSummary() {
  const milestones = project.paymentMilestones || [];
  const contractRows = milestones.filter(m => m.type === 'Contract');
  const totalContract = contractRows.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const paidContract  = contractRows
    .filter(m => m.status === 'Paid' || m.status === 'Claimed')
    .reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const pct = totalContract > 0 ? (paidContract / totalContract * 100) : 0;
  const pctRound = Math.round(pct);
  const color = pctRound >= 80 ? 'var(--green)' : pctRound >= 40 ? 'var(--amber)' : 'var(--accent)';

  // Progress bar at top of tab
  const barEl = document.getElementById('payment-summary-bar');
  if (barEl && totalContract > 0) {
    barEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--card-bg); border-radius:8px; border:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Total Claimed</div>
          <div class="progress-bar" style="height:8px;">
            <div class="progress-fill" style="width:${pctRound}%; background:${color};"></div>
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${fmtCurrency(paidContract)} of ${fmtCurrency(totalContract)}</div>
        </div>
        <div style="font-size:22px; font-weight:700; color:${color}; min-width:52px; text-align:right;">${pctRound}%</div>
      </div>
    `;
  } else if (barEl) {
    barEl.innerHTML = '';
  }

  document.getElementById('payment-paid-display').textContent = fmtCurrency(paidContract);
  document.getElementById('payment-pct-display').textContent  = fmtPct(pct);

  // Auto-update project.paidAmount from Paid milestones (hidden field + display div + fin bar)
  const paid = milestones
    .filter(m => m.status === 'Paid')
    .reduce((s, m) => s + (Number(m.amount) || 0), 0);
  project.paidAmount = paid;
  const hiddenPaid = document.getElementById('field-paidAmount');
  if (hiddenPaid) hiddenPaid.value = paid;
  const displayPaid = document.getElementById('field-paidAmount-display');
  if (displayPaid) displayPaid.textContent = paid > 0 ? fmtCurrency(paid) : '—';
  renderFinBar();
}

// ── TAB 9: Meeting Notes ──────────────────────────────────────────────────────
function formatLoggedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function syncLatestNoteFromMeetings() {
  if (!Array.isArray(project.meetingNotes) || !project.meetingNotes.length) return;
  const sorted = [...project.meetingNotes]
    .filter(m => m.notes && m.notes.trim())
    .sort((a, b) => {
      const da = a.date || a.loggedAt || '';
      const db = b.date || b.loggedAt || '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.localeCompare(da);
    });
  if (!sorted.length) return;
  const latest = sorted[0];
  const who = latest.loggedBy ? ` (${latest.loggedBy})` : '';
  const noteText = latest.date
    ? `[${latest.date}${who}] ${latest.notes.trim().slice(0, 200)}`
    : latest.notes.trim().slice(0, 200);
  project.latestNotes = noteText;
  const el = document.getElementById('field-latestNotes');
  if (el) el.value = noteText;
}

function renderMeetings() {
  const container = document.getElementById('meetings-list');
  container.innerHTML = '';

  if (!Array.isArray(project.meetingNotes)) project.meetingNotes = [];

  // Auto-sync latest note on render
  syncLatestNoteFromMeetings();

  // Sort newest first for display (work on a sorted index map)
  const sorted = project.meetingNotes
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const da = a.m.date || '';
      const db = b.m.date || '';
      return db.localeCompare(da);
    });

  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty-state">No meeting notes yet. Click "+ Add Meeting Note" to add one.</div>';
  }

  sorted.forEach(({ m, i }) => {
    container.appendChild(buildMeetingCard(m, i));
  });

  document.getElementById('meeting-add-btn').onclick = () => {
    project.meetingNotes.push({
      date: '',
      attendees: '',
      notes: '',
      issues: '',
      loggedBy: '',
      loggedAt: new Date().toISOString()
    });
    renderMeetings();
    debouncedSave();
  };
}

function buildMeetingCard(row, idx) {
  const div = document.createElement('div');
  div.className = 'card';
  div.style.marginBottom = '12px';
  div.innerHTML = `
    <div class="meeting-meta">
      <span class="meeting-logged-by">
        📝 Logged by:
        <select class="meeting-loggedby-sel tbl-select">
          ${staffOptionsHtml(row.loggedBy || '')}
        </select>
      </span>
      <span class="meeting-logged-at">${formatLoggedAt(row.loggedAt || '')}</span>
    </div>
    <div style="display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap; margin-bottom:10px;">
      <div class="field" style="margin:0; flex:0 0 160px;">
        <label>Date</label>
        <input type="date" value="${escHtml(row.date || '')}">
      </div>
      <div class="field" style="margin:0; flex:1 1 200px;">
        <label>Attendees</label>
        <input type="text" value="${escHtml(row.attendees || '')}" placeholder="Names / organisations">
      </div>
      <div style="margin-left:auto; padding-top:22px;">
        <button class="btn btn-danger btn-sm del-meeting-btn">Delete</button>
      </div>
    </div>
    <div class="field" style="margin:0 0 10px;">
      <label>Notes</label>
      <textarea class="notes-big meeting-notes" rows="5" placeholder="Meeting minutes, action items…">${escHtml(row.notes || '')}</textarea>
    </div>
    <div class="field" style="margin:0;">
      <label>Issues / Defects Raised</label>
      <textarea class="meeting-issues" rows="2" placeholder="Any defects, snags or issues raised in this meeting…">${escHtml(row.issues || '')}</textarea>
    </div>
    <div class="action-items-section">
      <div class="section-label" style="margin-top:12px;">Action Items</div>
      <div class="action-items-list" id="action-items-${idx}"></div>
      <button class="btn btn-ghost btn-sm add-action-btn" style="margin-top:4px;">+ Add Action Item</button>
    </div>
  `;

  const iDate       = div.querySelector('input[type="date"]');
  const iAttendees  = div.querySelector('input[type="text"]');
  const iNotes      = div.querySelector('.meeting-notes');
  const iIssues     = div.querySelector('.meeting-issues');
  const iLoggedBy   = div.querySelector('.meeting-loggedby-sel');

  iLoggedBy.addEventListener('change', function () {
    project.meetingNotes[idx].loggedBy = this.value;
    syncLatestNoteFromMeetings();
    debouncedSave();
  });

  iDate.addEventListener('change', function () {
    project.meetingNotes[idx].date = this.value;
    syncLatestNoteFromMeetings();
    debouncedSave();
  });

  iAttendees.addEventListener('input', function () {
    project.meetingNotes[idx].attendees = this.value;
    debouncedSave();
  });

  iNotes.addEventListener('input', function () {
    project.meetingNotes[idx].notes = this.value;
    syncLatestNoteFromMeetings();
    debouncedSave();
  });

  iIssues.addEventListener('input', function () {
    project.meetingNotes[idx].issues = this.value;
    debouncedSave();
  });

  div.querySelector('.del-meeting-btn').addEventListener('click', () => {
    const confirmed = confirm('Delete this meeting note?');
    if (!confirmed) return;
    project.meetingNotes.splice(idx, 1);
    renderMeetings();
    saveProject();
  });

  // Action items — add row on click
  div.querySelector('.add-action-btn').addEventListener('click', () => {
    const list = div.querySelector('.action-items-list');
    const row = document.createElement('div');
    row.className = 'action-item-row';
    row.innerHTML =
      '<input type="text" class="tbl-input action-title" placeholder="What needs to be done\u2026">' +
      '<select class="tbl-select action-assignee"><option value="">Assign to\u2026</option>' +
        staffOptionsHtml('').replace('<option value="">— Select —</option>', '') +
      '</select>' +
      '<input type="date" class="tbl-input action-due">' +
      '<select class="tbl-select action-priority">' +
        '<option>Normal</option><option>High</option><option>Urgent</option><option>Low</option>' +
      '</select>' +
      '<button class="btn btn-sm action-create-btn" style="background:var(--accent);color:#fff;">Create Task</button>' +
      '<button class="btn btn-ghost btn-sm action-remove-btn" style="color:var(--red);">\u2715</button>';

    row.querySelector('.action-create-btn').addEventListener('click', () => createTaskFromAction(row, idx));
    row.querySelector('.action-remove-btn').addEventListener('click', () => row.remove());
    list.appendChild(row);
  });

  return div;
}

// ── Task creation from action items ──────────────────────────────────────────
async function createTaskFromAction(actionRow, meetingNoteIdx) {
  const title = actionRow.querySelector('.action-title').value.trim();
  const assignedTo = actionRow.querySelector('.action-assignee').value;
  const dueDate = actionRow.querySelector('.action-due').value;
  const priority = actionRow.querySelector('.action-priority').value;
  if (!title) { showToast('Enter a task title', 'error'); return; }

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        projectJobCode: project.jobCode || '',
        projectName: project.projectName || '',
        title,
        assignedTo,
        dueDate,
        priority,
        taskType: 'Project Task',
        createdBy: 'Director',
        linkedMeetingNoteIdx: meetingNoteIdx
      })
    });
    if (res.ok) {
      showToast('Task created \u2705', 'success');
      const btn = actionRow.querySelector('.action-create-btn');
      btn.textContent = '\u2705 Created';
      btn.disabled = true;
    } else {
      showToast('Failed to create task', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function saveProject() {
  if (!project) return;
  try {
    await api('PUT', `/api/projects/${projectId}`, project);
    showToast('Saved', 'success');
  } catch (err) {
    console.error('Save error:', err);
    showToast('Save failed.', 'error');
  }
}

// ── HTML escape helper ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Claims Tracker ───────────────────────────────────────────────────────────

async function renderClaimsTab() {
  const listEl  = document.getElementById('claims-list');
  const stripEl = document.getElementById('claims-summary-strip');
  if (!listEl || !projectId) return;

  listEl.innerHTML  = '<div style="color:var(--text-muted);font-size:13px;">Loading…</div>';
  stripEl.innerHTML = '';

  let claims = [];
  try {
    claims = await api('GET', `/api/claims?projectId=${projectId}`);
  } catch (e) {
    listEl.innerHTML = '<div style="color:var(--red);font-size:13px;">Failed to load claims.</div>';
    return;
  }

  // ── Summary Strip ──
  const total   = claims.length;
  const pending = claims.filter(c => c.status === 'Awaiting Certification').length;
  const cert    = claims.filter(c => c.status === 'Certified').length;
  const inv     = claims.filter(c => c.status === 'Invoiced').length;
  const paid    = claims.filter(c => c.status === 'Paid').length;
  const todayStr = new Date().toISOString().split('T')[0];
  const overdue = claims.filter(c =>
    c.status !== 'Paid' && c.certificationDue && c.certificationDue < todayStr
  ).length;
  const disputed= claims.filter(c => c.status === 'Disputed').length;

  const totalAmt = claims.reduce((s,c) => s + (parseFloat(c.claimAmount)||0), 0);
  const paidAmt  = claims.filter(c=>c.status==='Paid').reduce((s,c) => s + (parseFloat(c.paymentReceivedAmount)||parseFloat(c.claimAmount)||0), 0);

  stripEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;">
      <div class="claim-stat-box">
        <div class="claim-stat-val">${total}</div>
        <div class="claim-stat-lbl">Total Claims</div>
      </div>
      <div class="claim-stat-box">
        <div class="claim-stat-val" style="color:var(--amber);">${pending}</div>
        <div class="claim-stat-lbl">Awaiting Cert</div>
      </div>
      <div class="claim-stat-box">
        <div class="claim-stat-val" style="color:var(--accent);">${cert + inv}</div>
        <div class="claim-stat-lbl">Certified/Invoiced</div>
      </div>
      <div class="claim-stat-box">
        <div class="claim-stat-val" style="color:var(--green);">${paid}</div>
        <div class="claim-stat-lbl">Paid</div>
      </div>
      ${overdue > 0 ? `<div class="claim-stat-box"><div class="claim-stat-val" style="color:var(--red);">${overdue}</div><div class="claim-stat-lbl">Overdue</div></div>` : ''}
      ${disputed > 0 ? `<div class="claim-stat-box"><div class="claim-stat-val" style="color:var(--red);">${disputed}</div><div class="claim-stat-lbl">Disputed</div></div>` : ''}
      <div class="claim-stat-box">
        <div class="claim-stat-val" style="font-size:13px;">${fmtCurrency(paidAmt)}</div>
        <div class="claim-stat-lbl">Received</div>
      </div>
      <div class="claim-stat-box">
        <div class="claim-stat-val" style="font-size:13px;">${fmtCurrency(totalAmt)}</div>
        <div class="claim-stat-lbl">Total Claimed</div>
      </div>
    </div>
  `;

  // ── Claim Cards ──
  if (!claims.length) {
    listEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px;">No claims yet. Tap + New Claim to start.</div>`;
  } else {
    listEl.innerHTML = claims.map(c => buildClaimCard(c)).join('');

    // Wire status change dropdowns
    listEl.querySelectorAll('.claim-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id;
        const patch = { status: sel.value };
        // When marking certified, prompt for certified date
        if (sel.value === 'Certified') {
          const d = prompt('Enter certification date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
          if (d) patch.certifiedDate = d;
        }
        // When marking paid, prompt for paid date + ref
        if (sel.value === 'Paid') {
          const d = prompt('Enter payment received date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
          if (d) patch.paymentReceivedDate = d;
          const ref = prompt('Payment reference (bank ref / cheque no):');
          if (ref) patch.notes = (patch.notes || '') + ' Ref: ' + ref;
        }
        try {
          // Get full claim first, merge patch
          const all = await api('GET', `/api/claims?projectId=${projectId}`);
          const existing = all.find(x => x.id === id);
          if (!existing) return;
          await api('PUT', `/api/claims/${id}`, { ...existing, ...patch });
          renderClaimsTab();
        } catch (e) {
          showToast('Update failed', 'error');
        }
      });
    });

    // Wire delete buttons
    listEl.querySelectorAll('.claim-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showPinModal(async (pin) => {
          const result = await api('POST', '/api/admin/pin', { action: 'verify', pin });
          if (!result.ok) return false;
          await api('DELETE', `/api/claims/${btn.dataset.id}`, { pin });
          renderClaimsTab();
          return true;
        });
      });
    });
  }

  // ── New Claim button ──
  const addBtn = document.getElementById('claim-add-btn');
  if (addBtn) {
    addBtn.onclick = () => showNewClaimModal();
  }
}

function buildClaimCard(c) {
  const statusColors = {
    'Awaiting Certification': 'var(--amber)',
    'Certified':   'var(--accent)',
    'Invoiced':    'var(--accent)',
    'Paid':        'var(--green)',
    'Disputed':    'var(--red)',
    'Overdue':     'var(--red)',
  };
  const color = statusColors[c.status] || 'var(--text-muted)';

  const today = new Date().toISOString().split('T')[0];
  const certDue    = c.certificationDue || '—';
  const payDue     = c.paymentDue       || '—';
  const certOverdue = c.certificationDue && c.certificationDue < today && c.status === 'Awaiting Certification';
  const payOverdue  = c.paymentDue      && c.paymentDue      < today && (c.status === 'Certified' || c.status === 'Invoiced');

  return `
    <div class="claim-card">
      <div class="claim-card-header">
        <div>
          <div class="claim-card-title">Claim #${escHtml(String(c.claimNumber || '—'))}
            ${c.description ? `<span class="claim-card-desc"> — ${escHtml(c.description)}</span>` : ''}
          </div>
          <div class="claim-card-meta">
            Submitted: ${escHtml(c.submittedDate || '—')}
            · Amount: <strong>${fmtCurrency(parseFloat(c.claimAmount)||0)}</strong>
            ${c.invoiceNumber ? `· Inv: ${escHtml(c.invoiceNumber)}` : ''}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <select class="claim-status-select" data-id="${escHtml(c.id)}" style="font-size:12px;padding:4px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);color:${color};">
            ${['Awaiting Certification','Certified','Invoiced','Paid','Disputed','Overdue'].map(s =>
              `<option value="${s}"${s===c.status?' selected':''}>${s}</option>`
            ).join('')}
          </select>
          <button class="btn btn-ghost btn-sm claim-delete-btn" data-id="${escHtml(c.id)}" style="color:var(--red);padding:4px 8px;">✕</button>
        </div>
      </div>
      <div class="claim-card-dates">
        <div class="claim-date-item ${certOverdue?'claim-date-overdue':''}">
          <div class="claim-date-label">Cert Due (SOP +21d)</div>
          <div class="claim-date-val">${escHtml(certDue)}${certOverdue?' ⚠️':''}</div>
        </div>
        <div class="claim-date-item ${payOverdue?'claim-date-overdue':''}">
          <div class="claim-date-label">Payment Due (SOP +35d)</div>
          <div class="claim-date-val">${escHtml(payDue)}${payOverdue?' ⚠️':''}</div>
        </div>
        ${c.certifiedDate ? `
        <div class="claim-date-item">
          <div class="claim-date-label">Certified On</div>
          <div class="claim-date-val">${escHtml(c.certifiedDate)}</div>
        </div>` : ''}
        ${c.paymentReceivedDate ? `
        <div class="claim-date-item">
          <div class="claim-date-label">Paid On</div>
          <div class="claim-date-val" style="color:var(--green);">${escHtml(c.paymentReceivedDate)}</div>
        </div>` : ''}
        ${c.paymentReceivedAmount ? `
        <div class="claim-date-item">
          <div class="claim-date-label">Amt Received</div>
          <div class="claim-date-val">${fmtCurrency(parseFloat(c.paymentReceivedAmount)||0)}</div>
        </div>` : ''}
      </div>
      ${c.notes ? `<div class="claim-card-notes">${escHtml(c.notes)}</div>` : ''}
    </div>
  `;
}

function showNewClaimModal() {
  // Remove existing modal if any
  const existing = document.getElementById('claim-modal-overlay');
  if (existing) existing.remove();

  const today = new Date().toISOString().split('T')[0];

  const overlay = document.createElement('div');
  overlay.id = 'claim-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  overlay.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div style="font-size:15px;font-weight:700;">New Progress Claim</div>
        <button id="claim-modal-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Claim No.</label>
          <input id="cm-claimNo" type="text" placeholder="e.g. PC-01" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Description</label>
          <input id="cm-description" type="text" placeholder="e.g. Supply & install bollards at Gate A" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Claim Amount (S$)</label>
          <input id="cm-amount" type="number" min="0" step="0.01" placeholder="0.00" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Submitted Date</label>
          <input id="cm-submittedDate" type="date" value="${today}" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Invoice Ref (optional)</label>
          <input id="cm-invoiceRef" type="text" placeholder="e.g. INV-2026-001" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Notes (optional)</label>
          <textarea id="cm-notes" rows="2" placeholder="Any supporting notes…" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:13px;resize:vertical;box-sizing:border-box;"></textarea>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:20px;">
        <button class="btn btn-primary" id="claim-modal-save" style="flex:1;padding:12px;">Save Claim</button>
        <button class="btn btn-ghost" id="claim-modal-cancel" style="padding:12px 16px;">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#claim-modal-close').onclick  = () => overlay.remove();
  overlay.querySelector('#claim-modal-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#claim-modal-save').addEventListener('click', async () => {
    const claimNumber   = document.getElementById('cm-claimNo').value.trim();
    const description   = document.getElementById('cm-description').value.trim();
    const claimAmount   = parseFloat(document.getElementById('cm-amount').value) || 0;
    const submittedDate = document.getElementById('cm-submittedDate').value;
    const invoiceNumber = document.getElementById('cm-invoiceRef').value.trim();
    const notes         = document.getElementById('cm-notes').value.trim();

    if (!claimNumber || !submittedDate) {
      showToast('Claim No. and submitted date are required.', 'error');
      return;
    }

    const saveBtn = overlay.querySelector('#claim-modal-save');
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;

    try {
      await api('POST', '/api/claims', {
        projectId,
        claimNumber,
        description,
        claimAmount,
        submittedDate,
        invoiceNumber,
        notes
      });
      overlay.remove();
      renderClaimsTab();
      showToast('Claim saved', 'success');
    } catch (e) {
      showToast('Failed to save claim.', 'error');
      saveBtn.textContent = 'Save Claim';
      saveBtn.disabled = false;
    }
  });
}

// ── History Tab ───────────────────────────────────────────────────────────────
async function renderHistoryTab() {
  const container = document.getElementById('history-timeline');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:16px 0;">Loading…</div>';

  let logs = [];
  try {
    logs = await api('GET', `/api/logs?type=activity&projectId=${encodeURIComponent(projectId)}&limit=200`);
    if (!Array.isArray(logs)) logs = [];
  } catch (e) {
    container.innerHTML = '<div style="color:var(--red); font-size:13px; padding:16px 0;">Failed to load history.</div>';
    return;
  }

  if (logs.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:16px 0;">No history recorded yet for this project.</div>';
    return;
  }

  // Badge colour per action prefix
  function badgeColor(action) {
    if (action.startsWith('project.field_changed')) return 'var(--amber)';
    if (action.startsWith('project.')) return 'var(--accent)';
    if (action.startsWith('fab.'))     return 'var(--green)';
    if (action.startsWith('install.')) return '#8b5cf6';
    if (action.startsWith('task.'))    return 'var(--blue, #3b82f6)';
    return 'var(--text-muted)';
  }

  function formatDetails(log) {
    const d = log.details || {};
    const parts = [];
    if (d.changes && Array.isArray(d.changes) && d.changes.length > 0) {
      parts.push(d.changes.map(c =>
        `<span style="color:var(--text-muted);">${escHtml(c.field)}:</span> ` +
        `<span style="color:var(--red); text-decoration:line-through;">${escHtml(String(c.from ?? '—'))}</span> ` +
        `→ <span style="color:var(--green);">${escHtml(String(c.to ?? '—'))}</span>`
      ).join(' &nbsp;|&nbsp; '));
    }
    if (d.item) parts.push(`<span style="color:var(--text-muted);">item:</span> ${escHtml(d.item)}`);
    if (d.jobCode && !parts.length) parts.push(`<span style="color:var(--text-muted);">job:</span> ${escHtml(d.jobCode)}`);
    return parts.join(' &nbsp;·&nbsp; ');
  }

  const html = logs.map(log => {
    const ts = new Date(log.timestamp);
    const dateStr = ts.toLocaleDateString('en-SG', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = ts.toLocaleTimeString('en-SG', { hour:'2-digit', minute:'2-digit', hour12:false });
    const color = badgeColor(log.action);
    const detail = formatDetails(log);
    return `
      <div style="display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); align-items:flex-start;">
        <div style="min-width:110px; font-size:11px; color:var(--text-muted); padding-top:2px;">
          ${dateStr}<br>${timeStr}
        </div>
        <div style="flex:1;">
          <span style="display:inline-block; font-size:11px; font-weight:600; color:${color}; background:${color}22; border-radius:4px; padding:2px 7px; margin-bottom:4px;">${escHtml(log.action)}</span>
          ${detail ? `<div style="font-size:12px; color:var(--text); margin-top:3px;">${detail}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div style="font-size:12px;">${html}</div>`;

  // Bind refresh button
  const refreshBtn = document.getElementById('history-refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = renderHistoryTab;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();

