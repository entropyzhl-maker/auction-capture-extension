const $ = (id) => document.getElementById(id);
let pool = poolEmpty();
const selected = new Set();
let parseTask = null;   // 后台解析任务的快照（来自 storage）
let captureTask = null; // 后台批量采集任务的快照（来自 storage）
let editingId = null;
let editingSnapshot = null;

const isBusy = () => !!parseTask?.active || !!captureTask?.active;

function setStatus(message, type = '') {
  $('status').textContent = message;
  $('status').className = `status ${type}`.trim();
}

function fmtTime(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNum(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value ?? '—';
  return String(Number(value.toFixed(digits)));
}

function setProgress(current, total, label = '') {
  $('progressWrap').hidden = false;
  $('progressBar').style.width = `${total ? Math.round(current / total * 100) : 0}%`;
  $('progressText').textContent = `${current}/${total}　${label}`;
}

function hideProgress() { $('progressWrap').hidden = true; }

// ------------------------------------------------------------
// 后台握手：识破「浏览器还在跑缓存的旧后台脚本」
// 见 common.js 第 1.5 节。命中时给出照着做就能好的中文步骤。
// ------------------------------------------------------------
async function checkBackground() {
  const result = await probeBackground();
  const box = $('diag');
  const version = chrome.runtime.getManifest().version;
  $('buildTag').textContent = `界面 v${version} · ${BUILD_STAMP}`;

  if (result.ok) {
    box.hidden = true;
    box.textContent = '';
    $('buildTag').textContent = `v${result.version} · ${result.build}`;
    return true;
  }

  const title = document.createElement('strong');
  title.textContent = result.reason === 'unreachable'
    ? '联系不上后台脚本'
    : '浏览器还在跑旧版后台脚本';
  const body = document.createElement('p');
  body.textContent = RELOAD_STEPS;
  const detail = document.createElement('p');
  detail.className = 'diag-detail';
  detail.textContent =
    `界面 ${BUILD_STAMP} ／ 后台 ${result.build || '未知（旧版没有握手接口）'}`
    + (result.error ? ` ／ ${result.error}` : '');
  box.hidden = false;
  box.textContent = '';
  box.append(title, body, detail);
  return false;
}

function renderStats() {
  const s = poolStats(pool);
  const box = $('stats');
  box.textContent = '';
  for (const [label, value, cls] of [['总条目', s.total, ''], ['待解析', s.raw, 'warn'], ['已解析', s.parsed, 'ok'], ['解析失败', s.error, 'bad']]) {
    const div = document.createElement('div');
    div.className = `stat ${cls}`.trim();
    const strong = document.createElement('strong');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    div.append(strong, span);
    box.appendChild(div);
  }
}

function cell(text, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderTable() {
  const tbody = $('poolTable').querySelector('tbody');
  tbody.textContent = '';
  $('empty').hidden = pool.items.length > 0;

  pool.items.forEach((item, index) => {
    const record = item.record || {};
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    if (selected.has(item.id)) tr.classList.add('is-selected');

    const checkTd = document.createElement('td');
    checkTd.className = 'col-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(item.id);
    check.dataset.action = 'select';
    checkTd.appendChild(check);

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `pill pill-${item.status}`;
    badge.textContent = POOL_STATUS_LABEL[item.status] || item.status;
    if (item.status === 'error' && item.extraction?.error) badge.title = item.extraction.error;
    statusTd.appendChild(badge);

    const ops = document.createElement('td');
    ops.className = 'col-ops';
    for (const [action, label, title] of [
      ['edit', '编辑', '逐字段查看/修改这条记录'],
      ['open', '打开', '在新标签页打开原页面'],
      ['del', '删除', '从采集池移除这条'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.dataset.action = action;
      if (action === 'del') button.className = 'danger';
      ops.appendChild(button);
    }

    tr.append(
      checkTd,
      cell(String(index + 1), 'col-idx'),
      statusTd,
      cell(record.community ?? '—'),
      cell(record.district ?? '—'),
      cell(record.asset_type ?? '—'),
      cell(fmtNum(record.area_sqm), 'num'),
      cell(fmtNum(record.starting_price_wan), 'num'),
      cell(displayValue('discount_rate', record.discount_rate), 'num'),
      cell(fmtNum(record.unit_price_yuan_sqm), 'num'),
      cell(item.source?.platform_label || '—'),
      cell(fmtTime(item.updated_at || item.added_at)),
      ops,
    );
    if (item.note) tr.title = `备注：${item.note}`;
    tbody.appendChild(tr);
  });

  const allSelected = pool.items.length > 0 && selected.size === pool.items.length;
  $('headCheck').checked = allSelected;
  $('headCheck').indeterminate = selected.size > 0 && !allSelected;

  const s = poolStats(pool);
  const busy = isBusy();
  $('exportSelected').disabled = !poolRecords(pool, [...selected]).length;
  $('exportAll').disabled = !s.parsedRecords;
  $('retryUnparsed').disabled = busy || unparsedTargets(pool.items).length === 0;
  $('deleteSelected').disabled = selected.size === 0 || busy;
  $('parseSelected').disabled = busy;
  $('stopParse').hidden = !parseTask?.active;
  $('clearAll').disabled = busy || pool.items.length === 0;
}

async function reload({ clearSelection = false } = {}) {
  pool = await poolLoad();
  if (clearSelection) selected.clear();
  const ids = new Set(pool.items.map(item => item.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  renderStats();
  renderTable();
}

// ------------------------------------------------------------
// 解析：统一交给后台 service worker，关掉本页也会跑完
// 未解析 = 待解析(raw) + 解析失败(error)；只要有采集包就还能重跑。
// 一个判定函数给两处用（按钮可用性 / 点击时取目标），不会出现
// 「按钮亮着但算出来 0 条」的不一致。
// ------------------------------------------------------------
function unparsedTargets(items = []) {
  return items.filter(item => item.status !== 'parsed' && !!item.package);
}
function syncParseTask(task) {
  parseTask = task;
  if (task?.active) {
    setProgress(task.done + task.failed, task.total, (task.current || '').slice(0, 60));
  } else if (task?.finished_at) {
    setProgress(task.total, task.total, task.stopped ? '已停止' : '完成');
    setTimeout(hideProgress, 2500);
  }
  renderTable();
}

async function startParse(items, actionLabel = '解析') {
  // 先握手：后台是旧脚本就别白跑一趟，直接给修法
  if (!await checkBackground()) {
    setStatus('请先按上方黄条的提示重新加载扩展，再点解析。', 'error');
    return;
  }
  const targets = items.filter(item => item.package && item.status !== 'parsed');
  if (!targets.length) {
    setStatus('选中的条目里没有可解析的采集包（已解析过，或这条只剩字段、没留页面证据）。', 'error');
    return;
  }
  const settings = await loadModelSettings();
  if (!settings.apiEndpoint) {
    setStatus('插件内置的模型地址为空，请重新加载扩展后再试。', 'error');
    return;
  }
  const granted = await chrome.permissions.request({ origins: [endpointOriginPattern(normalizeEndpoint(settings.apiEndpoint))] });
  if (!granted) {
    setStatus('未授予模型 API 的访问权限，已取消。', 'error');
    return;
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'PARSE_POOL', ids: targets.map(item => item.id) });
  } catch (error) {
    setStatus(`无法启动解析任务：${error.message}`, 'error');
    return;
  }
  if (!response?.ok) {
    setStatus(`启动失败：${response?.error || response?.reason || '未知原因'}`, 'error');
    return;
  }
  syncParseTask({ active: true, total: response.total, done: 0, failed: 0, current: '' });
  await logEvent('info', actionLabel, `共 ${response.total} 条`, { 条数: response.total });
  setStatus(`已在后台开始${actionLabel} ${response.total} 条，可以关掉本页；标题栏图标会显示进度。`, 'success');
}

function stopParse() {
  chrome.runtime.sendMessage({ type: 'STOP_PARSE' });
  setStatus('已请求停止，正在结束当前这一条…');
}

// ------------------------------------------------------------
// 导出
// ------------------------------------------------------------
async function exportCsv(ids, label) {
  const records = poolRecords(pool, ids);
  if (!records.length) {
    setStatus('没有可导出的已解析记录。先批量解析，或手动补全某条。', 'error');
    return;
  }
  const stamp = todaySlashDate().replace(/\//g, '-');
  if (typeof ReportExport === 'undefined') {
    setStatus('排版引擎未加载（report-export.js 缺失），无法导出。', 'error');
    return;
  }
  try {
    const data = ReportExport.buildReportData(records);
    if (!data.rows.length) {
      setStatus(`没有可导出的记录（小区名全空，丢弃 ${data.dropped} 行）。`, 'error');
      return;
    }
    const title = ReportExport.reportTitle();
    setStatus('正在生成排版版 xlsx 和 PDF…');
    const xlsxBytes = ReportExport.buildXlsx(data.rows, title);
    await downloadBytes(`法拍汇总-排版-${stamp}.xlsx`, xlsxBytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const pdf = await ReportExport.buildPdf(data.rows, title);
    await downloadBytes(`法拍汇总-排版-${stamp}.pdf`, pdf.bytes, 'application/pdf');
    const kept = Object.values(data.groups).reduce((a, b) => a + b, 0);
    await logEvent('info', '导出排版 xlsx+PDF', `${kept} 行 / ${pdf.pages} 页（${label}），丢弃空名 ${data.dropped}`,
      { 分组: data.groups, 丢弃: data.dropped, 页数: pdf.pages, 范围: label });
    setStatus(`${label}：已导出 xlsx + PDF（${pdf.pages} 页）。共 ${kept} 行，丢弃空小区名 ${data.dropped} 行。`, 'success');
  } catch (error) {
    await logEvent('error', '排版导出失败', error.message || String(error));
    setStatus(`排版导出失败：${describeMessageError(error)}`, 'error');
  }
}

function syncCaptureTask(task) {
  const wasActive = !!captureTask?.active;
  captureTask = task;
  if (task?.active) {
    setProgress((task.done || 0) + (task.failed || 0), task.total || 0, (task.current || '').slice(0, 60));
  } else if (wasActive && task?.finished_at) {
    setProgress(task.total || 0, task.total || 0, '完成');
    setTimeout(hideProgress, 2000);
    setStatus(
      `采集完成：入池 ${task.done || 0} 条${task.failed ? `，失败 ${task.failed} 条` : ''}${task.skipped ? `，跳过 ${task.skipped} 个非详情页` : ''}。点「重试所有未解析」即可批量出表。`,
      task.failed ? '' : 'success',
    );
  }
  renderTable();
}

// ------------------------------------------------------------
// 编辑器
// ------------------------------------------------------------
function openEditor(id) {
  const item = pool.items.find(entry => entry.id === id);
  if (!item) return;
  editingId = id;
  editingSnapshot = JSON.parse(JSON.stringify(item.record || {}));
  const fields = $('editorFields');
  fields.textContent = '';
  const record = item.record || emptyRecord();
  for (const [key, label] of OUTPUT_FIELDS) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    const isFormula = FORMULA_KEYS.includes(key);
    span.textContent = isFormula ? `${label}（公式列 · 留空）` : label;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.key = key;
    if (isFormula) {
      // 总表用 MAP 公式算这 4 列，编辑框置空且只读，避免手工写入覆盖表内公式
      input.value = '';
      input.disabled = true;
      input.placeholder = '由总表公式计算';
      input.title = '该列由总表 MAP 公式自动计算，插件输出留空';
    } else {
      input.value = displayValue(key, record[key]);
    }
    wrap.append(span, input);
    fields.appendChild(wrap);
  }
  $('editorTitle').textContent = item.source?.title || '未命名标的';
  $('editorUrl').textContent = item.source?.url || '';
  $('editorNote').value = item.note || '';
  const notes = [
    ...(item.warnings || []).map(x => `采集警告：${x}`),
    ...((item.extraction?.warnings || []).map(x => `模型提示：${x}`)),
    ...(item.extraction?.error ? [`解析失败：${item.extraction.error}`] : []),
  ];
  $('editorWarnings').hidden = notes.length === 0;
  $('editorWarnings').textContent = notes.join('\n');
  $('editorHint').textContent = `采集时间 ${fmtTime(item.added_at)}${item.extraction?.model ? `｜模型 ${item.extraction.model}` : ''}`;
  $('editor').showModal();
}

async function saveEditor() {
  if (!editingId) return;
  const record = {};
  for (const input of $('editorFields').querySelectorAll('input')) {
    const key = input.dataset.key;
    let value = parseEditedValue(key, input.value.trim());
    if (SLASH_TEXT_KEYS.includes(key) && !value) value = '/';
    record[key] = value;
  }
  await poolUpdateEntry(editingId, { record, note: $('editorNote').value, status: 'parsed' });
  await logEvent('info', '保存手工修改', String($('editorTitle').textContent || '').slice(0, 40));
  $('editor').close();
  editingId = null;
  await reload();
  setStatus('修改已保存。导出时会用改后的值。', 'success');
}

function revertEditor() {
  if (!editingSnapshot) return;
  for (const input of $('editorFields').querySelectorAll('input')) {
    const key = input.dataset.key;
    input.value = displayValue(key, editingSnapshot[key]);
  }
  $('editorHint').textContent = '已还原为本次打开时的值，点「保存修改」才生效。';
}

// ------------------------------------------------------------
// 事件绑定
// ------------------------------------------------------------
$('poolTable').addEventListener('click', async (event) => {
  const tr = event.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (event.target.matches('input[data-action="select"]')) {
    if (event.target.checked) selected.add(id); else selected.delete(id);
    renderTable();
    return;
  }
  const action = event.target.closest('button[data-action]')?.dataset.action;
  if (action === 'edit') { openEditor(id); return; }
  if (action === 'open') {
    const item = pool.items.find(entry => entry.id === id);
    if (item?.source?.url) chrome.tabs.create({ url: item.source.url });
    return;
  }
  if (action === 'del') {
    await poolRemoveEntries([id]);
    selected.delete(id);
    await reload();
    await logEvent('info', '删除条目', '1 条');
    setStatus('已从采集池移除 1 条。', 'success');
  }
});

$('headCheck').addEventListener('change', (event) => {
  selected.clear();
  if (event.target.checked) for (const item of pool.items) selected.add(item.id);
  renderTable();
});

$('selectAll').addEventListener('click', () => { for (const item of pool.items) selected.add(item.id); renderTable(); });
$('selectNone').addEventListener('click', () => { selected.clear(); renderTable(); });
$('selectInvert').addEventListener('click', () => {
  const next = new Set();
  for (const item of pool.items) if (!selected.has(item.id)) next.add(item.id);
  selected.clear();
  for (const id of next) selected.add(id);
  renderTable();
});

$('parseSelected').addEventListener('click', () => {
  const items = pool.items.filter(item => selected.has(item.id));
  if (!items.length) {
    setStatus('请先勾选要解析的条目，或直接点「重试所有未解析」把整池没解析的一次跑完。', 'error');
    return;
  }
  startParse(items, '解析选中');
});
// 唯一的批量解析入口：待解析 + 解析失败一起重跑，不看选中状态。
// 目标集合与按钮可用性共用 unparsedTargets()，不会出现「亮着却 0 条」。
$('retryUnparsed').addEventListener('click', () => {
  const targets = unparsedTargets(pool.items);
  if (!targets.length) {
    setStatus('池里已经没有未解析的条目了：要么全部解析完成，要么这些条目没留下页面证据。', 'error');
    return;
  }
  const pending = targets.filter(item => item.status === 'raw').length;
  const errored = targets.filter(item => item.status === 'error').length;
  setStatus(`正在提交 ${targets.length} 条（待解析 ${pending} + 解析失败 ${errored}）…`);
  startParse(targets, '重试所有未解析');
});
$('stopParse').addEventListener('click', stopParse);

$('exportSelected').addEventListener('click', () => exportCsv([...selected], '选中的'));
$('exportAll').addEventListener('click', () => exportCsv(null, '采集池全部'));

$('deleteSelected').addEventListener('click', async () => {
  if (!selected.size) return;
  const count = selected.size;
  await poolRemoveEntries([...selected]);
  selected.clear();
  await reload();
  await logEvent('info', '删除条目', `${count} 条`);
  setStatus(`已删除 ${count} 条。`, 'success');
});

$('clearAll').addEventListener('click', async () => {
  if (!pool.items.length) return;
  if (!confirm(`确定清空采集池里的 ${pool.items.length} 条记录？此操作不可撤销，建议先「一次导出全部 CSV」留档。`)) return;
  await poolClear();
  selected.clear();
  await reload();
  await logEvent('warn', '清空采集池', '全部条目已清空');
  setStatus('采集池已清空。', 'success');
});

$('editorClose').addEventListener('click', () => { $('editor').close(); editingId = null; });
$('editorSave').addEventListener('click', saveEditor);
$('editorRevert').addEventListener('click', revertEditor);

// 与弹窗/后台保持同步
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[POOL_STORAGE_KEY]) {
    pool = changes[POOL_STORAGE_KEY].newValue || poolEmpty();
    renderStats();
    renderTable();
  }
  if (changes.parseTask) syncParseTask(changes.parseTask.newValue);
  if (changes.captureTask) syncCaptureTask(changes.captureTask.newValue);
});

chrome.storage.local.get({ parseTask: null, captureTask: null }).then(({ parseTask: task, captureTask: capture }) => {
  if (capture?.active) syncCaptureTask(capture);
  syncParseTask(task);
  if (!task?.active && !capture?.active) {
    setStatus('就绪。到法拍详情页用扩展弹窗「采集到池」，或在列表页用弹窗里的「按最新发布选截止位」一次采多条。');
  }
});

checkBackground();
reload().catch(error => setStatus(`读取采集池失败：${error.message}`, 'error'));
