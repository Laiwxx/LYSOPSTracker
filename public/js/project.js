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

// No default documents — users create their own folder structure per project.

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
  if (!Array.isArray(project.documents)) project.documents = [];
  // Ensure every doc has group + files array
  project.documents.forEach(doc => {
    if (!doc.group) doc.group = 'General';
    if (!Array.isArray(doc.files)) doc.files = [];
  });
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
  renderStageProgress();
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
      alert('Admin password not configured. Please set one in Admin Settings before deleting projects.');
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
    if (!pin) { errDiv.textContent = 'Enter admin password.'; errDiv.style.display = 'block'; return; }
    confirm.disabled = true;
    confirm.textContent = '…';
    try {
      const ok = await onConfirm(pin);
      if (ok === false) { errDiv.textContent = 'Incorrect password.'; errDiv.style.display = 'block'; confirm.disabled = false; confirm.textContent = 'Delete Project'; }
      else { cleanup(); }
    } catch (err) { errDiv.textContent = err.message || 'Error. Try again.'; errDiv.style.display = 'block'; confirm.disabled = false; confirm.textContent = 'Delete Project'; }
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

  // fabPercent: live from fabrication rows (exclude parent containers)
  const fabRows  = (project.fabrication || []).filter(r => !r.isMechanicalParent);
  const fabTotal = fabRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const fabDone  = fabRows.reduce((s, r) => s + (parseFloat(r.qtyDone)  || 0), 0);
  const fabPct   = fabTotal > 0 ? Math.round(fabDone / fabTotal * 100) : 0;
  project.fabPercent = fabPct;

  // installPercent: live from installation rows (read both field names)
  const instRows  = project.installation || [];
  const instTotal = instRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const instDone  = instRows.reduce((s, r) => s + (parseFloat(r.doneQty) || parseFloat(r.qtyDone) || 0), 0);
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

// ── Stage Progress (auto-derived, with trigger reasons) ─────────────────────
function renderStageProgress() {
  const el = document.getElementById('stage-progress-list');
  if (!el) return;

  const stages = project.stages || [];
  if (!stages.length) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:6px 0;">No stages defined.</div>';
    return;
  }

  // Build trigger reasons client-side (mirrors server deriveStages logic)
  const fab       = project.fabrication   || [];
  const inst      = project.installation  || [];
  const docs      = project.documents     || [];
  const drawings  = project.drawings      || [];
  const meetings  = project.meetingNotes  || [];
  const ms        = project.paymentMilestones || [];
  const prpo      = project.prpo          || [];

  const safetyDocs = docs.filter(d => (d.group || '').includes('Safety'));
  const drawingDocs = docs.filter(d => /shop.?draw|drawing/i.test(d.name || ''));
  const sicDocs = docs.filter(d => /sic/i.test(d.name || ''));

  // Trigger reason map — explains WHY each stage has its status
  const reasons = {
    'Quotation':            () => project.contractValue ? 'Contract value set ($' + Number(project.contractValue).toLocaleString() + ')' : 'No contract value',
    'LOI Received':         () => project.contractValue ? 'Contract value set' : 'No contract value',
    'Awarded':              () => project.contractValue ? 'Contract value: $' + Number(project.contractValue).toLocaleString() : 'No contract value set',
    'LOA Received':         () => project.contractValue ? 'Contract value set' : 'No contract value',
    'Contract Review':      () => project.contractValue ? 'Contract value exists' : 'No contract value',
    'QS Breakdown':         () => project.qs ? 'QS: ' + project.qs : 'No QS assigned',
    'Job Code Created':     () => project.jobCode ? 'Code: ' + project.jobCode : 'No job code',
    'Kick-off Meeting':     () => { const m = meetings.find(m2 => m2.date || m2.notes); return m ? 'Meeting logged' + (m.date ? ' on ' + m.date : '') : 'No meeting notes in Meetings tab'; },
    'Kickoff Meeting':      () => { const m = meetings.find(m2 => m2.date || m2.notes); return m ? 'Meeting logged' + (m.date ? ' on ' + m.date : '') : 'No meeting notes in Meetings tab'; },
    'Safety Document Submission': () => {
      const submitted = safetyDocs.filter(d => d.status && d.status !== 'Not Submitted').length;
      return submitted > 0 ? submitted + '/' + safetyDocs.length + ' safety docs submitted' : safetyDocs.length + ' safety docs — none submitted yet (Documents tab)';
    },
    'Drawing Submission':   () => {
      const hasFiles = drawings.length > 0;
      const hasDoc = drawingDocs.some(d => d.status && d.status !== 'Not Submitted');
      if (hasDoc) return 'Shop drawing submitted in Documents tab';
      if (hasFiles) return drawings.length + ' drawing file(s) uploaded';
      return 'No drawings uploaded (Drawings tab) and no shop drawing submitted (Documents tab)';
    },
    'Drawing Approved':     () => { const a = drawingDocs.find(d => d.status === 'Approved'); return a ? 'Shop drawing approved' : 'Shop drawing not yet approved (Documents tab)'; },
    'SIC Submission':       () => { const s = sicDocs.find(d => d.status && d.status !== 'Not Submitted'); return s ? 'SIC doc: ' + s.status : 'SIC not submitted (Documents tab)'; },
    'Assign to Factory':    () => {
      const started = fab.filter(r => r.status !== 'Not Started').length;
      return fab.length > 0 ? fab.length + ' fab items (' + started + ' started)' : 'No fab items created yet (Product Scope)';
    },
    'Factory Take-off':     () => {
      const withLogs = fab.filter(r => Array.isArray(r.logs) && r.logs.length > 0).length;
      const started = fab.filter(r => r.status !== 'Not Started').length;
      if (withLogs > 0) return withLogs + ' fab items have daily logs (Factory page)';
      if (started > 0) return started + ' fab items started';
      return fab.length > 0 ? fab.length + ' fab items — none started (Factory page)' : 'No fab items';
    },
    'PR to Purchaser':      () => { const hasPR = prpo.some(r => r.prNo); return hasPR ? 'PR found in PRPO records' : 'No PRs raised (Procurement page)'; },
    'PO Issued':            () => { const hasPO = prpo.some(r => r.poNo); return hasPO ? 'PO found in PRPO records' : 'No POs issued (Procurement page)'; },
    'Production / Fabrication': () => {
      const ip = fab.filter(r => r.status === 'In Progress' || r.status === 'QC Check').length;
      const ready = fab.filter(r => r.status === 'Ready for Delivery' || r.status === 'Delivered').length;
      if (ready > 0) return ready + '/' + fab.length + ' items past production';
      if (ip > 0) return ip + '/' + fab.length + ' items in production (Factory page)';
      return 'No fab items in production yet (Factory page)';
    },
    'Fabrication':          () => {
      const ip = fab.filter(r => r.status === 'In Progress' || r.status === 'QC Check').length;
      const ready = fab.filter(r => r.status === 'Ready for Delivery' || r.status === 'Delivered').length;
      if (ready > 0) return ready + '/' + fab.length + ' items past production';
      if (ip > 0) return ip + '/' + fab.length + ' items in production';
      return 'No fab items in production yet';
    },
    'Shipping':             () => {
      const ready = fab.filter(r => r.status === 'Ready for Delivery').length;
      const delivered = fab.filter(r => r.status === 'Delivered').length;
      if (delivered > 0) return delivered + '/' + fab.length + ' delivered';
      if (ready > 0) return ready + '/' + fab.length + ' ready for delivery (Factory page)';
      return 'No items ready for delivery yet';
    },
    'Delivered':            () => {
      const delivered = fab.filter(r => r.status === 'Delivered').length;
      return delivered > 0 ? delivered + '/' + fab.length + ' items delivered' : 'No items delivered yet (Factory page)';
    },
    'Delivery':             () => {
      const delivered = fab.filter(r => r.status === 'Delivered').length;
      return delivered > 0 ? delivered + '/' + fab.length + ' items delivered' : 'No items delivered yet';
    },
    'Site Ready':           () => { const started = inst.filter(r => r.status !== 'Not Started').length; return started > 0 ? 'Install items started — site is active' : 'No install items started (Installation page)'; },
    'Installation':         () => {
      const done = inst.filter(r => r.status === 'Installed' || r.status === 'Verified').length;
      const ip = inst.filter(r => r.status === 'In Progress').length;
      if (done === inst.length && inst.length > 0) return 'All ' + inst.length + ' items installed';
      if (ip > 0 || done > 0) return (ip + done) + '/' + inst.length + ' items in progress/done (Installation page)';
      return 'No install items started (Installation page)';
    },
    'Handover':             () => {
      const allVerified = inst.length > 0 && inst.every(r => r.status === 'Verified');
      const allPaid = ms.length > 0 && ms.every(m => m.status === 'Paid' || m.paid === true);
      if (allVerified && allPaid) return 'All installed + all paid';
      const parts = [];
      if (!allVerified) { const v = inst.filter(r => r.status === 'Verified').length; parts.push(v + '/' + inst.length + ' verified (Installation page)'); }
      if (!allPaid) { const p2 = ms.filter(m => m.status === 'Paid' || m.paid === true).length; parts.push(p2 + '/' + ms.length + ' milestones paid (Payment tab)'); }
      return parts.join(' · ') || 'No install/payment data';
    },
    'Handover / Inspection': () => reasons['Handover'](),
    'Final Claim & Closure': () => { const p2 = ms.filter(m => m.status === 'Paid' || m.paid === true).length; return p2 + '/' + ms.length + ' milestones paid (Payment tab)'; },
  };

  const completed = stages.filter(s => s.status === 'Completed').length;

  let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <span style="font-size:11px;color:var(--text-muted);">${completed} / ${stages.length} completed</span>
    <div class="progress-bar" style="height:6px;flex:1;margin-left:12px;max-width:200px;">
      <div class="progress-fill green" style="width:${Math.round(completed/stages.length*100)}%"></div>
    </div>
  </div>`;

  stages.forEach(s => {
    const icon = s.status === 'Completed' ? '●' : s.status === 'In Progress' ? '◐' : '○';
    const color = s.status === 'Completed' ? 'var(--green)' : s.status === 'In Progress' ? 'var(--accent)' : 'var(--text-muted)';
    const reasonFn = reasons[s.name];
    const reason = reasonFn ? reasonFn() : '';

    html += `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
      <span style="color:${color};font-size:13px;line-height:1;margin-top:1px;">${icon}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:${s.status === 'Not Started' ? '400' : '600'};color:${s.status === 'Not Started' ? 'var(--text-muted)' : 'var(--text)'};">${escHtml(s.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:1px;">${escHtml(reason)}</div>
      </div>
      ${s.done ? '<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">' + escHtml(s.done) + '</span>' : ''}
    </div>`;
  });

  el.innerHTML = html;
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


// ── TAB: Documents — Nested Folder View ─────────────────────────────────────
// Groups support path-based nesting: "Safety Documents/Site A/Block 1"
function renderDocuments() {
  const list = document.getElementById('documents-list');
  if (!list) return;
  if (!Array.isArray(project.documents)) project.documents = [];
  list.innerHTML = '';

  // Build tree from path-based groups
  const tree = {};
  project.documents.forEach((doc, idx) => {
    const g = doc.group || 'Other';
    if (!tree[g]) tree[g] = [];
    tree[g].push({ doc, idx });
  });

  // Collect all unique folder paths (including parents of nested paths)
  const allPaths = new Set(Object.keys(tree));
  // Also include parent paths that have no direct docs but have sub-folders
  for (const p of [...allPaths]) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      allPaths.add(parts.slice(0, i).join('/'));
    }
  }

  // Sort: top-level order first, then alphabetical
  const topOrder = ['Safety Documents', 'Submissions', 'Other'];
  const sortedPaths = [...allPaths].sort((a, b) => {
    const aTop = a.split('/')[0], bTop = b.split('/')[0];
    const aIdx = topOrder.indexOf(aTop), bIdx = topOrder.indexOf(bTop);
    const aRank = aIdx >= 0 ? aIdx : topOrder.length;
    const bRank = bIdx >= 0 ? bIdx : topOrder.length;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b);
  });

  // Only render top-level paths; children rendered inside parent
  const topLevel = sortedPaths.filter(p => !p.includes('/'));

  if (topLevel.length === 0) {
    // Empty state
    list.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;">' +
      '<div style="font-size:24px;margin-bottom:8px;">No folders yet</div>' +
      '<div>Click <strong>+ New Folder</strong> to create your first folder, then add documents inside it.</div></div>';
  }

  topLevel.forEach(rootPath => {
    list.appendChild(_buildFolderNode(rootPath, tree, sortedPaths, 0));
  });

  // "+ Add Document" button
  const addBtn = document.getElementById('doc-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      project.documents.push({ name: 'New Document', group: 'Other', allowMultiple: false, status: 'Not Submitted', submitted: '', approved: '', notes: '', files: [] });
      renderDocuments();
      debouncedSave();
    };
  }

  // "+ New Group" button (top-level)
  const newGroupBtn = document.getElementById('doc-new-group-btn');
  if (newGroupBtn) {
    newGroupBtn.onclick = () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      project.documents.push({
        name: 'New Document', group: name.trim(), allowMultiple: false,
        status: 'Not Submitted', submitted: '', approved: '', notes: '', files: []
      });
      debouncedSave();
      renderDocuments();
    };
  }
}

// Recursively build a folder node with its docs + child sub-folders
function _buildFolderNode(folderPath, tree, allPaths, depth) {
  const docs = tree[folderPath] || [];
  const folderName = folderPath.includes('/') ? folderPath.split('/').pop() : folderPath;

  const childFolders = allPaths.filter(p => {
    if (!p.startsWith(folderPath + '/')) return false;
    return !p.slice(folderPath.length + 1).includes('/');
  });

  const allDocsInTree = _countDocsInTree(folderPath, tree, allPaths);
  const submittedInTree = allDocsInTree.filter(({ doc }) => doc.status && doc.status !== 'Not Submitted').length;
  const allDone = allDocsInTree.length > 0 && submittedInTree === allDocsInTree.length;
  const isEmpty = allDocsInTree.length === 0;
  const canDelete = depth > 0 && isEmpty && childFolders.length === 0;

  const wrapper = document.createElement('div');
  wrapper.className = depth > 0 ? 'doc-folder-node' : '';
  wrapper.style.marginLeft = depth > 0 ? '12px' : '0';
  wrapper.style.marginTop = depth > 0 ? '4px' : '0';
  wrapper.style.marginBottom = depth === 0 ? '10px' : '0';

  // Header
  const header = document.createElement('div');
  header.className = 'doc-group-header';
  if (depth > 0) {
    header.style.background = 'transparent';
    header.style.border = '1px solid var(--border)';
    header.style.borderRadius = 'var(--radius-sm)';
    header.style.fontSize = '11px';
    header.style.padding = '7px 10px';
  }
  header.innerHTML =
    '<span class="doc-folder-toggle" style="font-size:14px;color:var(--text-muted);transition:transform 0.15s;display:inline-block;">&#9662;</span>' +
    '<span style="flex:1;">' + escHtml(folderName) + '</span>' +
    (isEmpty ? '' : '<span class="doc-group-counter' + (allDone ? ' all-done' : '') + '">' + submittedInTree + '/' + allDocsInTree.length + '</span>') +
    '<button class="btn btn-ghost btn-xs doc-add-subfolder" style="font-size:10px;padding:1px 6px;" title="Add sub-folder">+ Sub-folder</button>' +
    (canDelete ? '<button class="btn btn-ghost btn-xs doc-del-folder" style="color:var(--red);font-size:10px;padding:1px 6px;">Remove</button>' : '');
  wrapper.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'doc-group';
  if (depth > 0) {
    body.style.borderRadius = '0 0 var(--radius-sm) var(--radius-sm)';
    body.style.marginBottom = '4px';
  }

  if (docs.length > 0) {
    docs.forEach(({ doc, idx }) => body.appendChild(buildDocRow(doc, idx)));
  }

  // "+ Add Document" button inside
  const addDiv = document.createElement('div');
  addDiv.style.padding = '4px 12px 6px';
  addDiv.innerHTML = '<button class="btn btn-ghost btn-sm" style="font-size:11px;">+ Add Document</button>';
  body.appendChild(addDiv);
  wrapper.appendChild(body);

  // Child sub-folders rendered INSIDE the body so they visually nest
  const childContainer = document.createElement('div');
  childContainer.style.padding = docs.length > 0 || childFolders.length > 0 ? '0 0 4px 0' : '0';
  childFolders.forEach(childPath => {
    childContainer.appendChild(_buildFolderNode(childPath, tree, allPaths, depth + 1));
  });
  if (childFolders.length > 0) body.appendChild(childContainer);

  // --- Events ---
  // Toggle
  let collapsed = false;
  header.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    const toggle = header.querySelector('.doc-folder-toggle');
    if (toggle) toggle.style.transform = collapsed ? 'rotate(-90deg)' : '';
    if (depth === 0) header.style.borderRadius = collapsed ? 'var(--radius)' : 'var(--radius) var(--radius) 0 0';
  });

  // "+ Sub-folder"
  header.querySelector('.doc-add-subfolder').addEventListener('click', (e) => {
    e.stopPropagation();
    const name = prompt('Sub-folder name:');
    if (!name || !name.trim()) return;
    const newPath = folderPath + '/' + name.trim();
    // Create empty folder by adding a placeholder doc
    project.documents.push({
      name: 'New Document', group: newPath, allowMultiple: false,
      status: 'Not Submitted', submitted: '', approved: '', notes: '', files: []
    });
    debouncedSave();
    renderDocuments();
  });

  // Delete folder
  const delBtn = header.querySelector('.doc-del-folder');
  if (delBtn) {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Remove all docs in this folder path
      project.documents = project.documents.filter(d => d.group !== folderPath);
      debouncedSave();
      renderDocuments();
    });
  }

  // "+ Add Document"
  addDiv.querySelector('button').addEventListener('click', () => {
    project.documents.push({
      name: 'New Document', group: folderPath, allowMultiple: false,
      status: 'Not Submitted', submitted: '', approved: '', notes: '', files: []
    });
    renderDocuments();
    debouncedSave();
  });

  return wrapper;
}

// Count all docs in a folder path + all descendant sub-folders
function _countDocsInTree(folderPath, tree, allPaths) {
  let docs = [...(tree[folderPath] || [])];
  for (const p of allPaths) {
    if (p.startsWith(folderPath + '/') && tree[p]) {
      docs = docs.concat(tree[p]);
    }
  }
  return docs;
}

function buildDocRow(doc, idx) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.dataset.idx = idx;

  const statusClass = {
    'Approved': 's-approved',
    'Submitted for Approval': 's-submitted',
    'Not Submitted': 's-not-submitted',
    'Rejected': 's-rejected'
  }[doc.status] || 's-not-submitted';
  const statusLabel = doc.status === 'Submitted for Approval' ? 'Submitted' : (doc.status || 'Not Submitted');
  const files = Array.isArray(doc.files) ? doc.files.filter(f => f.fileName) : [];
  const fileIndicator = files.length > 0
    ? '<span class="doc-file-indicator">' + files.length + ' file' + (files.length > 1 ? 's' : '') + '</span>'
    : '';

  row.innerHTML =
    '<div class="doc-row-summary">' +
      '<span class="doc-status-dot ' + statusClass + '"></span>' +
      '<span class="doc-row-name">' + escHtml(doc.name || 'Unnamed') + '</span>' +
      '<div class="doc-row-meta">' +
        fileIndicator +
        '<span class="doc-row-status ' + statusClass + '">' + escHtml(statusLabel) + '</span>' +
        '<span class="doc-row-toggle">&#9662;</span>' +
      '</div>' +
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
          '<input type="text" class="doc-notes tbl-input" value="' + escHtml(doc.notes || '') + '" placeholder="Notes...">' +
        '</div>' +
      '</div>' +
      '<div class="doc-files-section">' +
        '<div class="doc-files-list" id="doc-files-' + idx + '">' +
          files.map((f, fi) =>
            '<div class="doc-file-item">' +
              '<a href="/uploads/' + escHtml(f.fileName) + '" target="_blank" class="doc-file-link">' + escHtml(f.fileName.replace(/^\d+-/, '')) + '</a>' +
              '<button class="btn btn-ghost btn-sm doc-remove-file" data-fi="' + fi + '" style="color:var(--red); font-size:11px; padding:2px 6px;">Remove</button>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<label class="btn-upload-pdf" style="margin-top:6px; cursor:pointer;">' +
          (doc.allowMultiple && files.length > 0 ? 'Upload Another PDF' : 'Upload PDF') +
          '<input type="file" accept=".pdf" class="doc-file-input" style="display:none;">' +
        '</label>' +
      '</div>' +
      '<div class="doc-detail-footer">' +
        '<input type="text" class="doc-name-edit tbl-input" value="' + escHtml(doc.name || '') + '" placeholder="Document name" style="flex:1; margin-right:8px;">' +
        '<button class="btn btn-ghost btn-sm doc-del-btn" style="color:var(--red); flex-shrink:0;">Remove Document</button>' +
      '</div>' +
    '</div>';

  // Make entire summary row clickable (not just the toggle)
  const summary = row.querySelector('.doc-row-summary');
  const detail  = row.querySelector('.doc-row-detail');
  summary.addEventListener('click', (e) => {
    // Don't toggle if clicking inside detail or on a button
    if (e.target.closest('.doc-row-detail')) return;
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'block';
    row.classList.toggle('doc-row-open', !isOpen);
  });

  row.querySelector('.doc-status-sel').addEventListener('change', function() {
    project.documents[idx].status = this.value;
    // Re-render to update dot, status pill, and group counter
    renderDocuments();
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

  row.querySelector('.doc-del-btn').addEventListener('click', async () => {
    const result = await confirmDelete('Remove this document?', doc.name);
    if (!result) return;
    // Delete all attached files from disk first
    const files = Array.isArray(project.documents[idx].files) ? project.documents[idx].files : [];
    for (const f of files) {
      if (f.fileName) {
        try { await fetch('/api/projects/' + projectId + '/upload/' + encodeURIComponent(f.fileName), { method: 'DELETE' }); } catch {}
      }
    }
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
      const delResult = await confirmDelete('Remove this file?', btn.dataset.filename || 'Uploaded file');
      if (!delResult) return;
      const fi = parseInt(btn.dataset.fi);
      // Server deletes file from disk + splices from files array
      await fetch('/api/projects/' + projectId + '/documents/' + idx + '/file?fi=' + fi, { method: 'DELETE' });
      // Refresh project data from server to stay in sync
      const res = await fetch('/api/projects/' + projectId);
      if (res.ok) { const fresh = await res.json(); project.documents = fresh.documents || []; }
      renderDocuments();
    });
  });

  return row;
}


// ── Drawings Tab — Nested Folder View ────────────────────────────────────────
function renderDrawings() {
  const container = document.getElementById('drawings-grid');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(project.drawings)) project.drawings = [];
  if (!Array.isArray(project.drawingFolders)) project.drawingFolders = ['General'];

  project.drawings.forEach(d => { if (!d.folder) d.folder = 'General'; });

  // Build tree from path-based folders
  const tree = {};
  project.drawings.forEach((d, i) => {
    const f = d.folder || 'General';
    if (!tree[f]) tree[f] = [];
    tree[f].push({ d, i });
  });

  // Collect all folder paths (including parents + registered folders)
  const allPaths = new Set([...project.drawingFolders, ...Object.keys(tree)]);
  for (const p of [...allPaths]) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      allPaths.add(parts.slice(0, i).join('/'));
    }
  }
  // Ensure General always exists
  allPaths.add('General');

  const sortedPaths = [...allPaths].sort((a, b) => {
    if (a === 'General') return -1;
    if (b === 'General') return 1;
    return a.localeCompare(b);
  });

  const topLevel = sortedPaths.filter(p => !p.includes('/'));

  if (topLevel.length === 0 || (topLevel.length === 1 && topLevel[0] === 'General' && !tree['General']?.length)) {
    container.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;">' +
      '<div style="font-size:24px;margin-bottom:8px;">No drawings yet</div>' +
      '<div>Click <strong>+ Add Drawing</strong> to upload your first drawing, or <strong>+ New Folder</strong> to organize by category.</div></div>';
  }

  topLevel.forEach(rootPath => {
    container.appendChild(_buildDrawingFolderNode(rootPath, tree, sortedPaths, 0));
  });

  // "+ Add Drawing" → General folder
  const addBtn = document.getElementById('drawing-add-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      project.drawings.push({ name: '', drawingNumber: '', revision: '', status: 'For Approval', file: '', folder: 'General' });
      renderDrawings();
      debouncedSave();
    };
  }

  // "+ New Folder" (top-level)
  const newFolderBtn = document.getElementById('drawing-new-folder-btn');
  if (newFolderBtn) {
    newFolderBtn.onclick = () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (project.drawingFolders.includes(trimmed)) { showToast('Folder already exists', 'error'); return; }
      project.drawingFolders.push(trimmed);
      debouncedSave();
      renderDrawings();
    };
  }
}

function _buildDrawingFolderNode(folderPath, tree, allPaths, depth) {
  const drawings = tree[folderPath] || [];
  const folderName = folderPath.includes('/') ? folderPath.split('/').pop() : folderPath;

  const childFolders = allPaths.filter(p => {
    if (!p.startsWith(folderPath + '/')) return false;
    const remainder = p.slice(folderPath.length + 1);
    return !remainder.includes('/');
  });

  // Count all drawings in this tree
  let totalInTree = drawings.length;
  let approvedInTree = drawings.filter(({ d }) => d.status === 'Approved').length;
  for (const p of allPaths) {
    if (p.startsWith(folderPath + '/') && tree[p]) {
      totalInTree += tree[p].length;
      approvedInTree += tree[p].filter(({ d }) => d.status === 'Approved').length;
    }
  }

  const canDelete = folderPath !== 'General' && drawings.length === 0 && childFolders.length === 0;

  const isEmpty = totalInTree === 0;

  const wrapper = document.createElement('div');
  wrapper.className = 'drawing-folder';
  wrapper.style.marginLeft = depth > 0 ? '12px' : '0';
  wrapper.style.marginTop = depth > 0 ? '4px' : '0';
  wrapper.style.marginBottom = depth === 0 ? '10px' : '0';

  wrapper.innerHTML =
    '<div class="drawing-folder-header" style="' + (depth > 0 ? 'background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:11px;padding:7px 10px;' : '') + '">' +
      '<span class="drawing-folder-toggle">&#9662;</span>' +
      '<span class="drawing-folder-name">' + escHtml(folderName) + '</span>' +
      (isEmpty ? '' : '<span class="drawing-folder-count">' + approvedInTree + '/' + totalInTree + '</span>') +
      '<button class="btn btn-ghost btn-xs drw-add-subfolder" style="font-size:10px;padding:1px 6px;" title="Add sub-folder">+ Sub-folder</button>' +
      (canDelete ? '<button class="btn btn-ghost btn-xs del-folder-btn" style="color:var(--red);font-size:10px;padding:1px 6px;">Remove</button>' : '') +
    '</div>' +
    '<div class="drawing-folder-body"></div>';

  const body = wrapper.querySelector('.drawing-folder-body');

  drawings.forEach(({ d, i }) => body.appendChild(buildDrawingRow(d, i)));

  const addDiv = document.createElement('div');
  addDiv.style.padding = '4px 12px 6px';
  addDiv.innerHTML = '<button class="btn btn-ghost btn-sm" style="font-size:11px;">+ Add Drawing</button>';
  addDiv.querySelector('button').addEventListener('click', () => {
    project.drawings.push({ name: '', drawingNumber: '', revision: '', status: 'For Approval', file: '', folder: folderPath });
    renderDrawings();
    debouncedSave();
  });
  body.appendChild(addDiv);

  // Child sub-folders inside body
  const childContainer = document.createElement('div');
  childFolders.forEach(childPath => {
    childContainer.appendChild(_buildDrawingFolderNode(childPath, tree, allPaths, depth + 1));
  });
  if (childFolders.length > 0) body.appendChild(childContainer);

  // Toggle collapse
  wrapper.querySelector('.drawing-folder-header').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    wrapper.classList.toggle('collapsed');
  });

  // "+ Sub-folder" button
  wrapper.querySelector('.drw-add-subfolder').addEventListener('click', (e) => {
    e.stopPropagation();
    const name = prompt('Sub-folder name:');
    if (!name || !name.trim()) return;
    const newPath = folderPath + '/' + name.trim();
    if (!project.drawingFolders.includes(newPath)) project.drawingFolders.push(newPath);
    debouncedSave();
    renderDrawings();
  });

  // Delete folder button
  const delBtn = wrapper.querySelector('.del-folder-btn');
  if (delBtn) {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      project.drawingFolders = project.drawingFolders.filter(f => f !== folderPath);
      debouncedSave();
      renderDrawings();
    });
  }

  return wrapper;
}

function buildDrawingRow(drawing, idx) {
  const row = document.createElement('div');
  row.className = 'drw-row';

  const statusClass = { 'Approved': 's-approved', 'For Approval': 's-for-approval', 'Superseded': 's-superseded' }[drawing.status] || 's-for-approval';
  const displayName = drawing.name || '';
  const hasFile = !!drawing.file;
  const revLabel = drawing.revision ? 'Rev ' + drawing.revision : '';

  row.innerHTML =
    '<div class="drw-row-summary">' +
      '<span class="doc-status-dot ' + (drawing.status === 'Approved' ? 's-approved' : drawing.status === 'Superseded' ? 's-not-submitted' : 's-submitted') + '"></span>' +
      '<span class="drw-row-name' + (displayName ? '' : ' empty') + '">' + escHtml(displayName || 'Untitled drawing') + '</span>' +
      '<div class="drw-row-meta">' +
        (hasFile ? '<span class="doc-file-indicator">PDF</span>' : '') +
        (revLabel ? '<span class="drw-row-rev">' + escHtml(revLabel) + '</span>' : '') +
        '<span class="drw-row-status ' + statusClass + '">' + escHtml(drawing.status || 'For Approval') + '</span>' +
        '<span class="drw-row-toggle">&#9662;</span>' +
      '</div>' +
    '</div>' +
    '<div class="drw-row-detail" style="display:none;">' +
      '<div class="drw-detail-grid">' +
        '<div class="field" style="margin:0;">' +
          '<label>Drawing Name</label>' +
          '<input class="tbl-input drw-name" value="' + escHtml(drawing.name || '') + '" placeholder="e.g. Shop Drawing - Bollard">' +
        '</div>' +
        '<div class="field" style="margin:0;">' +
          '<label>Rev</label>' +
          '<input class="tbl-input drw-rev" value="' + escHtml(drawing.revision || '') + '" placeholder="A">' +
        '</div>' +
        '<div class="field" style="margin:0;">' +
          '<label>Status</label>' +
          '<select class="tbl-select drw-status-sel">' +
            '<option' + (drawing.status === 'For Approval' ? ' selected' : '') + '>For Approval</option>' +
            '<option' + (drawing.status === 'Approved' ? ' selected' : '') + '>Approved</option>' +
            '<option' + (drawing.status === 'Superseded' ? ' selected' : '') + '>Superseded</option>' +
          '</select>' +
        '</div>' +
        '<div class="field" style="margin:0; grid-column:1/-1;">' +
          '<label>Drawing No.</label>' +
          '<input class="tbl-input drw-num" value="' + escHtml(drawing.drawingNumber || '') + '" placeholder="e.g. SD-001">' +
        '</div>' +
      '</div>' +
      '<div class="doc-files-section">' +
        (hasFile
          ? '<div class="doc-file-item">' +
              '<a href="/uploads/' + escHtml(drawing.file) + '" target="_blank" class="doc-file-link">' + escHtml(drawing.file.replace(/^\d+-/, '')) + '</a>' +
              '<button class="btn btn-ghost btn-sm drw-remove-file" style="color:var(--red);font-size:11px;padding:2px 6px;">Remove</button>' +
            '</div>'
          : '') +
        '<label class="btn-upload-pdf" style="margin-top:6px;cursor:pointer;' + (hasFile ? 'display:none;' : '') + '">' +
          'Upload PDF' +
          '<input type="file" accept=".pdf" class="drw-file-input" style="display:none;">' +
        '</label>' +
      '</div>' +
      '<div class="drw-detail-footer">' +
        '<span style="font-size:11px;color:var(--text-muted);">Folder: ' + escHtml(drawing.folder || 'General') + '</span>' +
        '<button class="btn btn-ghost btn-sm drw-del-btn" style="color:var(--red);flex-shrink:0;">Remove Drawing</button>' +
      '</div>' +
    '</div>';

  // Toggle
  row.querySelector('.drw-row-summary').addEventListener('click', () => {
    const detail = row.querySelector('.drw-row-detail');
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'block';
    row.classList.toggle('drw-row-open', !isOpen);
  });

  // Field edits
  row.querySelector('.drw-name').addEventListener('input', function() {
    project.drawings[idx].name = this.value;
    row.querySelector('.drw-row-name').textContent = this.value || 'Untitled drawing';
    row.querySelector('.drw-row-name').classList.toggle('empty', !this.value);
    debouncedSave();
  });
  row.querySelector('.drw-rev').addEventListener('input', function() { project.drawings[idx].revision = this.value; debouncedSave(); });
  row.querySelector('.drw-num').addEventListener('input', function() { project.drawings[idx].drawingNumber = this.value; debouncedSave(); });
  row.querySelector('.drw-status-sel').addEventListener('change', function() {
    project.drawings[idx].status = this.value;
    renderDrawings();
    saveProject();
  });

  // Delete drawing
  row.querySelector('.drw-del-btn').addEventListener('click', async () => {
    const result = await confirmDelete('Remove this drawing?', drawing.name || drawing.drawingNumber);
    if (!result) return;
    if (drawing.file) {
      try { await fetch('/api/projects/' + projectId + '/upload/' + encodeURIComponent(drawing.file), { method: 'DELETE' }); } catch {}
    }
    project.drawings.splice(idx, 1);
    renderDrawings();
    saveProject();
  });

  // Upload
  row.querySelector('.drw-file-input').addEventListener('change', async function() {
    if (!this.files || !this.files[0]) return;
    const formData = new FormData();
    formData.append('file', this.files[0]);
    try {
      const res = await fetch('/api/projects/' + projectId + '/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error();
      const data = await res.json();
      project.drawings[idx].file = data.filename;
      await saveProject();
      renderDrawings();
      showToast('PDF uploaded', 'success');
    } catch { showToast('Upload failed', 'error'); }
  });

  // Remove file
  const removeBtn = row.querySelector('.drw-remove-file');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      const delResult = await confirmDelete('Remove this file?', 'Drawing file');
      if (!delResult) return;
      try { await fetch('/api/projects/' + projectId + '/drawings/' + idx + '/file', { method: 'DELETE' }); } catch {}
      project.drawings[idx].file = '';
      await saveProject();
      renderDrawings();
      showToast('File removed', 'success');
    });
  }

  return row;
}

// ── Product Scope Table ───────────────────────────────────────────────────────
// ── Parts sub-row builder ────────────────────────────────────────────────────
function _buildPartsRow(scopeIdx, row) {
  const tr = document.createElement('tr');
  tr.className = 'parts-row';
  const td = document.createElement('td');
  td.colSpan = 7;
  td.style.cssText = 'padding:6px 12px 10px 32px; background:rgba(255,255,255,0.02); border-left:3px solid var(--accent);';

  if (!Array.isArray(row.parts)) row.parts = [];

  const renderInner = () => {
    const parts = project.productScope[scopeIdx].parts;
    let html = '<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">Parts / Components</div>';
    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<thead><tr><th style="text-align:left;font-size:11px;padding:2px 6px;color:var(--text-muted);">Part Name</th><th style="width:60px;font-size:11px;padding:2px 6px;color:var(--text-muted);">Qty</th><th style="width:120px;font-size:11px;padding:2px 6px;color:var(--text-muted);">Source</th><th style="width:30px;"></th></tr></thead>';
    html += '<tbody>';
    parts.forEach((part, pi) => {
      html += `<tr>
        <td style="padding:2px 4px;"><input class="tbl-input part-name" data-pi="${pi}" value="${escHtml(part.name || '')}" placeholder="e.g. Hydraulic pump" style="width:100%;font-size:12px;"></td>
        <td style="padding:2px 4px;"><input class="tbl-input part-qty" data-pi="${pi}" type="number" value="${part.qty || 1}" min="1" style="width:50px;font-size:12px;"></td>
        <td style="padding:2px 4px;">
          <select class="tbl-input part-source" data-pi="${pi}" style="width:110px;font-size:12px;">
            <option value="Fabricate" ${part.source === 'Fabricate' ? 'selected' : ''}>Fabricate</option>
            <option value="Order"     ${part.source === 'Order'     ? 'selected' : ''}>Order</option>
          </select>
        </td>
        <td style="padding:2px 4px;"><button class="btn btn-ghost btn-sm part-del" data-pi="${pi}" title="Remove" style="font-size:11px;padding:1px 6px;">✕</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
    html += '<button class="btn btn-ghost btn-sm part-add" style="font-size:11px;margin-top:4px;">+ Add Part</button>';
    td.innerHTML = html;

    // Wire events
    td.querySelectorAll('.part-name').forEach(el => {
      el.addEventListener('input', () => {
        project.productScope[scopeIdx].parts[+el.dataset.pi].name = el.value;
        debouncedSave();
      });
    });
    td.querySelectorAll('.part-qty').forEach(el => {
      el.addEventListener('input', () => {
        project.productScope[scopeIdx].parts[+el.dataset.pi].qty = Number(el.value) || 1;
        debouncedSave();
      });
    });
    td.querySelectorAll('.part-source').forEach(el => {
      el.addEventListener('change', () => {
        project.productScope[scopeIdx].parts[+el.dataset.pi].source = el.value;
        debouncedSave();
      });
    });
    td.querySelectorAll('.part-del').forEach(el => {
      el.addEventListener('click', () => {
        project.productScope[scopeIdx].parts.splice(+el.dataset.pi, 1);
        debouncedSave();
        renderInner();
      });
    });
    td.querySelector('.part-add').addEventListener('click', () => {
      project.productScope[scopeIdx].parts.push({ name: '', qty: 1, source: 'Fabricate' });
      renderInner();
    });
  };

  renderInner();
  tr.appendChild(td);
  return tr;
}

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
    // Default new rows
    if (row.type == null)       row.type       = 'Local Fabrication';
    if (row.itemType == null)   row.itemType   = 'Fixed';
    if (row.partsRequired == null) row.partsRequired = false;
    if (!Array.isArray(row.parts)) row.parts = [];

    tr.innerHTML = `
      <td><input class="tbl-input ps-item" value="${escHtml(row.item || '')}" placeholder="e.g. SP30 Fixed Bollard" style="min-width:160px; width:100%;"></td>
      <td><input class="tbl-input ps-qty" type="number" value="${row.qty || 1}" min="1" style="width:60px;"></td>
      <td style="white-space:nowrap;">
        <input class="tbl-input unit-input" type="text" list="unit-suggestions" value="${escHtml(row.unit || 'units')}" placeholder="units" style="width:100px;">
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
    const iUnit = tr.querySelector('input.unit-input');
    const iType = tr.querySelector('select.ps-type');
    const iItemType = tr.querySelector('select.ps-itemtype');
    const iParts = tr.querySelector('input.ps-parts');

    const sync = () => {
      project.productScope[idx].item      = iItem.value;
      project.productScope[idx].qty       = Number(iQty.value) || 1;
      project.productScope[idx].unit      = iUnit.value;
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
    [iItem, iQty, iUnit].forEach(el => el.addEventListener('input', sync));
    iQty.addEventListener('change', sync);
    iType.addEventListener('change', sync);
    iItemType.addEventListener('change', sync);

    // Parts toggle — show/hide parts sub-table
    const updatePartsVisibility = () => {
      const show = iParts.checked;
      project.productScope[idx].partsRequired = show;
      // Find or create parts row
      let partsRow = tr.nextElementSibling;
      if (partsRow && partsRow.classList.contains('parts-row')) {
        partsRow.style.display = show ? '' : 'none';
      } else if (show) {
        partsRow = _buildPartsRow(idx, row);
        tr.parentNode.insertBefore(partsRow, tr.nextSibling);
      }
      sync();
    };
    iParts.addEventListener('change', updatePartsVisibility);

    tr.querySelector('.del-row-btn').addEventListener('click', () => {
      // Remove parts row if it exists
      const nextRow = tr.nextElementSibling;
      if (nextRow && nextRow.classList.contains('parts-row')) nextRow.remove();
      project.productScope.splice(idx, 1);
      renderProductScope();
      debouncedSave();
    });
    tbody.appendChild(tr);

    // If parts already checked, render parts row
    if (row.partsRequired) {
      const partsRow = _buildPartsRow(idx, row);
      tbody.appendChild(partsRow);
    }
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

      // Only sync Local Fabrication items to FAB — skip Overseas Order / Purchase Item
      const allItems = project.productScope.filter(r => r.item && r.item.trim());
      const fabItems = allItems.filter(r => (r.type || 'Local Fabrication') === 'Local Fabrication');

      // Check for data loss: fab rows with progress that would be removed
      const scopeKeys = new Set(fabItems.map(r => r.item.trim().toLowerCase()));
      const lostRows = project.fabrication.filter(f => {
        const key = (f.item || '').trim().toLowerCase();
        const hasProgress = (parseFloat(f.qtyDone) || 0) > 0 || (Array.isArray(f.logs) && f.logs.length > 0);
        return hasProgress && !scopeKeys.has(key);
      });
      if (lostRows.length > 0) {
        const names = lostRows.map(r => r.item).join(', ');
        const syncResult = await confirmDelete(`${lostRows.length} fab item(s) with progress will be removed`, names);
        if (!syncResult) return;
      }

      // Rebuild FAB — handles both Fixed items and Mechanical items with parts
      const newFab = [];

      // Helper: find existing fab row by item name (first unclaimed match)
      const claimedFabIdx = new Set();
      const findExisting = (name) => {
        const key = name.trim().toLowerCase();
        const idx = project.fabrication.findIndex((r, fi) =>
          !claimedFabIdx.has(fi) && (r.item || '').trim().toLowerCase() === key
        );
        if (idx !== -1) { claimedFabIdx.add(idx); return project.fabrication[idx]; }
        return null;
      };

      for (const scopeRow of fabItems) {
        const hasParts = scopeRow.partsRequired && Array.isArray(scopeRow.parts) && scopeRow.parts.length > 0;

        if (!hasParts) {
          // Fixed item or Mechanical without parts — single fab row (same as before)
          const existing = findExisting(scopeRow.item);
          if (existing) {
            newFab.push(Object.assign({}, existing, { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units' }));
          } else {
            newFab.push({ item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units', qtyDone: 0, qtySent: 0, status: 'Not Started', started: '', done: '' });
          }
        } else {
          // Mechanical item with parts — create parent + child rows
          const parentName = scopeRow.item.trim();
          const fabParts = scopeRow.parts.filter(p => p.source === 'Fabricate' && p.name && p.name.trim());
          const orderParts = scopeRow.parts.filter(p => p.source === 'Order' && p.name && p.name.trim());
          const parentIdx = newFab.length;

          // Parent container row
          const existingParent = findExisting(parentName);
          const parentRow = existingParent
            ? Object.assign({}, existingParent, {
                item: parentName, totalQty: scopeRow.qty, unit: scopeRow.unit || 'units',
                isMechanicalParent: true,
                orderParts: orderParts.map(p => {
                  // Preserve existing order part status
                  const oldOrder = (existingParent.orderParts || []).find(o => o.name === p.name);
                  return { name: p.name.trim(), qty: p.qty || 1, status: oldOrder ? oldOrder.status : 'Pending' };
                }),
              })
            : {
                item: parentName, totalQty: scopeRow.qty, unit: scopeRow.unit || 'units',
                qtyDone: 0, qtySent: 0, status: 'Not Started', started: '', done: '',
                isMechanicalParent: true,
                orderParts: orderParts.map(p => ({ name: p.name.trim(), qty: p.qty || 1, status: 'Pending' })),
              };
          // Clear child-row fields from parent if they leaked in
          delete parentRow.isPartRow; delete parentRow.parentIdx; delete parentRow.partSource;
          newFab.push(parentRow);

          // Child fab rows for Fabricate parts
          for (const part of fabParts) {
            const childName = parentName + ' > ' + part.name.trim();
            const existingChild = findExisting(childName);
            if (existingChild) {
              newFab.push(Object.assign({}, existingChild, {
                item: childName, totalQty: part.qty || 1, unit: scopeRow.unit || 'units',
                isPartRow: true, parentIdx, partSource: 'Fabricate',
              }));
            } else {
              newFab.push({
                item: childName, totalQty: part.qty || 1, unit: scopeRow.unit || 'units',
                qtyDone: 0, qtySent: 0, status: 'Not Started', started: '', done: '',
                isPartRow: true, parentIdx, partSource: 'Fabricate',
              });
            }
          }
        }
      }
      project.fabrication = newFab;

      // Rebuild Install — all items get install rows (regardless of type)
      const instNameCounts = {};
      allItems.forEach(r => { const k = r.item.trim().toLowerCase(); instNameCounts[k] = (instNameCounts[k]||0) + 1; });

      const usedInstIdx = new Set();
      const newInst = allItems.map((scopeRow, i) => {
        const key = scopeRow.item.trim().toLowerCase();
        const isDuplicate = instNameCounts[key] > 1;
        const byIndex = project.installation[i];
        if (byIndex && (byIndex.item || '').trim().toLowerCase() === key && !usedInstIdx.has(i)) {
          usedInstIdx.add(i);
          return Object.assign({}, byIndex, { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units' });
        }
        if (!isDuplicate) {
          const nameIdx = project.installation.findIndex((r, ii) =>
            !usedInstIdx.has(ii) && (r.item || '').trim().toLowerCase() === key
          );
          if (nameIdx !== -1) {
            usedInstIdx.add(nameIdx);
            return Object.assign({}, project.installation[nameIdx], { item: scopeRow.item.trim(), totalQty: scopeRow.qty, unit: scopeRow.unit || 'units' });
          }
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
      const skipped = allItems.length - fabItems.length;
      const partRows = newFab.filter(r => r.isPartRow).length;
      const parentRows = newFab.filter(r => r.isMechanicalParent).length;
      let msg = `Synced ${newFab.length} fab rows, ${newInst.length} install rows`;
      if (parentRows > 0) msg += ` (${parentRows} mechanical with ${partRows} parts)`;
      if (skipped > 0) msg += ` · ${skipped} non-fab skipped`;
      showToast(msg, 'success');
    };
  }
}

// ── TAB 3: Fabrication ───────────────────────────────────────────────────────
const FAB_DONE_STATUSES = ['Ready for Delivery', 'Delivered'];
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
        <td style="padding:8px 10px;font-size:13px;text-align:right;">${totalQty != null ? totalQty : '—'}</td>
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


function updateFabPct() {
  const fab = (project.fabrication || []).filter(r => !r.isMechanicalParent);
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

  const allFab = project.fabrication.filter(f => f.totalQty > 0 && !f.isMechanicalParent);
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
    return `<div style="background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--green); border-radius:6px; padding:8px 12px; min-width:140px;">
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
        <td style="padding:8px 10px;font-size:13px;text-align:right;">${totalQty != null ? totalQty : '—'}</td>
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
    return `<div style="background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--green); border-radius:6px; padding:8px 12px; min-width:140px;">
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
      ${sr.urgency === 'Urgent' ? '<span style="background:#fee2e2; color:#991b1b; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;">Urgent</span>' : ''}
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

  div.querySelector('.del-meeting-btn').addEventListener('click', async () => {
    const result = await confirmDelete('Delete this meeting note?', meeting.date || 'Meeting ' + (idx+1));
    if (!result) return;
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
          if (ref) patch._paymentRef = ref; // stored temporarily, merged with existing notes below
        }
        try {
          // Get full claim first, merge patch — preserve existing notes
          const all = await api('GET', `/api/claims?projectId=${projectId}`);
          const existing = all.find(x => x.id === id);
          if (!existing) return;
          if (patch._paymentRef) {
            patch.notes = (existing.notes || '') + (existing.notes ? ' | ' : '') + 'Ref: ' + patch._paymentRef;
            delete patch._paymentRef;
          }
          await api('PUT', `/api/claims/${id}`, { ...existing, ...patch });
          renderClaimsTab();
        } catch (e) {
          showToast('Update failed', 'error');
        }
      });
    });

    // Wire delete buttons
    listEl.querySelectorAll('.claim-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const delResult = await confirmDelete('Delete this claim?', 'Claim ' + btn.dataset.id);
        if (!delResult) return;
        showPinModal(async (pin) => {
          const result = await api('POST', '/api/admin/pin', { action: 'verify', pin });
          if (!result.ok) return false;
          await api('DELETE', `/api/claims/${btn.dataset.id}`, { pin, deleteReason: delResult.reason });
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

  // Badge colour per action/event prefix
  function badgeColor(action) {
    if (!action) return 'var(--text-muted)';
    if (action.startsWith('project.field_changed')) return 'var(--amber)';
    if (action.startsWith('project.')) return 'var(--accent)';
    if (action.startsWith('fab.'))     return 'var(--green)';
    if (action.startsWith('install.')) return '#8b5cf6';
    if (action.startsWith('task.'))    return 'var(--blue, #3b82f6)';
    return 'var(--text-muted)';
  }

  function formatDetails(log) {
    // Server writes changes at top-level (new) or under details (legacy)
    const d = log.details || {};
    const changes = Array.isArray(log.changes) ? log.changes : (Array.isArray(d.changes) ? d.changes : []);
    const parts = [];
    if (changes.length > 0) {
      parts.push(changes.map(c =>
        `<span style="color:var(--text-muted);">${escHtml(c.field)}:</span> ` +
        `<span style="color:var(--red); text-decoration:line-through;">${escHtml(String(c.from ?? '—'))}</span> ` +
        `→ <span style="color:var(--green);">${escHtml(String(c.to ?? '—'))}</span>`
      ).join(' &nbsp;|&nbsp; '));
    }
    const item = log.item || d.item;
    const jobCode = log.jobCode || d.jobCode;
    if (item) parts.push(`<span style="color:var(--text-muted);">item:</span> ${escHtml(item)}`);
    if (jobCode && !parts.length) parts.push(`<span style="color:var(--text-muted);">job:</span> ${escHtml(jobCode)}`);
    return parts.join(' &nbsp;·&nbsp; ');
  }

  const html = logs.map(log => {
    // Handle both formats: new (event/ts) and legacy (action/timestamp)
    const action = log.event || log.action || 'unknown';
    const ts = new Date(log.ts || log.timestamp);
    const dateStr = ts.toLocaleDateString('en-SG', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = ts.toLocaleTimeString('en-SG', { hour:'2-digit', minute:'2-digit', hour12:false });
    const color = badgeColor(action);
    const detail = formatDetails(log);
    return `
      <div style="display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); align-items:flex-start;">
        <div style="min-width:110px; font-size:11px; color:var(--text-muted); padding-top:2px;">
          ${dateStr}<br>${timeStr}
        </div>
        <div style="flex:1;">
          <span style="display:inline-block; font-size:11px; font-weight:600; color:${color}; background:${color}22; border-radius:4px; padding:2px 7px; margin-bottom:4px;">${escHtml(action)}</span>
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

