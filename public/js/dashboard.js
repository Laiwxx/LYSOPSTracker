/* ── dashboard.js ── LYS OPS Tracker ── Boss View ── */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let allProjects = [];
  let activeStatus = 'all';
  let searchQuery = '';
  let showAllProjects = false;

  // ── Boot ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    loadSummary();
    loadFactoryQueue();
    loadProjects();
    loadWeeklyBrief();
    loadTodayMCFromAttendance();
    // Auto-refresh weekly movement + today's MC every 2 minutes
    setInterval(function() { loadWeeklyBrief(); loadTodayMCFromAttendance(); }, 2 * 60 * 1000);
    loadEodStatus();
    bindFactoryToggle();
    bindMondayToggle();
    bindEodToggle();
    bindFilters();
    setInterval(loadEodStatus, 5 * 60 * 1000); // auto-refresh every 5 minutes
  });

  // ── Hero Metrics ──────────────────────────────────────────────────────────
  async function loadSummary() {
    try {
      const s = await api('GET', '/api/summary');

      // Active projects = total minus completed
      var active = (s.total || 0) - (s.completed || 0);
      var heroActive = document.getElementById('hero-active');
      if (heroActive) heroActive.textContent = active;
      var heroActiveSub = document.getElementById('hero-active-sub');
      if (heroActiveSub) heroActiveSub.textContent = 'of ' + (s.total || 0) + ' projects';

      // Portfolio-average FAB / Install
      var fabPct  = s.overallFabPct  || s.avgFabPct  || 0;
      var instPct = s.overallInstallPct || s.avgInstallPct || 0;
      var heroFab = document.getElementById('hero-fab');
      if (heroFab) heroFab.textContent = fabPct + '%';
      var heroInstall = document.getElementById('hero-install');
      if (heroInstall) heroInstall.textContent = instPct + '%';

      // Total chip count
      var totalCount = document.getElementById('chip-total-count');
      if (totalCount) totalCount.textContent = s.total;

      var progEl  = document.getElementById('overall-progress');
      if (progEl) {
        var fabColor  = fabPct  >= 80 ? 'var(--green)' : fabPct  >= 40 ? 'var(--amber)' : 'var(--red)';
        var instColor = instPct >= 80 ? 'var(--green)' : instPct >= 40 ? 'var(--amber)' : 'var(--red)';
        progEl.innerHTML =
          '<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">' +
            '<span style="width:90px; font-size:11px; color:var(--text-muted);">Fabrication</span>' +
            '<div style="flex:1; height:6px; background:var(--bg); border-radius:3px; overflow:hidden;">' +
              '<div style="width:' + fabPct + '%; height:100%; background:' + fabColor + '; border-radius:3px;"></div>' +
            '</div>' +
            '<span style="width:40px; text-align:right; font-size:12px; font-weight:600; color:' + fabColor + ';">' + fabPct + '%</span>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:10px;">' +
            '<span style="width:90px; font-size:11px; color:var(--text-muted);">Installation</span>' +
            '<div style="flex:1; height:6px; background:var(--bg); border-radius:3px; overflow:hidden;">' +
              '<div style="width:' + instPct + '%; height:100%; background:' + instColor + '; border-radius:3px;"></div>' +
            '</div>' +
            '<span style="width:40px; text-align:right; font-size:12px; font-weight:600; color:' + instColor + ';">' + instPct + '%</span>' +
          '</div>';
      }

    } catch (err) {
      console.error('[LYS Dashboard] loadSummary failed:', err);
      ['hero-active','hero-fab','hero-install'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.textContent = 'Error';
      });
    }

    // OT summary for current month
    try {
      var otData = await api('GET', '/api/manpower-plan/ot-summary');
      var heroOT = document.getElementById('hero-ot');
      var heroOTSub = document.getElementById('hero-ot-sub');
      if (heroOT) {
        heroOT.textContent = otData.totalOT + 'h';
        heroOT.style.color = otData.atRisk > 0 ? 'var(--red)' : 'var(--text)';
      }
      if (heroOTSub) {
        heroOTSub.textContent = otData.workerCount + ' workers' + (otData.atRisk > 0 ? ' · ' + otData.atRisk + ' near cap' : '');
      }
    } catch (err) {
      var heroOT = document.getElementById('hero-ot');
      if (heroOT) heroOT.textContent = '—';
    }
  }

  // ── Factory Panel (merged: Queue + Fab Status) ────────────────────────────
  async function loadFactoryQueue() {
    try {
      // Fetch both APIs in parallel
      var results = await Promise.all([
        api('GET', '/api/factory-queue'),
        api('GET', '/api/fab-status')
      ]);
      var queue = results[0];
      var fabStatusArr = results[1];

      var list = document.getElementById('factory-queue-list');
      var titleEl = document.getElementById('factory-title');

      // Build fab-status lookup by projectId
      var fabMap = {};
      fabStatusArr.forEach(function (p) { fabMap[p.projectId] = p; });

      var totalItemsAll = queue.reduce(function (s, p) { return s + p.items.length; }, 0);

      // Attention-only filter: only items that need a decision today —
      // overdue delivery tickets, new (unseen by Chris) tickets, or ready-awaiting-pickup.
      function needsAttention(i) {
        if (i.isOverdue) return true;
        if (i.deliveryRequested && i.ticketStatus === 'New') return true;
        if (i.deliveryRequested && i.ticketStatus === 'Ready') return true;
        return false;
      }
      var filteredQueue = queue
        .map(function (p) {
          return Object.assign({}, p, { items: p.items.filter(needsAttention) });
        })
        .filter(function (p) { return p.items.length > 0; });

      var attentionCount = filteredQueue.reduce(function (s, p) { return s + p.items.length; }, 0);
      var overdueCount = filteredQueue.reduce(function (s, p) {
        return s + p.items.filter(function (i) { return i.isOverdue; }).length;
      }, 0);
      var newTickets = filteredQueue.reduce(function (s, p) {
        return s + p.items.filter(function (i) { return i.ticketStatus === 'New'; }).length;
      }, 0);

      titleEl.innerHTML = 'FACTORY' +
        (attentionCount ? ' — ' + attentionCount + ' needs attention' : '') +
        (overdueCount ? ' · ' + overdueCount + ' overdue' : '') +
        (newTickets ? '<span class="panel-badge">' + newTickets + ' new</span>' : '');

      if (!attentionCount) {
        var msg = totalItemsAll
          ? '✓ Factory on track — ' + totalItemsAll + ' item' + (totalItemsAll > 1 ? 's' : '') + ' moving, nothing needs you'
          : 'No active fabrication items';
        list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">' + msg + '</div>';
        return;
      }

      // Sort: projects with overdue items first, then by fab % ascending
      var sorted = filteredQueue.slice().sort(function (a, b) {
        var aOver = a.items.some(function (i) { return i.isOverdue; }) ? 0 : 1;
        var bOver = b.items.some(function (i) { return i.isOverdue; }) ? 0 : 1;
        if (aOver !== bOver) return aOver - bOver;
        var aPct = fabMap[a.projectId] ? fabMap[a.projectId].fabPct : 0;
        var bPct = fabMap[b.projectId] ? fabMap[b.projectId].fabPct : 0;
        return aPct - bPct;
      });

      var statusColors = { 'Not Started': 'var(--text-muted)', 'In Progress': 'var(--amber)', 'QC Check': 'var(--accent)', 'Ready for Delivery': 'var(--green)', 'Delivered': 'var(--green)', 'Completed': 'var(--green)' };
      var fabStatusPill = { 'Not Started': 'pill-grey', 'In Progress': 'pill-amber', 'QC Check': 'pill-blue', 'Ready for Delivery': 'pill-green', 'Delivered': 'pill-green', 'Completed': 'pill-green' };
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      list.innerHTML = sorted.map(function (p) {
        var fab = fabMap[p.projectId];
        var fabPct = fab ? fab.fabPct : 0;
        var barColor = (fab && fab.hasOverdue) ? 'var(--red)' : fabPct >= 80 ? 'var(--green)' : fabPct >= 40 ? 'var(--amber)' : 'var(--text-muted)';

        // Overall fab % bar
        var fabBarHtml =
          '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 2px;">' +
            '<span style="font-size:11px;color:var(--text-muted);width:28px;">FAB</span>' +
            '<div class="mini-bar" style="flex:1;"><div class="mini-fill" style="width:' + fabPct + '%;background:' + barColor + ';"></div></div>' +
            '<span style="font-size:11px;font-weight:700;color:' + barColor + ';width:34px;text-align:right;">' + fabPct + '%</span>' +
          '</div>';

        // Status chips dropped in attention-only mode — they summarised all items,
        // not the filtered subset, and just added noise.
        var chipsHtml = '';

        // Item rows
        var itemsHtml = p.items.map(function (item) {
          var ticketCssClass = '';
          if (item.deliveryRequested && item.ticketStatus) {
            var tsMap = { 'New': 'ticket-status-new', 'Acknowledged': 'ticket-status-acknowledged', 'In Production': 'ticket-status-inproduction', 'Ready': 'ticket-status-ready', 'Delivered': 'ticket-status-delivered' };
            ticketCssClass = tsMap[item.ticketStatus] || '';
          }

          var ticketBadge = '';
          if (item.deliveryRequested) {
            var tbMap = { 'New': ['ticket-new','New'], 'Acknowledged': ['ticket-acknowledged','Seen by Chris'], 'In Production': ['ticket-inproduction','In Production'], 'Ready': ['ticket-ready','Ready'], 'Delivered': ['ticket-delivered','Delivered'] };
            var tbPair = tbMap[item.ticketStatus] || ['ticket-new','New'];
            ticketBadge = '<span class="ticket-badge ' + tbPair[0] + '">' + tbPair[1] + '</span>';
          }

          var neededByHtml = '';
          if (item.deliveryRequested && item.neededByDate) {
            var nd = new Date(item.neededByDate);
            var formatted = nd.getDate() + ' ' + months[nd.getMonth()];
            if (item.isOverdue) {
              var overdueDays = Math.abs(item.daysUntilNeeded);
              neededByHtml = '<span style="color:var(--red);font-weight:700;font-size:11px;">⚠ Needed by ' + formatted + ' (' + overdueDays + 'd overdue)</span>';
            } else {
              neededByHtml = '<span style="color:var(--text-muted);font-size:11px;">Needed by ' + formatted + '</span>';
            }
          }

          var fabStatusBadge = '<span class="pill ' + (fabStatusPill[item.fabStatus] || 'pill-grey') + '">' + esc(item.fabStatus || 'Not Started') + '</span>';
          var itemFabColor = item.fabPct >= 80 ? 'var(--green)' : item.fabPct >= 40 ? 'var(--amber)' : 'var(--red)';

          var actionHtml = '';
          if (item.deliveryRequested && item.deliveryReqId) {
            if (item.ticketStatus === 'New') {
              actionHtml = '<button class="btn btn-sm btn-ticket-action" data-pid="' + esc(p.projectId) + '" data-reqid="' + esc(item.deliveryReqId) + '" data-action="acknowledge">Acknowledge</button>';
            } else if (item.ticketStatus === 'Acknowledged') {
              actionHtml = '<button class="btn btn-sm btn-ticket-action" data-pid="' + esc(p.projectId) + '" data-reqid="' + esc(item.deliveryReqId) + '" data-action="inproduction">Mark In Production</button>';
            } else if (item.ticketStatus === 'In Production') {
              actionHtml = '<button class="btn btn-sm btn-ticket-action" data-pid="' + esc(p.projectId) + '" data-reqid="' + esc(item.deliveryReqId) + '" data-action="ready">Mark Ready</button>';
            } else if (item.ticketStatus === 'Ready') {
              actionHtml = '<span style="color:var(--green);font-size:11px;font-weight:700;">✓ Ready — awaiting delivery</span>';
            }
          }

          return '<div class="factory-item-row ' + ticketCssClass + '">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
              '<span style="flex:1;font-size:13px;font-weight:500;">' + esc(item.description) + '</span>' +
              '<span style="font-size:11px;color:var(--text-muted);">' + item.doneQty + '/' + item.totalQty + ' units</span>' +
              fabStatusBadge +
              ticketBadge +
              neededByHtml +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:5px;">' +
              '<div class="mini-bar" style="flex:1;"><div class="mini-fill" style="width:' + item.fabPct + '%;background:' + itemFabColor + '"></div></div>' +
              '<span style="font-size:11px;font-weight:600;color:' + itemFabColor + ';width:34px;text-align:right;">' + item.fabPct + '%</span>' +
              actionHtml +
            '</div>' +
          '</div>';
        }).join('');

        var endLabel = p.endDate ? ' <span style="color:var(--text-muted);font-size:11px;">End: ' + p.endDate + '</span>' : '';
        return '<div class="factory-project-group">' +
          '<div class="factory-project-header">' +
            '<span class="factory-project-name">' + esc(p.jobCode) + ' · ' + esc(p.projectName) + '</span>' +
            endLabel +
            '<a href="project.html?id=' + esc(p.projectId) + '" class="btn btn-ghost btn-sm" style="margin-left:auto;">View →</a>' +
          '</div>' +
          fabBarHtml +
          chipsHtml +
          itemsHtml +
        '</div>';
      }).join('');

      // Ticket action buttons
      list.querySelectorAll('.btn-ticket-action').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var pid = this.dataset.pid, reqId = this.dataset.reqid, action = this.dataset.action;
          var now = new Date().toISOString();
          var updates = {};
          if (action === 'acknowledge') {
            updates = { ticketStatus: 'Acknowledged', acknowledgedBy: 'Chris', acknowledgedAt: now };
          } else if (action === 'inproduction') {
            updates = { ticketStatus: 'In Production', inProductionAt: now };
          } else if (action === 'ready') {
            updates = { ticketStatus: 'Ready', readyAt: now, readyMarkedBy: 'Chris' };
          }
          try {
            await api('PUT', '/api/projects/' + pid + '/delivery-requests/' + reqId, updates);
            showToast('Updated.', 'success');
            loadFactoryQueue();
          } catch { showToast('Failed to update.', 'error'); }
        });
      });

    } catch (err) {
      console.error('[LYS Dashboard] loadFactoryQueue failed:', err);
      var fqList = document.getElementById('factory-queue-list');
      if (fqList) fqList.innerHTML = '<div style="padding:12px;color:var(--red);font-size:13px;">Failed to load factory queue</div>';
    }
  }

  // ── Factory panel toggle ──────────────────────────────────────────────────
  function bindFactoryToggle() {
    var panel = document.getElementById('factory-panel');
    var chevron = document.getElementById('factory-chevron');
    document.getElementById('factory-toggle').addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      chevron.textContent = collapsed ? '▼' : '▲';
    });
  }

  // ── Action panel toggle ───────────────────────────────────────────────────
  function bindMondayToggle() {
    var panel = document.getElementById('monday-panel');
    var chevron = document.getElementById('monday-chevron');
    var toggle = document.getElementById('monday-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var collapsed = panel.classList.toggle('collapsed');
        chevron.textContent = collapsed ? '▼' : '▲';
      });
    }
    var mcPanel = document.getElementById('mc-panel');
    var mcChevron = document.getElementById('mc-chevron');
    var mcToggle = document.getElementById('mc-toggle');
    if (mcToggle) {
      mcToggle.addEventListener('click', function () {
        var collapsed = mcPanel.classList.toggle('collapsed');
        mcChevron.textContent = collapsed ? '▼' : '▲';
      });
    }
  }

  function renderMCList(entries) {
    var listEl = document.getElementById('mc-list');
    var countEl = document.getElementById('mc-count-label');
    if (!listEl) return;
    if (countEl) countEl.textContent = entries.length ? entries.length + ' worker' + (entries.length > 1 ? 's' : '') : '';
    if (!entries.length) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:6px 2px;">All present today ✅</div>';
      return;
    }
    var chipStyle = 'display:inline-flex;align-items:center;gap:6px;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.4);border-radius:8px;padding:5px 10px;margin:3px 4px 3px 0;font-size:12px;color:#fca5a5;font-weight:600;';
    listEl.innerHTML = '<div style="display:flex;flex-wrap:wrap;">' +
      entries.map(function(e) {
        var icon = e.type === 'MC' ? '🤒' : '🌴';
        var note = e.notes ? ' <span style="opacity:0.65;font-weight:400;">· ' + esc(e.notes) + '</span>' : '';
        return '<span style="' + chipStyle + '">' + icon + ' ' + esc(e.name) + ' <span style="opacity:0.7;font-weight:500;">(' + esc(e.type) + ')</span>' + note + '</span>';
      }).join('') + '</div>';
  }

  function renderTodayMC(assignments, workerMap, todayKey) {
    // Collect from manpower plan
    var entries = [];
    var seen = {};
    Object.keys(assignments || {}).forEach(function(wId) {
      var row = assignments[wId];
      var a = row && row[todayKey];
      if (!a || !a.type) return;
      if (a.type !== 'MC' && a.type !== 'Off') return;
      if (seen[wId]) return;
      seen[wId] = true;
      var name = (workerMap[wId] && workerMap[wId].name) || wId;
      entries.push({ name: name, type: a.type, notes: a.notes || '' });
    });
    renderMCList(entries);
  }

  async function loadTodayMCFromAttendance() {
    // Also load directly from attendance.json for live accuracy
    try {
      var att = await api('GET', '/api/attendance/today');
      var records = (att && att.records) ? att.records : [];
      var entries = [];
      var seen = {};
      records.forEach(function(r) {
        if (r.status !== 'MC' && r.status !== 'Absent' && r.status !== 'Off') return;
        if (seen[r.workerId]) return;
        seen[r.workerId] = true;
        entries.push({ name: r.workerName || r.workerId, type: r.status, notes: r.notes || '' });
      });
      renderMCList(entries);
    } catch(e) { console.warn('loadTodayMCFromAttendance error:', e); }
  }

  async function loadWeeklyBrief() {
    var el = document.getElementById('weekly-movement-list');
    if (!el) return;

    // ── Day palette ──────────────────────────────────────────────────────────
    var DAY_CFG = {
      mon: { bg:'#1e3a8a', border:'#3b82f6', text:'#93c5fd', label:'Monday'    },
      tue: { bg:'#134e4a', border:'#14b8a6', text:'#5eead4', label:'Tuesday'   },
      wed: { bg:'#14532d', border:'#22c55e', text:'#86efac', label:'Wednesday' },
      thu: { bg:'#78350f', border:'#f59e0b', text:'#fcd34d', label:'Thursday'  },
      fri: { bg:'#7c2d12', border:'#f97316', text:'#fdba74', label:'Friday'    },
      sat: { bg:'#4c1d95', border:'#a855f7', text:'#d8b4fe', label:'Saturday'  },
    };
    var DAY_KEYS = ['mon','tue','wed','thu','fri','sat'];

    // ── Assignment type palette ──────────────────────────────────────────────
    var TYPE_CFG = {
      Fabrication:  { icon:'\uD83C\uDFED', color:'#93c5fd', bg:'rgba(59,130,246,0.15)',  border:'rgba(59,130,246,0.4)'  },
      Installation: { icon:'\uD83D\uDD27', color:'#86efac', bg:'rgba(34,197,94,0.15)',   border:'rgba(34,197,94,0.4)'   },
      Driver:       { icon:'\uD83D\uDE9A', color:'#fdba74', bg:'rgba(249,115,22,0.15)',  border:'rgba(249,115,22,0.4)'  },
      MC:           { icon:'\uD83E\uDD12', color:'#fca5a5', bg:'rgba(239,68,68,0.12)',   border:'rgba(239,68,68,0.35)'  },
      Off:          { icon:'\uD83C\uDFE0', color:'#d1d5db', bg:'rgba(156,163,175,0.12)', border:'rgba(156,163,175,0.35)' },
    };

    try {
      // Get today's date in SGT as YYYY-MM-DD
      var now = new Date();
      var sgtOffset = 8 * 60; // SGT is UTC+8
      var sgtDate = new Date(now.getTime() + (sgtOffset + now.getTimezoneOffset()) * 60000);
      var day = sgtDate.getDay(); // 0=Sun, 1=Mon...
      var diff = sgtDate.getDate() - (day === 0 ? 6 : day - 1);
      var monday = new Date(sgtDate);
      monday.setDate(diff);
      var weekStart = monday.getFullYear() + '-' + String(monday.getMonth()+1).padStart(2,'0') + '-' + String(monday.getDate()).padStart(2,'0');

      function fmtYMD(dt) {
        return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
      }
      function hasAssignments(a) {
        if (!a) return false;
        var keys = Object.keys(a);
        for (var i = 0; i < keys.length; i++) {
          var row = a[keys[i]];
          if (row && ['mon','tue','wed','thu','fri','sat'].some(function(d){ return row[d] && row[d].type; })) return true;
        }
        return false;
      }

      // Fetch data — try current week, fall back to previous week if empty
      var plan        = await api('GET', '/api/manpower-plan?weekStart=' + weekStart);
      var assignments = (plan && plan.assignments) ? plan.assignments : {};
      // No fallback to previous week — show current week only (empty is fine)
      var workers     = await api('GET', '/api/workers?active=true');

      // Fetch attendance for each day of the week — used to reconcile MC/Off
      // entries in the plan (stale MC can persist in the plan file after the
      // attendance record is cleared; planning.html hides those, so match it).
      var weekAttendance = {}; // { dayKey: { workerId: status } }
      var attDates = DAY_KEYS.map(function(d, i) {
        var dt = new Date(monday);
        dt.setDate(dt.getDate() + i);
        return { day: d, date: fmtYMD(dt) };
      });
      await Promise.all(attDates.map(function(entry) {
        return api('GET', '/api/attendance?date=' + entry.date)
          .then(function(rec) {
            var map = {};
            if (rec && Array.isArray(rec.records)) {
              rec.records.forEach(function(r) { map[r.workerId] = r.status; });
            }
            weekAttendance[entry.day] = map;
          })
          .catch(function() { weekAttendance[entry.day] = {}; });
      }));

      // Lookup maps — include supply workers from plan
      var workerMap = {};
      workers.forEach(function(w) { workerMap[w.id] = w; });
      // Add supply workers to the map so their names resolve correctly
      var supplyWorkers = (plan && plan.supplyWorkers) || [];
      supplyWorkers.forEach(function(sw) { workerMap[sw.id] = sw; });

      var jobCodeMap = {};
      allProjects.forEach(function(p) {
        if (p.id) {
          var code = (p.jobCode || '').split(' ').slice(0,2).join(' ').replace(/[-\s]+$/, '');
          jobCodeMap[p.id] = code;
        }
      });

      // Build per-day summaries
      var summary = {};
      DAY_KEYS.forEach(function(d) { summary[d] = { Fabrication:[], Installation:[], Driver:[], MC:[], Off:[] }; });

      // Build project name map for clarity
      var projectNameMap = {};
      allProjects.forEach(function(p) {
        if (p.id) {
          // Use a short version: first ~30 chars of projectName or description
          var name = (p.projectName || p.name || p.description || '').trim();
          projectNameMap[p.id] = name.length > 35 ? name.slice(0, 33) + '\u2026' : name;
        }
      });

      var seenWorkerDay = {}; // dedupe: workerid+day
      Object.keys(assignments).forEach(function(wId) {
        var name = (workerMap[wId] && workerMap[wId].name) || wId;
        DAY_KEYS.forEach(function(d) {
          var a = assignments[wId][d];
          var dedupeKey = wId + '|' + d;
          if (a && a.type && summary[d][a.type] !== undefined && !seenWorkerDay[dedupeKey]) {
            // MC/Off in the stored plan can be stale — only show them when
            // today's attendance actually records the worker as MC/Off.
            if (a.type === 'MC' || a.type === 'Off') {
              var attStatus = (weekAttendance[d] || {})[wId];
              var isMC  = attStatus === 'MC';
              var isOff = attStatus === 'Absent' || attStatus === 'Off' || attStatus === 'On Leave';
              if (a.type === 'MC' && !isMC) return;
              if (a.type === 'Off' && !isOff) return;
            }
            seenWorkerDay[dedupeKey] = true;
            summary[d][a.type].push({
              name:        name,
              jobCode:     jobCodeMap[a.projectId] || '',
              projectName: projectNameMap[a.projectId] || '',
              projectId:   a.projectId || '',
              notes:       a.notes || '',
            });
          }
        });
      });

      // Today's day key (sun=0 … sat=6) — derive from SGT date
      var todayKey = ['sun','mon','tue','wed','thu','fri','sat'][sgtDate.getDay()];

      // Render Today's MC / Absent panel from the same assignments data
      renderTodayMC(assignments, workerMap, todayKey);

      var hasAny = DAY_KEYS.some(function(d) {
        return summary[d].Fabrication.length + summary[d].Installation.length + summary[d].Driver.length + summary[d].MC.length + summary[d].Off.length > 0;
      });

      if (!hasAny) {
        el.innerHTML =
          '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">' +
            'No manpower plan for this week yet.\u2002' +
            '<a href="/planning" style="color:var(--accent);">Set up in Manpower \u2192</a>' +
          '</div>';
        return;
      }

      // ── Worker chip ──────────────────────────────────────────────────────
      function chip(w, cfg) {
        // Show project label: prefer "JobCode · ProjectName", fallback to whichever exists
        var proj = '';
        if (w.jobCode && w.projectName) {
          proj = esc(w.jobCode) + ' \u00b7 ' + esc(w.projectName);
        } else if (w.jobCode) {
          proj = esc(w.jobCode);
        } else if (w.projectName) {
          proj = esc(w.projectName);
        }
        var notesHtml = w.notes
          ? '<div style="font-size:9px;opacity:0.55;margin-top:1px;font-style:italic;">' + esc(w.notes) + '</div>'
          : '';
        var href = w.projectId ? '/project.html?id=' + encodeURIComponent(w.projectId) : null;
        var inner =
          '<span style="font-weight:700;font-size:12px;color:' + cfg.color + ';line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' +
            esc(w.name) +
          '</span>' +
          (proj
            ? '<span style="font-size:10px;color:' + cfg.color + ';opacity:0.65;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' +
                proj +
              '</span>'
            : '') +
          notesHtml;
        var baseStyle =
          'display:inline-flex;flex-direction:column;' +
          'background:' + cfg.bg + ';border:1px solid ' + cfg.border + ';' +
          'border-radius:8px;padding:5px 9px;margin:3px 3px 3px 0;' +
          'min-width:90px;max-width:190px;vertical-align:top;text-decoration:none;';
        if (href) {
          return '<a href="' + href + '" style="' + baseStyle + 'cursor:pointer;transition:opacity 0.15s;" ' +
            'onmouseover="this.style.opacity=\'0.8\'" onmouseout="this.style.opacity=\'1\'">' +
            inner + '</a>';
        }
        return '<div style="' + baseStyle + '">' + inner + '</div>';
      }

      // ── Type group ───────────────────────────────────────────────────────
      function typeGroup(list, type) {
        if (!list.length) return '';
        var cfg = TYPE_CFG[type];
        return '<div style="margin-bottom:7px;">' +
          '<div style="font-size:10px;font-weight:700;text-transform:uppercase;' +
            'letter-spacing:0.5px;color:' + cfg.color + ';margin-bottom:3px;">' +
            cfg.icon + '\u2002' + type +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;">' +
            list.map(function(w) { return chip(w, cfg); }).join('') +
          '</div>' +
        '</div>';
      }

      // ── Day card ─────────────────────────────────────────────────────────
      function dayCard(d) {
        var dc    = DAY_CFG[d];
        var fab   = summary[d].Fabrication;
        var inst  = summary[d].Installation;
        var drv   = summary[d].Driver;
        var mc    = summary[d].MC;
        var off   = summary[d].Off;
        var total = fab.length + inst.length + drv.length + mc.length + off.length;
        var today = (d === todayKey);

        // Empty day → compact single-line row (no big coloured block)
        if (total === 0) {
          return '<div style="' +
              'flex:0 0 auto;' +
              'background:rgba(255,255,255,0.015);' +
              'border:1px solid ' + (today ? dc.border + '55' : 'rgba(255,255,255,0.06)') + ';' +
              'border-radius:8px;overflow:hidden;' +
              (today ? 'box-shadow:0 0 0 2px ' + dc.border + '22;' : '') +
            '">' +
            '<div style="' +
              'background:' + dc.bg + ';opacity:0.65;' +
              'padding:7px 12px;' +
              'display:flex;align-items:center;gap:12px;' +
            '">' +
              '<span style="font-size:12px;font-weight:800;letter-spacing:0.3px;color:' + dc.text + ';min-width:28px;">' +
                dc.label.slice(0,3).toUpperCase() +
                (today ? '\u00a0<span style="font-size:9px;vertical-align:middle;opacity:0.8;">TODAY</span>' : '') +
              '</span>' +
              '<span style="font-size:11px;color:rgba(255,255,255,0.22);font-style:italic;">No assignments</span>' +
            '</div>' +
          '</div>';
        }

        var header =
          '<div style="' +
            'background:' + dc.bg + ';' +
            'border-bottom:2px solid ' + dc.border + ';' +
            'padding:9px 12px;' +
            'display:flex;align-items:center;justify-content:space-between;' +
          '">' +
            '<div>' +
              '<div style="font-size:14px;font-weight:800;letter-spacing:0.3px;color:' + dc.text + ';">' +
                dc.label.slice(0,3).toUpperCase() +
                (today ? ' <span style="font-size:9px;vertical-align:middle;opacity:0.75;">TODAY</span>' : '') +
              '</div>' +
              '<div style="font-size:10px;color:' + dc.text + ';opacity:0.55;margin-top:1px;">' +
                dc.label +
              '</div>' +
            '</div>' +
            '<span style="background:' + dc.border + ';color:#fff;border-radius:50%;' +
                'width:22px;height:22px;display:flex;align-items:center;justify-content:center;' +
                'font-size:11px;font-weight:800;flex-shrink:0;">' + total + '</span>' +
          '</div>';

        var body = typeGroup(fab, 'Fabrication') +
                   typeGroup(inst, 'Installation') +
                   typeGroup(drv, 'Driver') +
                   typeGroup(mc, 'MC') +
                   typeGroup(off, 'Off');

        return '<div style="' +
            'flex:0 0 210px;min-width:210px;' +
            'background:rgba(255,255,255,0.03);' +
            'border:1px solid ' + (today ? dc.border : 'rgba(255,255,255,0.09)') + ';' +
            'border-radius:10px;overflow:hidden;' +
            (today ? 'box-shadow:0 0 0 2px ' + dc.border + '44;' : '') +
          '">' +
          header +
          '<div style="padding:10px 12px;">' + body + '</div>' +
        '</div>';
      }

      // ── Week date range label ─────────────────────────────────────────────
      var d0 = new Date(weekStart);
      var d5 = new Date(weekStart); d5.setDate(d5.getDate() + 5);
      var fmtD = function(dt) {
        return dt.toLocaleDateString('en-SG', { day:'numeric', month:'short' });
      };
      var weekLabel = fmtD(d0) + '\u2013' + fmtD(d5) + ' ' + d0.getFullYear();

      // Inject date into panel header
      var wml = document.getElementById('wm-date-label');
      if (wml) wml.textContent = weekLabel;

      el.innerHTML =
        '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;">' +
          '<div id="wm-cards-row" style="display:flex;gap:10px;min-width:max-content;">' +
            DAY_KEYS.map(dayCard).join('') +
          '</div>' +
        '</div>';

      // Mobile: stack cards vertically
      if (!document.getElementById('wm-mobile-style')) {
        var s = document.createElement('style');
        s.id = 'wm-mobile-style';
        s.textContent =
          '@media(max-width:599px){' +
            '#wm-cards-row{flex-direction:column!important;min-width:unset!important;}' +
            '#wm-cards-row>div{flex:1 1 auto!important;min-width:unset!important;}' +
          '}';
        document.head.appendChild(s);
      }

    } catch(e) {
      console.warn('[LYS] loadWeeklyBrief error:', e);
      el.innerHTML =
        '<div style="color:var(--text-muted);font-size:13px;">' +
          'No manpower data yet.\u2002' +
          '<a href="/planning" style="color:var(--accent);">Set up in Manpower \u2192</a>' +
        '</div>';
    }
  }

  // ── Send Reminder (global) ────────────────────────────────────────────────
  window.sendReminder = async function (projectId, stageNum, owner, stageName, projectName, jobCode, days) {
    if (!confirm('Send reminder to ' + owner + ' for "' + stageName + '" on ' + projectName + '?')) return;
    try {
      var res = await fetch('/api/remind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectId,
          stageNum: stageNum,
          ownerName: owner,
          ownerEmail: '',
          stageName: stageName,
          projectName: projectName,
          jobCode: jobCode,
          daysInStatus: days
        })
      });
      if (res.status === 503) { showToast('Outlook not configured — set up .env', 'error'); return; }
      if (!res.ok) { showToast('Failed to send reminder', 'error'); return; }
      showToast('Reminder sent to ' + owner, 'success');
    } catch (e) {
      showToast('Failed to send reminder', 'error');
    }
  };

  // ── Project Cards ─────────────────────────────────────────────────────────
  async function loadProjects() {
    try {
      allProjects = await api('GET', '/api/projects');
      renderSidebarProjects(allProjects);
      renderProjects();
      await renderCharts(allProjects);
    } catch (err) {
      console.error('[LYS Dashboard] loadProjects failed:', err);
      document.getElementById('project-list').innerHTML = '<div class="empty-state">Failed to load projects</div>';
    }
  }

  function cardStatusBadge(status) {
    var map = {
      'On Track':  'pill-green',
      'Delayed':   'pill-red',
      'On Hold':   'pill-amber',
      'Completed': 'pill-blue',
      'Cancelled': 'pill-grey',
      'Tendering': 'pill-purple',
    };
    var cls = map[status] || 'pill-grey';
    return '<span class="pill ' + cls + '">' + (status || '—') + '</span>';
  }

  window._toggleAllProjects = function() {
    showAllProjects = !showAllProjects;
    renderProjects();
  };

  function isActiveFabInstall(p) {
    var fab = parseFloat(p.fabPercent) || 0;
    var inst = parseFloat(p.installPercent) || 0;
    var stage = (p.currentStage || '').toLowerCase();
    return fab > 0 || inst > 0 || stage.indexOf('fabrication') !== -1 || stage.indexOf('installation') !== -1;
  }

  function renderProjects() {
    var container = document.getElementById('project-list');
    var q = searchQuery.toLowerCase();

    var filtered = allProjects.filter(function (p) {
      if (!showAllProjects && !isActiveFabInstall(p)) return false;
      var matchStatus = activeStatus === 'all' || p.status === activeStatus;
      var matchSearch = !q ||
        (p.jobCode || '').toLowerCase().includes(q) ||
        (p.projectName || '').toLowerCase().includes(q) ||
        (p.product || '').toLowerCase().includes(q) ||
        (p.client || '').toLowerCase().includes(q);
      return matchStatus && matchSearch;
    });

    // Sort: Delayed first, On Hold, On Track, Completed last
    var order = { 'Delayed': 0, 'On Hold': 1, 'On Track': 2, 'Completed': 3 };
    filtered.sort(function (a, b) {
      return (order[a.status] !== undefined ? order[a.status] : 9) - (order[b.status] !== undefined ? order[b.status] : 9);
    });

    var labelText = showAllProjects
      ? '\uD83D\uDCC2 All Projects (' + filtered.length + ')'
      : '\uD83C\uDFD7\uFE0F Active — In Fabrication / Installation (' + filtered.length + ' project' + (filtered.length === 1 ? '' : 's') + ')';

    var labelHtml =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 12px;">' +
        '<div class="section-label" style="margin:0;font-size:13px;">' + labelText + '</div>' +
      '</div>';

    var footerLinkText = showAllProjects ? '\u2190 Show Active Only' : 'View All Projects \u2192';
    var footerHtml =
      '<div style="text-align:center;margin-top:12px;">' +
        '<a href="#" onclick="event.preventDefault();window._toggleAllProjects();" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:600;">' + footerLinkText + '</a>' +
      '</div>';

    if (!filtered.length) {
      container.innerHTML = labelHtml +
        '<div class="empty-state">No projects currently in fabrication or installation</div>' +
        footerHtml;
      return;
    }

    container.innerHTML = labelHtml + filtered.map(function (p) {
      var statusClass = 'status-' + (p.status || '').toLowerCase().replace(/\s/g, '');
      var fabPct     = calcFabPct(p);
      var installPct = calcInstallPct(p);
      var claimsPct  = calcClaimsPct(p);
      var note = truncate(p.latestNotes || '', 100);

      // End date
      var endDateHtml = '';
      if (p.endDate) {
        var today = new Date(); today.setHours(0,0,0,0);
        var end = new Date(p.endDate);
        var diff = Math.floor((end - today) / 86400000);
        var edColor = diff < 0 ? 'var(--red)' : diff <= 30 ? 'var(--amber)' : 'var(--text-muted)';
        var edLabel = diff < 0 ? 'Overdue' : diff === 0 ? 'Due today' : diff + 'd left';
        endDateHtml = '<span class="card-end-date" style="color:' + edColor + ';">' + edLabel + '</span>';
      }

      var stageLine = ''; // Stage tracking removed — team communicates daily

      return '<div class="project-card ' + statusClass + '" onclick="window.location=\'project.html?id=' + p.id + '\'">' +
        '<div class="project-card-header">' +
          '<span class="project-card-title">' + esc(p.jobCode) + ' &middot; ' + esc(p.projectName) + '</span>' +
          cardStatusBadge(p.status) +
        '</div>' +
        '<div class="project-card-subtitle">' +
          '<span>' + esc(p.client || '—') + '</span>' +
          '<span>&middot;</span>' +
          '<span>' + fmtCurrency(p.contractValue || 0) + '</span>' +
          (endDateHtml ? '<span>&middot;</span>' + endDateHtml : '') +
        '</div>' +
        stageLine +
        '<div class="proj-progress-rows">' +
          '<div class="proj-progress-row">' +
            '<span class="proj-progress-label">FAB</span>' +
            '<div class="progress-bar" style="flex:1;margin-top:0;height:6px;">' +
              '<div class="progress-fill progress-fill-blue" style="width:' + fabPct + '%;"></div>' +
            '</div>' +
            '<span class="proj-progress-pct">' + fabPct + '%</span>' +
          '</div>' +
          '<div class="proj-progress-row">' +
            '<span class="proj-progress-label">INSTALL</span>' +
            '<div class="progress-bar" style="flex:1;margin-top:0;height:6px;">' +
              '<div class="progress-fill progress-fill-green" style="width:' + installPct + '%;"></div>' +
            '</div>' +
            '<span class="proj-progress-pct">' + installPct + '%</span>' +
          '</div>' +
          '<div class="proj-progress-row">' +
            '<span class="proj-progress-label">CLAIMS</span>' +
            '<div class="progress-bar" style="flex:1;margin-top:0;height:6px;">' +
              '<div class="progress-fill progress-fill-amber" style="width:' + claimsPct + '%;"></div>' +
            '</div>' +
            '<span class="proj-progress-pct">' + claimsPct + '%</span>' +
          '</div>' +
        '</div>' +
        (note ? '<div class="project-card-note">' + esc(note) + '</div>' : '') +
      '</div>';
    }).join('') + footerHtml;
  }

  // ── Sidebar Projects ──────────────────────────────────────────────────────
  
  function detectCategory(p) {
    if (p.category) return p.category;
    var code = (p.jobCode || '').toUpperCase();
    if (code.startsWith('BD')) return 'Bollard / Security';
    if (code.startsWith('PJ')) return 'Structural Steel';
    if (code.startsWith('DS')) return 'Ad-hoc';
    return 'Ad-hoc';
  }

  window.toggleSidebarCat = function(cat) {
    var group = document.querySelector('.sidebar-cat-group[data-cat="' + cat + '"]');
    if (!group) return;
    var body = group.querySelector('.sidebar-cat-body');
    var chevron = group.querySelector('.sidebar-cat-chevron');
    var isCollapsed = body.style.display === 'none';
    body.style.display = isCollapsed ? '' : 'none';
    chevron.textContent = isCollapsed ? '▸' : '▾';
    localStorage.setItem('sidebar-cat-' + cat, isCollapsed ? '' : 'collapsed');
  };


  function renderSidebarProjects(projects) {
    var container = document.getElementById('sidebar-projects');
    if (!container) return;

    var statusColors = {
      'On Track': '#00c875', 'Active': '#00c875',
      'Delayed': '#e2445c', 'On Hold': '#fdab3d', 'Completed': '#3366ff'
    };
    var categoryIcons = {
      'Bollard / Security': '🔩',
      'Structural Steel': '🏗',
      'Ad-hoc': '📋',
      'Other': '📁'
    };
    var sortOrder = { 'Delayed': 0, 'On Hold': 1, 'On Track': 2, 'Active': 2, 'Completed': 3 };

    // Group by category
    var groups = {};
    projects.forEach(function(p) {
      var cat = detectCategory(p);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(p);
    });

    // Sort within each group
    Object.values(groups).forEach(function(arr) {
      arr.sort(function(a, b) {
        return (sortOrder[a.status] || 4) - (sortOrder[b.status] || 4);
      });
    });

    // Render in order — always show all 3 categories even if empty
    var catOrder = ['Bollard / Security', 'Structural Steel', 'Ad-hoc'];
    catOrder.forEach(function(c) { if (!groups[c]) groups[c] = []; });
    var allCats = catOrder.slice();
    Object.keys(groups).forEach(function(c) {
      if (!allCats.includes(c) && groups[c].length) allCats.push(c);
    });

    container.innerHTML = allCats.map(function(cat) {
      var icon = categoryIcons[cat] || '📁';
      var items = groups[cat];
      var collapsed = localStorage.getItem('sidebar-cat-' + cat) === 'collapsed';

      var itemsHtml = items.map(function(p) {
        var color = statusColors[p.status] || '#6b7294';
        var parts = (p.jobCode || '').split(' ').slice(0, 2);
        var code = parts.join(' ');
        var name = p.projectName || '';
        return '<a href="project.html?id=' + p.id + '" class="staff-nav-btn sidebar-project-item"' +
          ' draggable="true" data-project-id="' + p.id + '" data-project-cat="' + esc(cat) + '"' +
          ' data-search="' + esc((code + ' ' + name).toLowerCase()) + '"' +
          ' style="text-decoration:none;display:flex;align-items:center;gap:8px;padding:6px 10px 6px 16px;cursor:grab;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';flex-shrink:0;"></span>' +
          '<span style="font-size:11px;flex:1;min-width:0;white-space:normal;line-height:1.3;color:rgba(255,255,255,0.8);">' +
          code + (name ? ' · ' + name : '') +
          '</span>' +
          '</a>';
      }).join('');

      return '<div class="sidebar-cat-group" data-cat="' + cat + '">' +
        '<div class="sidebar-cat-header" onclick="toggleSidebarCat(\'' + cat + '\')">' +
        '<span>' + icon + ' ' + cat + '</span>' +
        '<span class="sidebar-cat-chevron">' + (collapsed ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="sidebar-cat-body sidebar-drop-zone" data-cat="' + cat + '" style="' + (collapsed ? 'display:none;' : '') + 'min-height:10px;">' +
        itemsHtml +
        '</div></div>';
    }).join('');

    // ── Drag-and-drop wiring ─────────────────────────────────────────────
    var draggedId = null;
    var draggedEl = null;

    container.querySelectorAll('.sidebar-project-item').forEach(function(el) {
      el.addEventListener('dragstart', function(e) {
        draggedId = el.dataset.projectId;
        draggedEl = el;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(function() { el.style.opacity = '0.4'; }, 0);
      });
      el.addEventListener('dragend', function() {
        el.style.opacity = '';
        container.querySelectorAll('.sidebar-drop-zone').forEach(function(z) {
          z.style.background = '';
          z.style.outline = '';
        });
      });
      // Prevent link navigation on drag
      el.addEventListener('click', function(e) {
        if (draggedEl) { e.preventDefault(); }
      });
    });

    container.querySelectorAll('.sidebar-drop-zone').forEach(function(zone) {
      zone.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.style.background = 'rgba(255,255,255,0.08)';
        zone.style.outline = '1px dashed rgba(255,255,255,0.3)';
      });
      zone.addEventListener('dragleave', function() {
        zone.style.background = '';
        zone.style.outline = '';
      });
      zone.addEventListener('drop', async function(e) {
        e.preventDefault();
        zone.style.background = '';
        zone.style.outline = '';
        var newCat = zone.dataset.cat;
        if (!draggedId || !newCat) return;
        var proj = allProjects.find(function(p) { return p.id === draggedId; });
        if (!proj) return;
        var oldCat = detectCategory(proj);
        if (oldCat === newCat) { draggedEl = null; return; }

        // Optimistically update local data and re-render
        proj.category = newCat;
        renderSidebarProjects(allProjects);

        // Persist to server
        try {
          await api('PUT', '/api/projects/' + draggedId, Object.assign({}, proj, { category: newCat }));
          showToast('Moved to ' + newCat, 'success');
        } catch(err) {
          showToast('Failed to save category', 'error');
          proj.category = oldCat;
          renderSidebarProjects(allProjects);
        }
        draggedEl = null;
      });
    });

    // Wire search
    var searchInput = document.getElementById('sidebar-project-search');
    if (searchInput && !searchInput._bound) {
      searchInput._bound = true;
      searchInput.addEventListener('input', function() {
        var q = searchInput.value.toLowerCase().trim();
        document.querySelectorAll('.sidebar-project-item').forEach(function(el) {
          el.style.display = !q || (el.dataset.search || '').includes(q) ? '' : 'none';
        });
      });
    }
  }


  // ── Filters ───────────────────────────────────────────────────────────────
  // The dashboard currently renders neither filter chips nor a search box;
  // these bindings are left in place so the page picks them up automatically
  // if they're added back to index.html.
  function bindFilters() {
    document.querySelectorAll('.filter-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        activeStatus = chip.dataset.status;
        renderProjects();
      });
    });
    var search = document.getElementById('search-input');
    if (search) {
      search.addEventListener('input', debounce(function () {
        searchQuery = search.value;
        renderProjects();
      }, 200));
    }
  }

  // ── Progress calc helpers ─────────────────────────────────────────────────
  function calcFabPct(p) {
    return Math.round(parseFloat(p.fabPercent) || 0);
  }
  function calcInstallPct(p) {
    return Math.round(parseFloat(p.installPercent) || 0);
  }
  function calcClaimsPct(p) {
    var cv   = parseFloat(p.contractValue) || 0;
    var vo   = parseFloat(p.voValue) || 0;
    var paid = parseFloat(p.paidAmount) || 0;
    var total = cv + vo;
    return total > 0 ? Math.round(paid / total * 100) : 0;
  }

  // ── Charts ────────────────────────────────────────────────────────────────
  async function renderCharts(projects) {
    // Doughnut: project status breakdown
    var statusCounts = {};
    projects.forEach(function (p) {
      var s = p.status || 'Unknown';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    var pieCtx = document.getElementById('chart-project-status');
    if (pieCtx) {
      if (window._chartStatus) window._chartStatus.destroy();
      window._chartStatus = new Chart(pieCtx, {
        type: 'doughnut',
        data: {
          labels: Object.keys(statusCounts),
          datasets: [{ data: Object.values(statusCounts),
            backgroundColor: ['#00c875','#fdab3d','#3366ff','#a25ddc','#e2445c','#6b7294'],
            borderWidth: 0, hoverOffset: 6 }]
        },
        options: { cutout: '65%',
          plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, color: '#6b7294' } } }
        }
      });
    }

    // Bar: FAB progress per active project (replaces redundant portfolio bar)
    var activeProjects = projects
      .filter(function(p) { return p.status === 'Active' || p.status === 'On Track' || p.status === 'Delayed'; })
      .slice(0, 8);

    var fabLabels = activeProjects.map(function(p) {
      var parts = (p.jobCode || '').split(' ');
      return parts[0] + (parts[1] ? ' ' + parts[1] : '');
    });

    var fabData = activeProjects.map(function(p) {
      // Use fabPercent from summary API if available
      return parseFloat(p.fabPercent) || 0;
    });

    var installData = activeProjects.map(function(p) {
      return parseFloat(p.installPercent) || 0;
    });

    var barCtx = document.getElementById('chart-portfolio-bar');
    if (barCtx) {
      if (window._chartPortfolio) window._chartPortfolio.destroy();
      window._chartPortfolio = new Chart(barCtx, {
        type: 'bar',
        data: {
          labels: fabLabels,
          datasets: [
            {
              label: 'FAB %',
              data: fabData,
              backgroundColor: '#3366ff',
              borderRadius: 4,
              borderWidth: 0
            },
            {
              label: 'Install %',
              data: installData,
              backgroundColor: '#00c875',
              borderRadius: 4,
              borderWidth: 0
            }
          ]
        },
        options: {
          plugins: {
            legend: { position: 'bottom', labels: { font: { size: 11 }, color: '#6b7294', padding: 10 } }
          },
          scales: {
            x: { ticks: { font: { size: 10 }, color: '#6b7294', maxRotation: 45 }, grid: { display: false } },
            y: {
              min: 0, max: 100,
              ticks: { font: { size: 10 }, color: '#6b7294', callback: function(v) { return v + '%'; } },
              grid: { color: '#eef0f6' }
            }
          }
        }
      });
    }

    // Claims pipeline summary — full /api/claims fetch, all statuses, no-wrap horizontal scroll
    try {
      var claims = await fetch('/api/claims').then(function(r) { return r.json(); });
      var claimsEl = document.getElementById('claims-pipeline-summary');
      if (claimsEl) {
        if (!Array.isArray(claims) || !claims.length) {
          claimsEl.innerHTML =
            '<div class="section-label" style="margin-bottom:6px;">Claims Pipeline</div>' +
            '<div style="font-size:13px;color:var(--text-muted);">No claims yet — add claims via Payment tab on any project</div>';
        } else {
          var awaitingCert = claims.filter(function(c) { return c.status === 'Awaiting Certification'; }).length;

          var statusOrder = ['Awaiting Certification','Certified','Invoiced','Disputed','Paid'];
          var statusConfig = {
            'Awaiting Certification': { pill: 'pill-amber',  icon: '⏳' },
            'Certified':              { pill: 'pill-blue',   icon: '📋' },
            'Invoiced':               { pill: 'pill-blue',   icon: '📄' },
            'Disputed':               { pill: 'pill-red',    icon: '⚠️' },
            'Paid':                   { pill: 'pill-green',  icon: '✅' },
          };

          // Group all claims by status
          var groups = {};
          claims.forEach(function(c) {
            var key = c.status || 'Unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(c);
          });

          // Show ALL defined statuses (even if empty — as greyed-out) + any unknown statuses
          var orderedStatuses = statusOrder.slice(); // always show all 5
          Object.keys(groups).forEach(function(s) {
            if (orderedStatuses.indexOf(s) === -1) orderedStatuses.push(s);
          });

          var pills = orderedStatuses.map(function(status) {
            var cfg = statusConfig[status] || { pill: 'pill-grey', icon: '•' };
            var items = groups[status] || [];
            var total = items.reduce(function(s,c) { return s + (parseFloat(c.claimAmount)||0); }, 0);
            var firstProjectId = items[0] && items[0].projectId;
            var href = firstProjectId ? 'project.html?id=' + firstProjectId + '#payment' : '#';

            // Tooltip: list all projects in this group with amounts
            var tooltipLines = items.map(function(c) {
              return (c.projectJobCode || c.projectName || 'Unknown') +
                     ': $' + ((parseFloat(c.claimAmount)||0)/1000).toFixed(1) + 'k' +
                     (c.claimNumber ? '  [Claim ' + c.claimNumber + ']' : '');
            });
            var tooltip = status + ' (' + items.length + ')' +
              (total > 0 ? ' · Total: $' + (total/1000).toFixed(0) + 'k' : '') +
              (tooltipLines.length ? '\n\n' + tooltipLines.join('\n') : '');

            // Greyed out if no items in this status
            var emptyStyle = items.length === 0
              ? 'opacity:0.35;pointer-events:none;cursor:default;'
              : 'cursor:pointer;';

            var pillLabel = cfg.icon + ' ' + status +
              (items.length ? ' (' + items.length + ')' : '');
            if (items.length && total > 0) {
              pillLabel += ' · $' + (total/1000).toFixed(0) + 'k';
            }

            return '<a href="' + href + '" class="pill ' + cfg.pill + '" ' +
              'title="' + esc(tooltip) + '" ' +
              'style="text-decoration:none;white-space:nowrap;flex-shrink:0;' + emptyStyle + '">' +
              pillLabel +
              '</a>';
          }).join('');

          claimsEl.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
              '<div class="section-label" style="margin:0;">Claims Pipeline</div>' +
              '<span style="font-size:12px;color:var(--amber);font-weight:600;flex-shrink:0;">' +
                awaitingCert + ' pending certification' +
              '</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;align-items:center;' +
              'padding-bottom:6px;scrollbar-width:thin;">' +
              pills +
            '</div>';
        }
      }
    } catch(e) { console.error('claims pipeline error:', e); }
  }

  // ── EOD Status Panel ──────────────────────────────────────────────────────
  async function loadEodStatus() {
    try {
      var today = new Date().toISOString().split('T')[0];
      var todayDisplay = new Date().toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'short' });

      var titleEl = document.getElementById('eod-title');
      if (titleEl) titleEl.textContent = 'EOD STATUS — ' + todayDisplay;

      var data = await api('GET', '/api/eod-log?date=' + today);
      var list = document.getElementById('eod-status-list');
      if (!list) return;

      var allStaff = ['Chris', 'Rena', 'Alex Mac', 'Salve', 'Teo Meei Haw', 'Jun Jie'];
      var submitted = Array.isArray(data.submitted) ? data.submitted : [];
      var logs = Array.isArray(data.logs) ? data.logs : [];

      // Map issues by staff name
      var issueMap = {};
      logs.forEach(function(l) { if (l.issues && l.issues.trim()) issueMap[l.staffName] = l.issues.trim(); });

      var submittedCount = allStaff.filter(function(n) { return submitted.includes(n); }).length;
      var flaggedCount = Object.keys(issueMap).length;

      var rows = allStaff.map(function(name) {
        var done = submitted.includes(name);
        var issues = issueMap[name] || '';
        return '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">' +
          '<span style="font-size:16px;flex-shrink:0;line-height:1.4;">' + (done ? '✅' : '⚠️') + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;font-weight:600;">' + esc(name) + '</div>' +
            (issues
              ? '<div style="font-size:11px;color:var(--amber);margin-top:3px;line-height:1.4;">' + esc(issues) + '</div>'
              : (!done ? '<div style="font-size:11px;color:var(--text-muted);">Not yet submitted</div>' : '')) +
          '</div>' +
          '<span style="font-size:11px;font-weight:700;color:' + (done ? 'var(--green)' : 'var(--text-muted)') + ';flex-shrink:0;padding-top:2px;">' +
            (done ? 'Submitted' : 'Pending') +
          '</span>' +
        '</div>';
      }).join('');

      list.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 8px;border-bottom:2px solid var(--border);margin-bottom:2px;">' +
          '<span style="font-size:12px;color:var(--text-muted);">' + submittedCount + ' of ' + allStaff.length + ' submitted</span>' +
          (flaggedCount
            ? '<span style="font-size:11px;font-weight:700;color:var(--amber);">⚠️ ' + flaggedCount + ' issue' + (flaggedCount > 1 ? 's' : '') + ' flagged</span>'
            : (submittedCount === allStaff.length ? '<span style="font-size:11px;font-weight:700;color:var(--green);">All submitted ✅</span>' : '')) +
        '</div>' +
        rows;
    } catch (err) {
      console.warn('[LYS Dashboard] loadEodStatus failed:', err);
    }
  }

  function bindEodToggle() {
    var panel = document.getElementById('eod-panel');
    var chevron = document.getElementById('eod-chevron');
    var toggle = document.getElementById('eod-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      chevron.textContent = collapsed ? '▼' : '▲';
    });
  }

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
