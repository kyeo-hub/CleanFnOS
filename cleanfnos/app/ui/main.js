'use strict';

/* ---------- 状态 ---------- */
const state = {
  groups: [],    // 聚合卡片 { app, count, size, sizeText, risk, riskLabel, items:[] }
  links: [],     // 链接残留 { path, target, app }
  users: [],     // 用户残留 { user, app }
  trash: [],
  netdisk: [],   // 网盘残余 { id, path, size, sizeText }
  docker: null,  // { containers, volumes, networks, images, buildCache }
  tmp: [],       // tmp 24h+ 文件 { path, size, sizeText, atimeText, risk }
  sysTrash: [],  // 系统回收站 { path, name, vol, uid, level, size, sizeText, mtimeText }
  emptyDirs: [], // 空目录 { path }
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

/* ---------- 网盘残余 ---------- */
async function scanNetdisk() {
  $('netdisk-status').textContent = '扫描中…';
  $('btn-netdisk-scan').disabled = true;
  try {
    const j = await api('/netdisk/scan', {});
    state.netdisk = j.items || [];
    renderNetdisk();
    $('netdisk-status').textContent = `✓ ${state.netdisk.length} 个网盘残余`;
    toast('网盘残余扫描完成');
  } catch (e) {
    $('netdisk-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-netdisk-scan').disabled = false;
    syncNetdiskBtn();
  }
}

function renderNetdisk() {
  const tb = $('tbl-netdisk').querySelector('tbody');
  tb.innerHTML = '';
  $('no-netdisk').style.display = state.netdisk.length ? 'none' : 'block';
  $('tbl-netdisk').style.display = state.netdisk.length ? '' : 'none';
  $('chk-all-netdisk').checked = false;
  for (const it of state.netdisk) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-netdisk"></td>
      <td>${esc(it.id)}</td><td><code>${esc(it.path)}</code></td><td>${esc(it.sizeText)}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-netdisk')._path = it.path;
    tr.querySelector('.ck-netdisk').addEventListener('change', syncNetdiskBtn);
  }
  syncNetdiskBtn();
}

function selectedNetdisk() {
  return [...document.querySelectorAll('#tbl-netdisk tbody .ck-netdisk:checked')].map((ck) => ck._path);
}
function syncNetdiskBtn() {
  const n = selectedNetdisk().length;
  $('btn-netdisk-delete').disabled = n === 0;
  $('btn-netdisk-delete').textContent = n ? `🗑 清理选中项（${n}）` : '🗑 清理选中项';
}
$('chk-all-netdisk').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-netdisk tbody .ck-netdisk').forEach((ck) => { ck.checked = e.target.checked; });
  syncNetdiskBtn();
});
$('btn-netdisk-delete').addEventListener('click', () => {
  const paths = selectedNetdisk();
  if (!paths.length) return;
  confirmDialog('⚠️ 网盘残余清理确认', `将清理 <b>${paths.length}</b> 个网盘残余目录（移入回收站可恢复）。<br><br>已确认这些挂载点不在当前网盘配置中，确定继续吗？`, '移入回收站', async () => {
    try {
      const j = await api('/netdisk/delete', { paths, mode: 'trash' });
      toast(`完成：${(j.moved || []).length} 项成功${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await scanNetdisk();
    } catch (e) { toast('清理失败: ' + e.message, false); }
  });
});

/* ---------- Docker ---------- */
async function scanDocker() {
  $('docker-status').textContent = '扫描中…';
  $('btn-docker-scan').disabled = true;
  try {
    const j = await api('/docker/scan', {});
    state.docker = j;
    renderDocker();
    $('docker-status').textContent = `✓ ${(j.containers || []).length} 容器 / ${(j.volumes || []).length} 卷 / ${(j.networks || []).length} 网络 / ${(j.images || []).length} 镜像 / BuildCache ${(j.buildCache && j.buildCache.size) || '0 B'}`;
    toast('Docker 扫描完成');
  } catch (e) {
    $('docker-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-docker-scan').disabled = false;
    syncDockerBtn();
  }
}

function renderDockerTable(tblId, emptyId, items, cols, metaKey, labelFn) {
  const tb = $(tblId).querySelector('tbody');
  tb.innerHTML = '';
  const show = items.length > 0;
  $(emptyId).style.display = show ? 'none' : 'block';
  $(tblId).style.display = show ? '' : 'none';
  const chkAll = $(tblId).querySelector('thead input[type=checkbox]');
  if (chkAll) chkAll.checked = false;
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="${metaKey}"></td>` + cols.map((c) => `<td>${labelFn(c, it)}</td>`).join('');
    tb.appendChild(tr);
    const ck = tr.querySelector('.' + metaKey);
    ck._val = it[metaKey === 'ck-dc' ? 'name' : metaKey === 'ck-di' ? 'id' : 'name'];
    ck.addEventListener('change', syncDockerBtn);
  }
  syncDockerBtn();
}

function renderDocker() {
  const d = state.docker || { containers: [], volumes: [], networks: [], images: [] };
  // 只展示可清理项：已停止容器 / 未用卷 / 未用非系统网络 / dangling 镜像
  const stopped = d.containers.filter((c) => !c.running);
  const freeVols = d.volumes;
  const freeNets = d.networks.filter((n) => !n.system && !n.inUse);
  const dangling = d.images.filter((i) => i.dangling);

  const escT = (v) => esc(v);
  renderDockerTable('tbl-docker-containers', 'no-dc', stopped, ['名称', '状态', '镜像'], 'ck-dc', (c, it) => (c === '名称' ? escT(it.name) : c === '状态' ? escT(it.state) : escT(it.image)));
  renderDockerTable('tbl-docker-volumes', 'no-dv', freeVols, ['卷名'], 'ck-dv', (c, it) => escT(it.name));
  renderDockerTable('tbl-docker-networks', 'no-dn', freeNets, ['名称', '驱动'], 'ck-dn', (c, it) => (c === '名称' ? escT(it.name) : escT(it.driver)));
  renderDockerTable('tbl-docker-images', 'no-di', dangling, ['镜像 ID', '大小'], 'ck-di', (c, it) => (c === '镜像 ID' ? escT(it.id.slice(0, 12)) : escT(it.size)));
}

function selectedDocker() {
  const out = { containers: [], volumes: [], networks: [], images: [] };
  document.querySelectorAll('#tbl-docker-containers tbody .ck-dc:checked').forEach((ck) => out.containers.push(ck._val));
  document.querySelectorAll('#tbl-docker-volumes tbody .ck-dv:checked').forEach((ck) => out.volumes.push(ck._val));
  document.querySelectorAll('#tbl-docker-networks tbody .ck-dn:checked').forEach((ck) => out.networks.push(ck._val));
  document.querySelectorAll('#tbl-docker-images tbody .ck-di:checked').forEach((ck) => out.images.push(ck._val));
  return out;
}
function syncDockerBtn() {
  const s = selectedDocker();
  const n = s.containers.length + s.volumes.length + s.networks.length + s.images.length + ($('docker-buildcache').checked ? 1 : 0);
  $('btn-docker-delete').disabled = n === 0;
  $('btn-docker-delete').textContent = n ? `🗑 清理选中项（${n}）` : '🗑 清理选中项';
}
['chk-all-dc', 'chk-all-dv', 'chk-all-dn', 'chk-all-di'].forEach((id, idx) => {
  const map = [['#tbl-docker-containers', '.ck-dc'], ['#tbl-docker-volumes', '.ck-dv'], ['#tbl-docker-networks', '.ck-dn'], ['#tbl-docker-images', '.ck-di']];
  $(id).addEventListener('change', (e) => {
    document.querySelectorAll(map[idx][0] + ' tbody ' + map[idx][1]).forEach((ck) => { ck.checked = e.target.checked; });
    syncDockerBtn();
  });
});
$('docker-buildcache').addEventListener('change', syncDockerBtn);
$('btn-docker-delete').addEventListener('click', () => {
  const s = selectedDocker();
  const total = s.containers.length + s.volumes.length + s.networks.length + s.images.length + ($('docker-buildcache').checked ? 1 : 0);
  if (!total) return;
  const buildCacheNote = $('docker-buildcache').checked ? '<br>将清理 <b>Build Cache</b>' : '';
  confirmDialog('⚠️ Docker 资源清理确认', `将永久删除（Docker 无回收站）：<br>` +
    `${s.containers.length} 个已停止容器、${s.volumes.length} 个未用卷、${s.networks.length} 个未用网络、${s.images.length} 个 dangling 镜像${buildCacheNote}<br><br>` +
    '<b style="color:#d33">永久删除不可恢复！</b> 确定继续吗？', '永久删除', async () => {
    try {
      const j = await api('/docker/delete', { ...s, buildCache: $('docker-buildcache').checked });
      toast(`完成：${(j.moved || []).length} 项成功${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      if (j.failed && j.failed.length) toast('失败项: ' + j.failed.join('；'), false);
      await scanDocker();
    } catch (e) { toast('清理失败: ' + e.message, false); }
  });
});

/* ---------- tmp 清理 ---------- */
async function scanTmp() {
  $('tmp-status').textContent = '扫描中…';
  $('btn-tmp-scan').disabled = true;
  try {
    const j = await api('/tmp/scan', {});
    state.tmp = j.items || [];
    renderTmp();
    $('tmp-status').textContent = `✓ ${state.tmp.length} 个 tmp 文件`;
    toast('tmp 扫描完成');
  } catch (e) {
    $('tmp-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-tmp-scan').disabled = false;
    syncTmpBtn();
  }
}

function renderTmp() {
  const tb = $('tbl-tmp').querySelector('tbody');
  tb.innerHTML = '';
  $('no-tmp').style.display = state.tmp.length ? 'none' : 'block';
  $('tbl-tmp').style.display = state.tmp.length ? '' : 'none';
  $('chk-all-tmp').checked = false;
  for (const it of state.tmp) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-tmp"></td>
      <td><code>${esc(it.path)}</code></td><td>${esc(it.sizeText)}</td><td>${esc(it.atimeText)}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-tmp')._path = it.path;
    tr.querySelector('.ck-tmp').addEventListener('change', syncTmpBtn);
  }
  syncTmpBtn();
}

function selectedTmp() {
  return [...document.querySelectorAll('#tbl-tmp tbody .ck-tmp:checked')].map((ck) => ck._path);
}
function syncTmpBtn() {
  const n = selectedTmp().length;
  $('btn-tmp-delete').disabled = n === 0;
  $('btn-tmp-delete').textContent = n ? `🗑 清理选中项（${n}）` : '🗑 清理选中项';
}
$('chk-all-tmp').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-tmp tbody .ck-tmp').forEach((ck) => { ck.checked = e.target.checked; });
  syncTmpBtn();
});
$('btn-tmp-delete').addEventListener('click', () => {
  const paths = selectedTmp();
  if (!paths.length) return;
  confirmDialog('tmp 清理确认', `将移入回收站 <b>${paths.length}</b> 个 24h+ 未访问的 tmp 文件（可恢复）。确定继续吗？`, '移入回收站', async () => {
    try {
      const j = await api('/tmp/delete', { paths, mode: 'trash' });
      toast(`完成：${(j.moved || []).length} 项成功${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await scanTmp();
    } catch (e) { toast('清理失败: ' + e.message, false); }
  });
});

/* ---------- 系统回收站（.@#local/trash 批量） ---------- */
async function scanSysTrash() {
  $('sys-trash-status').textContent = '扫描中…';
  $('btn-sys-trash-scan').disabled = true;
  try {
    const j = await api('/trash/system', {});
    state.sysTrash = j.items || [];
    renderSysTrash(j.summary || []);
    $('sys-trash-status').textContent = `✓ ${state.sysTrash.length} 项系统回收站内容`;
    toast('系统回收站扫描完成');
  } catch (e) {
    $('sys-trash-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-sys-trash-scan').disabled = false;
    syncSysTrashBtn();
  }
}

function renderSysTrash(summary) {
  const tb = $('tbl-sys-trash').querySelector('tbody');
  tb.innerHTML = '';
  $('no-sys-trash').style.display = state.sysTrash.length ? 'none' : 'block';
  $('tbl-sys-trash').style.display = state.sysTrash.length ? '' : 'none';
  $('chk-all-sys-trash').checked = false;
  // 分级汇总条
  const sumEl = $('sys-trash-summary');
  if (summary && summary.length) {
    sumEl.innerHTML = '<b>' + summary.map((s) => `${esc(s.label)}: ${s.count} 项 / ${esc(s.sizeText)}`).join('　') + '</b><span>系统回收站分级（30/90/365 天）</span>';
  } else {
    sumEl.innerHTML = '<b>-</b><span>系统回收站分级（30/90/365 天）</span>';
  }
  for (const it of state.sysTrash) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-sys-trash"></td>
      <td><code>${esc(it.path)}</code></td><td>${esc(it.vol)}</td><td>${esc(it.sizeText)}</td>
      <td>${esc(it.mtimeText)}</td><td>${esc(it.level)}</td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-sys-trash')._path = it.path;
    tr.querySelector('.ck-sys-trash').addEventListener('change', syncSysTrashBtn);
  }
  syncSysTrashBtn();
}

function selectedSysTrash() {
  return [...document.querySelectorAll('#tbl-sys-trash tbody .ck-sys-trash:checked')].map((ck) => ck._path);
}
function syncSysTrashBtn() {
  const n = selectedSysTrash().length;
  $('btn-sys-trash-delete').disabled = n === 0;
  $('btn-sys-trash-delete').textContent = n ? `🗑 永久清理选中项（${n}）` : '🗑 永久清理选中项';
}
$('chk-all-sys-trash').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-sys-trash tbody .ck-sys-trash').forEach((ck) => { ck.checked = e.target.checked; });
  syncSysTrashBtn();
});
$('btn-sys-trash-delete').addEventListener('click', () => {
  const paths = selectedSysTrash();
  if (!paths.length) return;
  confirmDialog('⚠️ 系统回收站永久清理确认', `将<b style="color:#d33">永久删除</b> <b>${paths.length}</b> 项回收站内容（回收站内容无需再进回收站，不可恢复）。确定继续吗？`, '永久删除', async () => {
    try {
      const j = await api('/trash/system/delete', { paths });
      toast(`完成：${(j.removed || []).length} 项成功${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await scanSysTrash();
    } catch (e) { toast('清理失败: ' + e.message, false); }
  });
});

/* ---------- 空目录 ---------- */
async function scanEmpty() {
  const root = ($('empty-root').value || '/vol1').trim();
  $('empty-status').textContent = '扫描中…';
  $('btn-empty-scan').disabled = true;
  try {
    const j = await api('/empty/scan', { root });
    state.emptyDirs = j.dirs || [];
    renderEmpty();
    $('empty-status').textContent = `✓ ${state.emptyDirs.length} 个空目录`;
    toast('空目录扫描完成');
  } catch (e) {
    $('empty-status').textContent = '✗ 扫描失败';
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('btn-empty-scan').disabled = false;
    syncEmptyBtn();
  }
}

function renderEmpty() {
  const tb = $('tbl-empty').querySelector('tbody');
  tb.innerHTML = '';
  $('no-empty').style.display = state.emptyDirs.length ? 'none' : 'block';
  $('tbl-empty').style.display = state.emptyDirs.length ? '' : 'none';
  $('chk-all-empty').checked = false;
  for (const it of state.emptyDirs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="ck-empty"></td><td><code>${esc(it.path)}</code></td>`;
    tb.appendChild(tr);
    tr.querySelector('.ck-empty')._path = it.path;
    tr.querySelector('.ck-empty').addEventListener('change', syncEmptyBtn);
  }
  syncEmptyBtn();
}

function selectedEmpty() {
  return [...document.querySelectorAll('#tbl-empty tbody .ck-empty:checked')].map((ck) => ck._path);
}
function syncEmptyBtn() {
  const n = selectedEmpty().length;
  $('btn-empty-delete').disabled = n === 0;
  $('btn-empty-delete').textContent = n ? `🗑 清理选中项（${n}）` : '🗑 清理选中项';
}
$('chk-all-empty').addEventListener('change', (e) => {
  document.querySelectorAll('#tbl-empty tbody .ck-empty').forEach((ck) => { ck.checked = e.target.checked; });
  syncEmptyBtn();
});
$('btn-empty-delete').addEventListener('click', () => {
  const paths = selectedEmpty();
  if (!paths.length) return;
  confirmDialog('空目录清理确认', `将移入回收站 <b>${paths.length}</b> 个空目录（可恢复）。确定继续吗？`, '移入回收站', async () => {
    try {
      const j = await api('/empty/delete', { paths, mode: 'trash' });
      toast(`完成：${(j.moved || []).length} 项成功${(j.failed || []).length ? `，${j.failed.length} 项失败` : ''}`);
      await scanEmpty();
    } catch (e) { toast('清理失败: ' + e.message, false); }
  });
});

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('view-' + b.dataset.tab).classList.add('active');
    const tab = b.dataset.tab;
    if (tab === 'trash') loadTrash();
    else if (tab === 'netdisk' && !state.netdisk.length) scanNetdisk();
    else if (tab === 'docker' && !state.docker) scanDocker();
    else if (tab === 'tmp' && !state.tmp.length) scanTmp();
    else if (tab === 'sys-trash' && !state.sysTrash.length) scanSysTrash();
    else if (tab === 'empty' && !state.emptyDirs.length) scanEmpty();
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
  $('btn-netdisk-scan').addEventListener('click', scanNetdisk);
  $('btn-docker-scan').addEventListener('click', scanDocker);
  $('btn-tmp-scan').addEventListener('click', scanTmp);
  $('btn-sys-trash-scan').addEventListener('click', scanSysTrash);
  $('btn-empty-scan').addEventListener('click', scanEmpty);
  doScan();
})();
