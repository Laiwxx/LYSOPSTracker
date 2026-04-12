/**
 * Monte Carlo Simulation Test — LYS OPS Tracker
 * Generates random scenarios and hammers all APIs to find edge cases
 */

const http = require('http');

const BASE = 'http://localhost:3000';
const STAFF = ['Chris', 'Rena', 'Teo Meei Haw', 'Jun Jie', 'Alex Mac', 'Salve'];
const TASK_TYPES = ['Project Task', 'Directive', 'Client Request', 'Self Task'];
const STATUSES = ['Pending', 'In Progress', 'Done'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

let passed = 0, failed = 0, warnings = 0;
const issues = [];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randDate(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
}

async function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function check(label, condition, value) {
  if (condition) {
    passed++;
  } else {
    failed++;
    issues.push(`❌ FAIL: ${label} — got: ${JSON.stringify(value)}`);
  }
}

function warn(label, msg) {
  warnings++;
  issues.push(`⚠️  WARN: ${label} — ${msg}`);
}

async function run() {
  console.log('\n🎲 Monte Carlo Simulation — LYS OPS Tracker');
  console.log('─'.repeat(50));

  // ── 1. API HEALTH ────────────────────────────────────
  console.log('\n[1] API Health Check');
  const endpoints = [
    '/api/projects', '/api/staff', '/api/tasks',
    '/api/tasks/kanban', '/api/tasks/summary',
    '/api/eod-log', '/api/factory-queue'
  ];
  for (const ep of endpoints) {
    try {
      const r = await api('GET', ep);
      check(`GET ${ep} returns 200`, r.status === 200, r.status);
    } catch (e) {
      failed++;
      issues.push(`❌ FAIL: GET ${ep} threw error — ${e.message}`);
    }
  }

  // ── 2. PROJECT DATA INTEGRITY ────────────────────────
  console.log('\n[2] Project Data Integrity');
  const { body: projects } = await api('GET', '/api/projects');
  check('Projects is array', Array.isArray(projects), typeof projects);
  check('Has projects', projects.length > 0, projects.length);

  const REQUIRED_FIELDS = ['id', 'projectName', 'jobCode', 'status', 'contractValue'];
  const ARRAY_FIELDS = ['productScope', 'deliveryRequests', 'drawings', 'fabrication', 'installation', 'documents', 'meetingNotes'];

  projects.forEach(p => {
    REQUIRED_FIELDS.forEach(f => {
      if (p[f] === undefined || p[f] === null) {
        warn(`Project ${p.jobCode}`, `missing field: ${f}`);
      }
    });
    ARRAY_FIELDS.forEach(f => {
      if (!Array.isArray(p[f])) {
        warn(`Project ${p.jobCode}`, `field ${f} is not array: ${typeof p[f]}`);
      }
    });
    // Check fab% calculation won't divide by zero
    if (Array.isArray(p.fabrication)) {
      p.fabrication.forEach((row, i) => {
        if (row.qtyTotal === 0) {
          warn(`Project ${p.jobCode} fab[${i}]`, 'qtyTotal is 0 — fab% will divide by zero');
        }
      });
    }
    // Check install%
    if (Array.isArray(p.installation)) {
      p.installation.forEach((row, i) => {
        if (row.qtyTotal === 0) {
          warn(`Project ${p.jobCode} install[${i}]`, 'qtyTotal is 0 — install% may divide by zero');
        }
      });
    }
    // Check contract value
    if (p.contractValue && isNaN(parseFloat(p.contractValue))) {
      warn(`Project ${p.jobCode}`, `contractValue is not a number: ${p.contractValue}`);
    }
  });

  check('All projects have required array fields',
    projects.every(p => ARRAY_FIELDS.every(f => Array.isArray(p[f] || []))), '');

  // ── 3. TASK SYSTEM — CREATE/READ/UPDATE/DELETE ───────
  console.log('\n[3] Task CRUD — Monte Carlo (50 iterations)');
  const createdIds = [];

  for (let i = 0; i < 50; i++) {
    const daysOffset = randInt(-5, 14); // some overdue, some future
    const task = {
      title: `MC Test Task ${i} — ${rand(['drawings', 'fab check', 'site visit', 'PO followup', ''])}`,
      taskType: rand(TASK_TYPES),
      assignedTo: rand(STAFF),
      createdBy: 'MC Test',
      dueDate: Math.random() > 0.2 ? randDate(daysOffset) : '', // 20% no due date
      priority: rand(PRIORITIES),
      projectId: '',
      projectJobCode: Math.random() > 0.5 ? `BD ${randInt(19000, 26000)}` : '',
      projectName: '',
      description: Math.random() > 0.7 ? 'Test description with special chars: <>&"' : ''
    };

    try {
      const r = await api('POST', '/api/tasks', task);
      check(`Create task ${i}: status 200`, r.status === 200, r.status);
      check(`Created task has id`, !!r.body.id, r.body.id);
      if (r.body.id) createdIds.push(r.body.id);
    } catch (e) {
      failed++;
      issues.push(`❌ FAIL: Create task ${i} threw: ${e.message}`);
    }
  }

  // Edge cases — empty title, null assignee, extreme values
  const edgeCases = [
    { title: '', assignedTo: 'Chris', taskType: 'Self Task' }, // empty title
    { title: 'A'.repeat(500), assignedTo: 'Rena', taskType: 'Project Task' }, // very long title
    { title: 'Test', assignedTo: '', taskType: 'Self Task' }, // no assignee
    { title: '<script>alert(1)</script>', assignedTo: 'Chris', taskType: 'Self Task' }, // XSS attempt
    { title: 'Test', dueDate: '9999-12-31', assignedTo: 'Teo Meei Haw', taskType: 'Directive' }, // far future date
    { title: 'Test', dueDate: '2020-01-01', assignedTo: 'Jun Jie', taskType: 'Client Request' }, // very old date
  ];

  console.log('\n[3b] Edge Cases');
  for (const ec of edgeCases) {
    try {
      const r = await api('POST', '/api/tasks', ec);
      // Server should handle all gracefully (not crash)
      check(`Edge case "${String(ec.title).slice(0,20)}": server didn't crash`, r.status < 500, r.status);
      if (r.body.id) createdIds.push(r.body.id);
    } catch (e) {
      failed++;
      issues.push(`❌ FAIL: Edge case threw: ${e.message}`);
    }
  }

  // ── 4. STATUS TRANSITIONS ────────────────────────────
  console.log('\n[4] Status Transitions');
  if (createdIds.length >= 3) {
    const transitions = [
      ['Pending', 'In Progress'],
      ['In Progress', 'Done'],
      ['Done', 'Pending'], // reverse — should still work
    ];
    for (let i = 0; i < transitions.length; i++) {
      const [from, to] = transitions[i];
      const id = createdIds[i];
      try {
        const r = await api('PUT', `/api/tasks/${id}`, { status: to });
        check(`Transition ${from}→${to}`, r.status === 200 && r.body.status === to, r.body.status);
      } catch (e) {
        failed++;
        issues.push(`❌ FAIL: Status transition ${from}→${to}: ${e.message}`);
      }
    }

    // Update nonexistent task
    const r = await api('PUT', '/api/tasks/nonexistent-id-xyz', { status: 'Done' });
    check('Update nonexistent task returns 404', r.status === 404, r.status);
  }

  // ── 5. HOURS LOGGING ────────────────────────────────
  console.log('\n[5] EOD Hours Logging');
  if (createdIds.length > 0) {
    const hourCases = [0, 0.5, 2.5, 8, 9, 24, -1]; // including edge values
    for (const hrs of hourCases) {
      try {
        const r = await api('POST', `/api/tasks/${createdIds[0]}/hours`, {
          date: new Date().toISOString().split('T')[0],
          hours: hrs,
          note: `MC test — ${hrs}hrs`,
          loggedBy: 'Chris'
        });
        check(`Log ${hrs}hrs: server didn't crash`, r.status < 500, r.status);
        if (hrs < 0) warn(`Negative hours (${hrs})`, 'server accepted negative hours — consider validation');
      } catch (e) {
        failed++;
        issues.push(`❌ FAIL: Log ${hrs}hrs threw: ${e.message}`);
      }
    }
  }

  // ── 6. EOD LOG SUBMISSION ────────────────────────────
  console.log('\n[6] EOD Log Submission');
  if (createdIds.length >= 2) {
    const eodPayload = {
      staffName: 'Chris',
      date: new Date().toISOString().split('T')[0],
      totalHours: 8.5,
      notes: 'MC test EOD log',
      taskEntries: [
        { taskId: createdIds[0], hours: 4, markDone: false },
        { taskId: createdIds[1], hours: 4.5, markDone: true }
      ]
    };
    try {
      const r = await api('POST', '/api/eod-log', eodPayload);
      check('EOD log submission: 200', r.status === 200, r.status);
      check('EOD log returns ok:true', r.body.ok === true, r.body.ok);

      // Verify task was marked done
      const taskR = await api('GET', '/api/tasks');
      const updatedTask = taskR.body.find(t => t.id === createdIds[1]);
      if (updatedTask) {
        check('markDone=true updated task status to Done', updatedTask.status === 'Done', updatedTask.status);
      }
    } catch (e) {
      failed++;
      issues.push(`❌ FAIL: EOD log threw: ${e.message}`);
    }
  }

  // ── 7. KANBAN GROUPING ───────────────────────────────
  console.log('\n[7] Kanban API Validation');
  const kanban = await api('GET', '/api/tasks/kanban');
  check('Kanban returns 200', kanban.status === 200, kanban.status);
  STAFF.forEach(name => {
    const d = kanban.body[name];
    check(`Kanban has entry for ${name.split(' ')[0]}`, !!d, !!d);
    if (d) {
      check(`${name.split(' ')[0]} kanban has pending[]`, Array.isArray(d.pending), typeof d.pending);
      check(`${name.split(' ')[0]} kanban has inProgress[]`, Array.isArray(d.inProgress), typeof d.inProgress);
      check(`${name.split(' ')[0]} kanban has done[]`, Array.isArray(d.done), typeof d.done);
    }
  });

  // ── 8. CLEANUP ───────────────────────────────────────
  console.log('\n[8] Cleanup — deleting test tasks');
  let cleaned = 0;
  for (const id of createdIds) {
    try {
      const r = await api('DELETE', `/api/tasks/${id}`);
      if (r.status === 200) cleaned++;
    } catch {}
  }
  check(`Cleaned up ${cleaned}/${createdIds.length} test tasks`, cleaned === createdIds.length, cleaned);

  // ── RESULTS ─────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('RESULTS');
  console.log('═'.repeat(50));
  console.log(`✅ Passed:   ${passed}`);
  console.log(`❌ Failed:   ${failed}`);
  console.log(`⚠️  Warnings: ${warnings}`);
  console.log('─'.repeat(50));

  if (issues.length > 0) {
    console.log('\nIssues found:');
    issues.forEach(i => console.log('  ' + i));
  } else {
    console.log('\n🎉 All checks passed — no issues found!');
  }

  console.log('\n' + '═'.repeat(50));
  const score = Math.round((passed / (passed + failed)) * 100);
  console.log(`Health Score: ${score}% (${passed}/${passed + failed} checks passed)`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('❌ Simulation crashed:', e.message);
  process.exit(1);
});
