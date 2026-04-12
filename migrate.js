const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, '..', 'Ops Tracking Sheet', 'LYS Ops Tracking Sheet.xlsx');
const OUTPUT_PATH = path.join(__dirname, 'data', 'projects.json');

const { buildDefaultProject } = require('./server');

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function parseValue(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  const n = parseFloat(String(val).replace(/[,$]/g, ''));
  return isNaN(n) ? 0 : n;
}

function main() {
  console.log('Reading:', EXCEL_PATH);
  const wb = XLSX.readFile(EXCEL_PATH);

  const dashSheet = wb.Sheets['Dashboard'];
  if (!dashSheet) {
    console.error('Dashboard sheet not found. Check sheet name.');
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(dashSheet, { header: 1, defval: '' });

  // Row 3 (index 2) = headers, data from row 4 (index 3)
  const projects = [];
  const seen = new Set();

  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const jobCode = String(row[1] || '').trim();
    const projectName = String(row[2] || '').trim();

    if (!jobCode || !projectName) continue;

    const id = slugify(jobCode) || slugify(projectName) || `project-${i}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const contractValue = parseValue(row[5]);
    const voValue = parseValue(row[6]);
    const paidAmount = parseValue(row[8]);
    const fabPercent = parseValue(row[11]);
    const installPercent = parseValue(row[12]);
    const status = String(row[16] || 'On Track').trim() || 'On Track';
    const latestNotes = String(row[3] || '').trim();
    const product = String(row[4] || '').trim();
    const actionBy = String(row[10] || '').trim();

    const project = buildDefaultProject({
      id,
      jobCode,
      projectName,
      product,
      contractValue,
      voValue,
      paidAmount,
      fabPercent,
      installPercent,
      status,
      latestNotes,
      actionBy,
      projectManager: 'Lai Wei Xiang',
      qs: 'Salve',
      factoryManager: 'Chris',
      drafter: 'Senthil',
      purchaser: 'Rena',
      sales: 'Janessa'
    });

    projects.push(project);
    console.log(`  [${i - 2}] ${jobCode} — ${projectName} (${status}, $${contractValue.toLocaleString()})`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(projects, null, 2));
  console.log(`\nDone. Wrote ${projects.length} projects to ${OUTPUT_PATH}`);
}

main();
