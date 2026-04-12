const fs = require('fs');
const path = require('path');

const jsFile = path.join(__dirname, 'public/js/project.js');
const lines = fs.readFileSync(jsFile, 'utf8').split('\n');

// Find the range to replace: from renderDocuments comment to start of Drawings section
let startLine = -1, endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/^\/\/ ── TAB 2: Documents/) || lines[i].match(/^\/\/ ── TAB: Documents/)) startLine = i;
  if (lines[i].match(/^\/\/ ── Draw/) && startLine >= 0) { endLine = i; break; }
}
console.log('Replacing lines', startLine+1, 'to', endLine, '(exclusive)');

const newCode = `// ── TAB: Documents — Collapsed List View ────────────────────────────────────
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
}

function buildDocRow(doc, idx) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.dataset.idx = idx;

  const statusColors = { 'Approved': 'var(--green)', 'Submitted for Approval': 'var(--amber)', 'Not Submitted': 'var(--text-muted)', 'Rejected': 'var(--red)' };
  const statusDots  = { 'Approved': '\\u{1F7E2}', 'Submitted for Approval': '\\u{1F7E1}', 'Not Submitted': '\\u{1F534}', 'Rejected': '\\u{1F534}' };
  const dot = statusDots[doc.status] || '\\u26AA';
  const files = Array.isArray(doc.files) ? doc.files.filter(f => f.fileName) : [];
  const fileIndicator = files.length > 0
    ? '<span class="doc-file-indicator">\\u{1F4C4} ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '</span>'
    : '';

  row.innerHTML =
    '<div class="doc-row-summary">' +
      '<span class="doc-row-name">' + escHtml(doc.name || 'Unnamed') + '</span>' +
      '<span class="doc-row-status" style="color:' + (statusColors[doc.status] || 'var(--text-muted)') + ';">' + dot + ' ' + escHtml(doc.status || 'Not Submitted') + '</span>' +
      fileIndicator +
      '<button class="doc-row-toggle btn btn-ghost btn-sm">\\u25BE</button>' +
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
          '<input type="text" class="doc-notes tbl-input" value="' + escHtml(doc.notes || '') + '" placeholder="Notes\\u2026">' +
        '</div>' +
      '</div>' +
      '<div class="doc-files-section">' +
        '<div class="doc-files-list" id="doc-files-' + idx + '">' +
          files.map((f, fi) =>
            '<div class="doc-file-item">' +
              '<a href="/uploads/' + escHtml(f.fileName) + '" target="_blank" class="doc-file-link">\\u{1F4C4} ' + escHtml(f.fileName.replace(/^\\d+-/, '')) + '</a>' +
              '<button class="btn btn-ghost btn-sm doc-remove-file" data-fi="' + fi + '" style="color:var(--red);">\\u{1F5D1}</button>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<label class="btn-upload-pdf" style="margin-top:6px; cursor:pointer;">' +
          '\\u{1F4CE} ' + (doc.allowMultiple && files.length > 0 ? 'Upload Another PDF' : 'Upload PDF') +
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
    toggleBtn.textContent = isOpen ? '\\u25BE' : '\\u25B4';
    row.classList.toggle('doc-row-open', !isOpen);
  });

  row.querySelector('.doc-status-sel').addEventListener('change', function() {
    project.documents[idx].status = this.value;
    const statusEl = row.querySelector('.doc-row-status');
    statusEl.textContent = (statusDots[this.value] || '\\u26AA') + ' ' + this.value;
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

`;

const newLines = [...lines.slice(0, startLine), ...newCode.split('\n'), ...lines.slice(endLine)];
fs.writeFileSync(jsFile, newLines.join('\n'), 'utf8');
console.log('Done. New line count:', newLines.length);
