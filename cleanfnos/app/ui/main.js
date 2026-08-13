'use strict';

/* ---------- 状态 ---------- */
const state = {
  groups: [],    // 聚合卡片 { app, count, size, sizeText, risk, riskLabel, items:[] }
  links: [],     // 链接残留 { path, target, app }
  users: [],     // 用户残留 { user, app }
  trash: [],
};

const TOKEN_KEY = 'cleanfnos_token';
let apiToken = localStorage.getItem(TOKEN_KEY) || '';

const $ = (id) => document.getElementById(id);

/* ---------- 工具 ---------- */
function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => { t.className = 'toast'; }, 3000);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, body) {
  const opt = body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : {};
  if (apiToken) {
    opt.headers = opt.headers || {};
    opt.headers['X-Auth-Token'] = apiToken;
  }
  const r = await fetch('/api' + path, opt);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.code === 401) {
    await askToken();
    return api(path, body);
  }
  if (!j.success) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/** 让用户输入访问密码（安装时设置，忘记可查看 config.conf 的 auth_token） */
function askToken() {
  return new Promise((resolve) => {
    $('modal-title').textContent = '🔑 需要访问密码';
    $('modal-text').innerHTML = `
      <div>请输入安装时设置的访问密码。忘记的话可在 <code>/var/apps/cleanfnos/etc/config.conf</code> 的 auth_token 查看或修改：</div>
      <input id="token-input" type="password" style="width:100%;margin-top:10px;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--panel2);color:var(--text)" placeholder="输入访问密码" autocomplete="off">
    `;
    $('modal-ok').textContent = '保存';
    const okOld = $('modal-ok').onclick;
    $('modal-cancel').onclick = () => { $('modal').classList.add('hidden'); $('modal-ok').onclick = okOld; resolve(); };
    $('modal-ok').onclick = () => {
      const v = $('token-input').value.trim();
      if (!v) { toast('密码不能为空', false); return; }
      apiToken = v;
      localStorage.setItem(TOKEN_KEY, v);
      $('modal').classList.add('hidden');
      $('modal-ok').onclick = okOld;
      resolve();
    };
    $('modal').classList.remove('hidden');
    setTimeout(() => { const i = $('token-input'); if (i) i.focus(); }, 50);
  });
}

/* ---------- 弹窗确认 ---------- */
let modalCb = null;
function confirmDialog(title, text, okLabel, cb) {
  $('modal-title').textContent = title;
  $('modal-text').innerHTML = text;
  $('modal-ok').textContent = okLabel || '确认';
  modalCb = cb;
  $('modal').classList.remove('hidden');
}
$('modal-cancel').onclick = () => $('modal').classList.add('hidden');
$('modal-ok').onclick = () => { $('modal').classList.add('hidden'); if (modalCb) modalCb(); };

/* ---------- 扫描 ---------- */
async function doScan() {
  $('scan-status').textContent = '扫描中…';
  $('btn-scan').disabled = true;
  try {
    const j = await api('/scan', {});
    state.groups = j.groups || [];
    state.links = j.links || [];
    state.users = j.users || [];
    renderGroups();
    renderLinks();
    renderUsers();
    $('stat-apps').textContent = (j.apps || []).length;
    $('stat-orphans').textContent = state.groups.length;
    $('stat-size').textContent = fmtTotal();
    $('stat-links').textContent = state.links.length;
    $('stat-users').textContent = state.users.length;
    $('scan-status').textContent = `✓ 扫描完成：${state.groups.length} 个残留应用、${state.links.length} 个链接、${state.users.length} 个用户`;
    toast('扫描完成');
  } catch (e) {
    $('scan-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-scan').disabled = false;
    syncDeleteBtn();
  }
}

function fmtTotal() {
  const total = state.groups.reduce((s, g) => s + (g.size || 0), 0);
  if (total >= 1024 ** 3) return (total / 1024 ** 3).toFixed(2) + ' GB';
  if (total >= 1024 ** 2) return (total / 1024 ** 2).toFixed(2) + ' MB';
  if (total >= 1024) return (total / 1024).toFixed(1) + ' KB';
  return total + ' B';
}

/* ---------- 残留目录（聚合卡片）渲染 ---------- */
const TYPE_LABEL = {
  data: '@appdata（数据）', conf: '@appconf（配置）', home: '@apphome（用户数据）',
  temp: '@apptemp（临时）', meta: '@appmeta（元数据）', share: '@appshare（共享）',
  center: '@appcenter（程序）',
};
const RISK_CLASS = { low: 'risk-low', medium: 'risk-med', high: 'risk-high' };

function renderGroups() {
  const tb = $('tbl-orphans').querySelector('tbody');
  tb.innerHTML = '';
  $('no-orphans').style.display = state.groups.length ? 'none' : 'block';
  $('tbl-orphans').style.display = state.groups.length ? '' : 'none';
  $('chk-all').checked = false;

  for (const g of state.groups) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="ck" data-app="${esc(g.app)}"></td>
      <td class="app-name">${esc(g.app)}</td>
      <td><ul class="path-list">${g.items.map((i) =>
        `<li>${esc(TYPE_LABEL[i.type] || i.type)}: <code>${esc(i.path)}</code> <span class="sz">${esc(i.sizeText)}</span></li>`
      ).join('')}</ul></td>
      <td>${esc(g.sizeText)}</td>
      <td><span class="risk ${RISK_CLASS[g.risk] || ''}">${esc(g.riskLabel)}</span></td>`;
    tb.appendChild(tr);

    const ck = tr.querySelector('.ck');
    ck._paths = g.items.map((i) => i.path);
    ck._risk = g.risk;
    ck.addEventListener('change', syncDeleteBtn);
  }
  syncDeleteBtn();
}

function renderLinks() {
  const tb = $('tbl-links').querySelector('tbody');
  tb.innerHTML = '';
  $('no-links').style.display = state.links.length ? 'none' : 'block';
  $('tbl-links').style.display = state.links.length ? '' : 'none';
  $('chk-all-links').checked = false;
  for (const l of state.links) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-link"></td>
      <td><code>${esc(l.path)}</code></td>
      <td><code>${esc(l.target)}</code></td>
      <td>${esc(l.app)}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-link')._path = l.path;
    tr.querySelector('.ck-link').addEventListener('change', syncDeleteBtn);
  }
  syncDeleteBtn();
}

function renderUsers() {
  const tb = $('tbl-users').querySelector('tbody');
  tb.innerHTML = '';
  $('no-users').style.display = state.users.length ? 'none' : 'block';
  $('tbl-users').style.display = state.users.length ? '' : 'none';
  $('chk-all-users').checked = false;
  for (const u of state.users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-user"></td>
      <td><code>${esc(u.user)}</code></td><td>${esc(u.app)}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-user')._user = u.user;
    tr.querySelector('.ck-user').addEventListener('change', syncDeleteBtn);
  }
  syncDeleteBtn();
}

/* ---------- 清理 ---------- */
function selectedPaths() {
  const out = [];
  document.querySelectorAll('#tbl-orphans tbody .ck:checked').forEach((ck) => {
    out.push(...(ck._paths || []));
  });
  return out;
}
function selectedLinks() {
  return [...document.querySelectorAll('#tbl-links tbody .ck-link:checked')].map((ck) => ck._path);
}
function selectedUsers() {
  return [...document.querySelectorAll('#tbl-users tbody .ck-user:checked')].map((ck) => ck._user);
}
function selectedRisk() {
  const risks = [];
  document.querySelectorAll('#tbl-orphans tbody .ck:checked').forEach((ck) => {
    if (ck._risk) risks.push(ck._risk);
  });
  if (selectedLinks().length) risks.push('low');
  if (selectedUsers().length) risks.push('high');
  return risks;
}
function syncDeleteBtn() {
  const n = selectedPaths().length + selectedLinks().length + selectedUsers().length;
  $('btn-delete').disabled = n === 0;
  $('btn-delete').textContent = n ? `🗑 清理选中项（${n}）` : '🗑 清理选中项';
}
$('chk-all').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-orphans tbody .ck').forEach((ck) => { ck.checked = e.target.checked; });
  syncDeleteBtn();
});
$('chk-all-links').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-links tbody .ck-link').forEach((ck) => { ck.checked = e.target.checked; });
  syncDeleteBtn();
});
$('chk-all-users').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-users tbody .ck-user').forEach((ck) => { ck.checked = e.target.checked; });
  syncDeleteBtn();
});

$('btn-delete').addEventListener('click', () => {
  const paths = selectedPaths();
  const links = selectedLinks();
  const users = selectedUsers();
  const mode = $('del-mode').value;
  if (!paths.length && !links.length && !users.length) return;
  const permanent = mode === 'permanent';
  const risks = selectedRisk();
  const hasHigh = risks.includes('high');

  // 风险分级确认：高风险项强制醒目标识
  const riskNote = hasHigh
    ? '<b style="color:#d33">⚠️ 包含高风险项（应用数据/共享目录/系统用户），请确认后操作！</b><br>'
    : '<span style="color:#eab308">包含中风险项（配置/元数据）</span><br>';

  confirmDialog(
    permanent ? '⚠️ 永久删除确认' : '清理确认',
    `将处理 <b>${paths.length + links.length + users.length}</b> 项：<br>` +
      `${paths.length} 个残留目录、${links.length} 个链接残留、${users.length} 个残留用户。<br><br>` +
      riskNote +
      (permanent
        ? '<b style="color:#d33">永久删除不可恢复！</b> 确定要彻底删除吗？'
        : '移入回收站后可随时恢复。确定继续吗？'),
    permanent ? '永久删除' : '移入回收站',
    async () => {
      $('btn-delete').disabled = true;
      try {
        const j = await api('/delete', { paths, links, users, mode });
        const errs = (j.failed || []).length;
        toast(`完成：${(j.moved || []).length} 项成功${errs ? `，${errs} 项失败` : ''}`, errs === 0);
        if (j.failed && j.failed.length) toast('失败项: ' + j.failed.join('；'), false);
        await doScan();
      } catch (e) {
        toast('清理失败: ' + e.message, false);
      } finally {
        syncDeleteBtn();
      }
    }
  );
});

/* ---------- 回收站 ---------- */
async function loadTrash() {
  try {
    const j = await api('/trash');
    state.trash = j.items || [];
    renderTrash();
  } catch (e) {
    toast('加载回收站失败: ' + e.message, false);
  }
}

function renderTrash() {
  const tb = $('tbl-trash').querySelector('tbody');
  tb.innerHTML = '';
  $('no-trash').style.display = state.trash.length ? 'none' : 'block';
  $('tbl-trash').style.display = state.trash.length ? '' : 'none';
  $('chk-all-trash').checked = false;
  $('trash-count').textContent = state.trash.length ? `(${state.trash.length})` : '';
  for (const it of state.trash) {
    const tr = document.createElement('tr');
    const d = new Date(it.atime);
    tr.innerHTML = `<td><input type="checkbox" class="ck-trash"></td>
      <td><code>${esc(it.original || '')}</code></td>
      <td>${esc(TYPE_LABEL[it.type] || it.type || '-')}</td>
      <td>${esc(it.sizeText || '')}</td>
      <td>${d.toLocaleString('zh-CN')}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-trash')._name = it.name;
    tr.querySelector('.ck-trash').addEventListener('change', syncTrashBtn);
  }
  syncTrashBtn();
}

function selectedTrash() {
  return [...document.querySelectorAll('#tbl-trash tbody .ck-trash:checked')].map((ck) => ck._name);
}
function syncTrashBtn() {
  const n = selectedTrash().length;
  $('btn-trash-restore').disabled = n === 0;
  $('btn-trash-empty').disabled = state.trash.length === 0;
}
$('chk-all-trash').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-trash tbody .ck-trash').forEach((ck) => { ck.checked = e.target.checked; });
  syncTrashBtn();
});
$('btn-trash-restore').addEventListener('click', () => {
  const names = selectedTrash();
  if (!names.length) return;
  confirmDialog('恢复确认', `将恢复 <b>${names.length}</b> 项到原路径。确定继续吗？`, '恢复', async () => {
    try {
      const j = await api('/trash/restore', { names });
      toast(`成功恢复 ${(j.restored || []).length} 项${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await loadTrash();
    } catch (e) { toast('恢复失败: ' + e.message, false); }
  });
});
$('btn-trash-empty').addEventListener('click', () => {
  confirmDialog('⚠️ 清空回收站', `将永久删除回收站中全部 <b>${state.trash.length}</b> 项，<b style="color:#d33">不可恢复</b>！确定吗？`, '全部删除', async () => {
    try {
      const j = await api('/trash/empty', {});
      toast(`已清空 ${j.removed} 项${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await loadTrash();
    } catch (e) { toast('清空失败: ' + e.message, false); }
  });
});

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('view-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'trash') loadTrash();
  });
});

/* ---------- 启动 ---------- */
(async () => {
  try {
    const j = await api('/version');
    $('version').textContent = 'v' + j.version;
  } catch (e) { /* ignore */ }
  $('btn-scan').addEventListener('click', doScan);
  $('btn-trash-refresh').addEventListener('click', loadTrash);
  doScan();
})();
