/* ── dashboard.js ── LYS OPS Tracker ── Boss View ── */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let allProjects = [];
  let activeStatus = 'all';
  let searchQuery = '';

  // ── Boot ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    loadSummary();
    loadActions();
    loadFactoryQueue();
    loadProjects();
    renderTaskAlerts();
    loadSiteRequestAlerts();
    loadOverduePOAlerts();
    loadWeeklyBrief();
    bindActionToggle();
    bindFactoryToggle();
    bindMondayToggle();
    bindFilters();
  });

  // ── Hero Metrics ──────────────────────────────────────────────────────────
  async function loadSummary() {
    try {
      const s = await api('GET', '/api/summary');
      document.getElementById('hero-portfolio').textContent = fmtCurrencyShort(s.totalContract + s.totalVO);
      document.getElementById('hero-outstanding').textContent = fmtCurrencyShort(s.outstanding || 0);

      // Active projects = total minus completed
      var active = (s.total || 0) - (s.completed || 0);
      var heroActive = document.getElementById('hero-active');
      if (heroActive) heroActive.textContent = active;
      var heroActiveSub = document.getElementById('hero-active-sub');
      if (heroActiveSub) heroActiveSub.textContent = 'of ' + (s.total || 0) + ' projects';
      var heroPortfolioSub = document.getElementById('hero-portfolio-sub');
      if (heroPortfolioSub) heroPortfolioSub.textContent = (s.total || 0) + ' projects';

      // Total chip count
      var totalCount = document.getElementById('chip-total-count');
      if (totalCount) totalCount.textContent = s.total;

      // Status chips
      const row = document.getElementById('status-row');
      row.innerHTML = [
        { label: 'On Track',  count: s.onTrack,   pill: 'pill-green',  status: 'On Track' },
        { label: 'Delayed',   count: s.delayed,   pill: 'pill-red',    status: 'Delayed' },
        { label: 'On Hold',   count: s.onHold,    pill: 'pill-amber',  status: 'On Hold' },
        { label: 'Completed', count: s.completed, pill: 'pill-grey',   status: 'Completed' },
      ].map(function (x) {
        return '<div class="status-chip ' + x.pill + '" data-status="' + x.status + '" style="cursor:pointer;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:6px;margin-right:6px;">' +
          '<span style="font-size:15px;font-weight:800;">' + x.count + '</span>' +
          '<span>' + x.label + '</span>' +
          '</div>';
      }).join('');

      // Overall progress bars
      var fabPct  = s.overallFabPct  || s.avgFabPct  || 0;
      var instPct = s.overallInstallPct || s.avgInstallPct || 0;
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

      // Make status chips clickable filters
      row.querySelectorAll('.status-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var s = chip.dataset.status;
          document.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
          var matchBtn = document.querySelector('.filter-chip[data-status="' + s + '"]');
          if (matchBtn) matchBtn.classList.add('active');
          activeStatus = s;
          renderProjects();
        });
      });
    } catch (err) {
      console.error('[LYS Dashboard] loadSummary failed:', err);
      ['hero-portfolio','hero-outstanding','hero-active','hero-overdue'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.textContent = 'Error';
      });
    }
  }

  // ── Needs Attention ───────────────────────────────────────────────────────
  async function loadActions() {
    try {
      const actions = await api('GET', '/api/actions');
      const pending = actions.filter(function (a) {
        return a.stageStatus === 'Pending' || a.stageStatus === 'In Progress' || a.stageStatus === 'Overdue' || a.stageStatus === 'Delayed';
      });

      document.getElementById('action-title').textContent = 'NEEDS ATTENTION (' + pending.length + ')';
      const list = document.getElementById('attention-list');

      if (!pending.length) {
        list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">All clear — no pending actions</div>';
        return;
      }

      // Group by owner, sort each group by daysInStatus desc
      var groups = {};
      pending.forEach(function (a) {
        var owner = a.owner || 'Unassigned';
        if (!groups[owner]) groups[owner] = [];
        groups[owner].push(a);
      });
      Object.keys(groups).forEach(function (o) {
        groups[o].sort(function (a, b) { return b.daysInStatus - a.daysInStatus; });
      });
      var owners = Object.keys(groups).sort(function (a, b) {
        return Math.max(...groups[b].map(function (x) { return x.daysInStatus; })) -
               Math.max(...groups[a].map(function (x) { return x.daysInStatus; }));
      });

      list.innerHTML = owners.map(function (owner) {
        var items = groups[owner].map(function (a) {
          var overdue = a.daysInStatus > 5;
          return '<div class="attention-item' + (overdue ? ' overdue' : '') + '">' +
            '<span class="att-stage">' + esc(a.stageName) + '</span>' +
            '<span class="att-project">' + esc(a.jobCode) + '</span>' +
            '<span class="att-days' + (overdue ? ' overdue' : '') + '">' + a.daysInStatus + 'd</span>' +
            '<button class="btn btn-amber btn-sm" onclick="sendReminder(\'' + esc(a.projectId) + '\',' + a.stageNum + ',\'' + esc(a.owner) + '\',\'' + esc(a.stageName) + '\',\'' + esc(a.projectName) + '\',\'' + esc(a.jobCode) + '\',' + a.daysInStatus + ')">!</button>' +
            '</div>';
        }).join('');
        return '<div class="att-owner-group">' +
          '<div class="att-owner-header">' + esc(owner) + ' <span class="att-owner-count">' + groups[owner].length + '</span></div>' +
          items +
          '</div>';
      }).join('');
    } catch (err) {
      console.error('loadActions error:', err);
      var list = document.getElementById('attention-list');
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Failed to load actions</div>';
    }
  }

  // ── Site Request Alerts (NEEDS ATTENTION) ─────────────────────────────────
  async function loadSiteRequestAlerts() {
    try {
      const reqs = await api('GET', '/api/site-requests');
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      // Unacknowledged > 24 hrs
      const stale = reqs.filter(function (r) {
        if (r.status !== 'New') return false;
        return (now - new Date(r.createdAt).getTime()) > oneDayMs;
      });

      // New requests count for Factory badge
      const newCount = reqs.filter(function (r) { return r.status === 'New'; }).length;
      var factoryLink = document.getElementById('sidebar-factory-link');
      var factoryBadge = document.getElementById('sidebar-factory-badge');
      if (factoryBadge) {
        factoryBadge.textContent = newCount;
        factoryBadge.style.display = newCount > 0 ? 'inline-flex' : 'none';
      }

      if (!stale.length) return;

      // Inject stale requests into the attention list
      var list = document.getElementById('attention-list');
      if (!list) return;

      var existingContent = list.innerHTML;
      var srHtml = '<div class="att-owner-group">' +
        '<div class="att-owner-header">Chris (Factory) <span class="att-owner-count">' + stale.length + ' unacknowledged</span></div>' +
        stale.map(function (r) {
          var hrs = Math.floor((now - new Date(r.createdAt).getTime()) / 3600000);
          return '<div class="attention-item overdue">' +
            '<span class="att-stage">Site Request</span>' +
            '<span class="att-project">' + esc(r.item) + (r.projectJobCode ? ' · ' + esc(r.projectJobCode) : '') + '</span>' +
            '<span class="att-days overdue">' + hrs + 'h</span>' +
            '<a href="/factory" style="text-decoration:none;"><button class="btn btn-amber btn-sm">View</button></a>' +
            '</div>';
        }).join('') +
        '</div>';

      // Prepend to list (most urgent first)
      if (list.innerHTML.includes('All clear')) {
        list.innerHTML = srHtml;
      } else {
        list.innerHTML = srHtml + existingContent;
      }

      // Update title count
      var titleEl = document.getElementById('action-title');
      if (titleEl) {
        var match = titleEl.textContent.match(/\((\d+)\)/);
        var existing = match ? parseInt(match[1]) : 0;
        titleEl.textContent = 'NEEDS ATTENTION (' + (existing + stale.length) + ')';
      }
    } catch (e) {
      console.error('loadSiteRequestAlerts error:', e);
    }
  }

  // ── Overdue PO Alerts (NEEDS ATTENTION) ──────────────────────────────────
  async function loadOverduePOAlerts() {
    try {
      var pos = await api('GET', '/api/purchase-orders');
      var overdue = pos.filter(function(p) { return p.status === 'Overdue'; });
      if (!overdue.length) return;

      var list = document.getElementById('attention-list');
      if (!list) return;

      var poHtml = '<div class="att-owner-group">' +
        '<div class="att-owner-header">Procurement <span class="att-owner-count">' + overdue.length + ' overdue PO' + (overdue.length !== 1 ? 's' : '') + '</span></div>' +
        overdue.map(function(p) {
          var daysOverdue = p.promisedDate ? Math.floor((Date.now() - new Date(p.promisedDate).getTime()) / 86400000) : '?';
          return '<div class="attention-item overdue">' +
            '<span class="att-stage">PO Overdue</span>' +
            '<span class="att-project">' + esc(p.material) + (p.supplierName ? ' · ' + esc(p.supplierName) : '') + (p.projectJobCode ? ' · ' + esc(p.projectJobCode) : '') + '</span>' +
            '<span class="att-days overdue">' + daysOverdue + 'd</span>' +
            '<a href="/procurement" style="text-decoration:none;"><button class="btn btn-danger btn-sm">View</button></a>' +
            '</div>';
        }).join('') +
        '</div>';

      // Prepend to attention list
      if (list.innerHTML.includes('All clear')) {
        list.innerHTML = poHtml;
      } else {
        list.innerHTML = poHtml + list.innerHTML;
      }

      // Update title count
      var titleEl = document.getElementById('action-title');
      if (titleEl) {
        var match = titleEl.textContent.match(/\((\d+)\)/);
        var existing = match ? parseInt(match[1]) : 0;
        titleEl.textContent = 'NEEDS ATTENTION (' + (existing + overdue.length) + ')';
      }
    } catch (e) {
      console.error('loadOverduePOAlerts error:', e);
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

      var totalItems = queue.reduce(function (s, p) { return s + p.items.length; }, 0);
      var urgent = queue.reduce(function (s, p) {
        return s + p.items.filter(function (i) { return i.isOverdue; }).length;
      }, 0);
      var newTickets = queue.reduce(function (s, p) {
        return s + p.items.filter(function (i) { return i.deliveryRequested && i.ticketStatus === 'New'; }).length;
      }, 0);

      titleEl.innerHTML = 'FACTORY' +
        (totalItems ? ' — ' + totalItems + ' item' + (totalItems > 1 ? 's' : '') : '') +
        (urgent ? ' · ' + urgent + ' overdue' : '') +
        (newTickets ? '<span class="panel-badge">' + newTickets + ' new</span>' : '');

      if (!queue.length || !totalItems) {
        list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">No active fabrication items</div>';
        return;
      }

      // Sort: projects with overdue items first, then by fab % ascending
      var sorted = queue.slice().sort(function (a, b) {
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

        // Status chips row
        var chipsHtml = '';
        if (fab && fab.statusCounts) {
          var chipOrder = ['In Progress', 'QC Check', 'Ready for Delivery', 'Not Started', 'Delivered', 'Completed'];
          var chips = chipOrder
            .filter(function (s) { return fab.statusCounts[s]; })
            .map(function (s) {
              var c = statusColors[s] || 'var(--text-muted)';
              return '<span style="font-size:11px;color:' + c + ';font-weight:600;margin-right:10px;">● ' + fab.statusCounts[s] + ' ' + s + '</span>';
            }).join('');
          if (chips) {
            chipsHtml = '<div style="padding:2px 14px 6px;">' + chips + '</div>';
          }
        }

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
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      chevron.textContent = collapsed ? '' : '';
    });
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
      Driver:       { icon:'\uD83D\uDE9A', color:'#fcd34d', bg:'rgba(245,158,11,0.15)',  border:'rgba(245,158,11,0.4)'  },
    };

    try {
      // Derive this week's Monday
      var now    = new Date();
      var dow    = now.getDay();
      var monday = new Date(now);
      monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
      monday.setHours(0, 0, 0, 0);
      var weekStart = monday.toISOString().split('T')[0];

      // Fetch data
      var plan        = await api('GET', '/api/manpower-plan?weekStart=' + weekStart);
      var assignments = (plan && plan.assignments) ? plan.assignments : {};
      var workers     = await api('GET', '/api/workers?active=true');

      // Lookup maps
      var workerMap = {};
      workers.forEach(function(w) { workerMap[w.id] = w; });

      var jobCodeMap = {};
      allProjects.forEach(function(p) {
        if (p.id) {
          var code = (p.jobCode || '').split(' ').slice(0,2).join(' ').replace(/[-\s]+$/, '');
          jobCodeMap[p.id] = code;
        }
      });

      // Build per-day summaries
      var summary = {};
      DAY_KEYS.forEach(function(d) { summary[d] = { Fabrication:[], Installation:[], Driver:[] }; });

      // Build project name map for clarity
      var projectNameMap = {};
      allProjects.forEach(function(p) {
        if (p.id) {
          // Use a short version: first ~30 chars of projectName or description
          var name = (p.projectName || p.name || p.description || '').trim();
          projectNameMap[p.id] = name.length > 35 ? name.slice(0, 33) + '\u2026' : name;
        }
      });

      Object.keys(assignments).forEach(function(wId) {
        var name = (workerMap[wId] && workerMap[wId].name) || wId;
        DAY_KEYS.forEach(function(d) {
          var a = assignments[wId][d];
          if (a && a.type && summary[d][a.type] !== undefined) {
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

      var hasAny = DAY_KEYS.some(function(d) {
        return summary[d].Fabrication.length + summary[d].Installation.length + summary[d].Driver.length > 0;
      });

      if (!hasAny) {
        el.innerHTML =
          '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">' +
            'No manpower plan for this week yet.\u2002' +
            '<a href="/planning" style="color:var(--accent);">Set up in Manpower \u2192</a>' +
          '</div>';
        return;
      }

      // Today's day key (sun=0 … sat=6)
      var todayKey = ['sun','mon','tue','wed','thu','fri','sat'][now.getDay()];

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
        var total = fab.length + inst.length + drv.length;
        var today = (d === todayKey);

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
            (total > 0
              ? '<span style="background:' + dc.border + ';color:#fff;border-radius:50%;' +
                  'width:22px;height:22px;display:flex;align-items:center;justify-content:center;' +
                  'font-size:11px;font-weight:800;flex-shrink:0;">' + total + '</span>'
              : '<span style="font-size:18px;opacity:0.2;">\u25EF</span>') +
          '</div>';

        var body = total > 0
          ? typeGroup(fab, 'Fabrication') +
            typeGroup(inst, 'Installation') +
            typeGroup(drv, 'Driver')
          : '<div style="display:flex;align-items:center;justify-content:center;' +
              'min-height:50px;color:rgba(255,255,255,0.15);font-size:22px;">\u2014</div>';

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

  function bindActionToggle() {
    var panel = document.getElementById('action-panel');
    var chevron = document.getElementById('action-chevron');
    document.getElementById('action-toggle').addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      chevron.textContent = collapsed ? '▼' : '▲';
    });
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

  function renderProjects() {
    var container = document.getElementById('project-list');
    var q = searchQuery.toLowerCase();

    var filtered = allProjects.filter(function (p) {
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

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-state">No projects found</div>';
      return;
    }

    container.innerHTML = filtered.map(function (p) {
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
    }).join('');
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
        var short = name.length > 12 ? name.slice(0, 12) + '...' : name;
        return '<a href="project.html?id=' + p.id + '" class="staff-nav-btn sidebar-project-item"' +
          ' draggable="true" data-project-id="' + p.id + '" data-project-cat="' + esc(cat) + '"' +
          ' style="text-decoration:none;display:flex;align-items:center;gap:8px;padding:6px 10px 6px 16px;cursor:grab;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';flex-shrink:0;"></span>' +
          '<span style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,0.8);">' +
          code + (short ? ' · ' + short : '') +
          '</span>' +
          '<span class="drag-handle" style="opacity:0.3;font-size:10px;flex-shrink:0;" title="Drag to change category">⠿</span>' +
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
  }


  // ── Filters ───────────────────────────────────────────────────────────────
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
    search.addEventListener('input', debounce(function () {
      searchQuery = search.value;
      renderProjects();
    }, 200));
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

  // ── Task alert panel (overdue tasks) ─────────────────────────────────────
  async function renderTaskAlerts() {
    try {
      const tasks = await fetch('/api/tasks').then(r => r.json());
      const today = new Date().toISOString().split('T')[0];
      const overdue = tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'Done');

      // Update overdue KPI card
      var heroOverdue = document.getElementById('hero-overdue');
      if (heroOverdue) heroOverdue.textContent = overdue.length;

      const panel = document.getElementById('task-alert-panel');
      if (!panel || overdue.length === 0) return;
      panel.style.display = '';
      panel.style.padding = '12px 16px';
      panel.innerHTML =
        '<div class="section-label" style="color:var(--red);margin-bottom:8px;">' +
          '\u26A0\uFE0F Overdue Tasks (' + overdue.length + ')' +
          ' <a href="/tasks" style="font-size:11px;float:right;color:var(--accent);">View all \u2192</a>' +
        '</div>' +
        overdue.slice(0, 5).map(t =>
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">' +
            '<div>' +
              '<div style="font-size:13px;font-weight:500;">' + esc(t.title) + '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);">' + esc(t.assignedTo || 'Unassigned') + (t.projectJobCode ? ' \u00B7 ' + esc(t.projectJobCode) : '') + '</div>' +
            '</div>' +
            '<span class="pill pill-red">' + esc(t.dueDate) + '</span>' +
          '</div>'
        ).join('') +
        (overdue.length > 5 ? '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;"><a href="/tasks">View all ' + overdue.length + ' overdue \u2192</a></div>' : '');
    } catch (err) { console.warn('[LYS Dashboard] renderTaskAlerts failed:', err); }
  }

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
