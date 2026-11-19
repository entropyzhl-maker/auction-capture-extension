let currentTab = null;
let currentPackage = null;
let pool = poolEmpty();
let parseTask = null;
let captureTask = null;      // 后台采集任务（单页 / 截止点批量）的快照，来自 storage
let editingId = null;
let sortItems = [];
let watermark = { version: 1, lanes: {} };
let wsPlan = null;           // 当前水位计划（读列表后算出来）

const $ = (id) => document.getElementById(id);
const MAX_LIST_ROWS = 8;

function setStatus(message, type = '') {
  $('status').textContent = message;
  $('status').className = `status ${type}`.trim();
}

// 当前通道：平台|类型
function currentLane() {
  const platform = identifyPlatform(currentTab?.url);
  if (platform !== 'ali' && platform !== 'jd') return null;
  const typeHint = ($('laneType')?.value || '').trim() || null;
  return watermarkLaneFromUrl(currentTab?.url, platform, typeHint);
}

function refreshWatermarkInfo() {
  const lane = currentLane();
  const info = $('watermarkInfo');
  const wsBtn = $('wsRunButton');
  const clrBtn = $('wsClearButton');
  if (!lane) {
    info.textContent = '水位：当前页不是阿里/京东列表页';
    wsBtn.hidden = true;
    clrBtn.hidden = true;
    return;
  }
  const rec = watermark?.lanes?.[lane] || null;
  if (!rec) {
    info.textContent = `水位[${lane}]：未记录（下次首采前 20 条）`;
    clrBtn.hidden = true;
  } else {
    const when = rec.at ? logStamp(rec.at) : '—';
    info.textContent = `水位[${lane}]：${rec.anchor_title || rec.anchor_id}（${when} 记录，累计 ${rec.total || 0} 条）`;
    clrBtn.hidden = false;
  }
  // 有列表数据才能跑增量
  wsBtn.hidden = !sortItems.length;
  wsBtn.disabled = !sortItems.length || !$('latestSortConfirmed').checked
    || !!parseTask?.active || !!captureTask?.active;
}

function updatePageCard(tab) {
  const platform = identifyPlatform(tab.url);
  $('platformMark').textContent = platformLabel(platform);
  $('pageTitle').textContent = tab.title || '未命名页面';
  $('pageUrl').textContent = tab.url;
}

function refreshSortCard() {
  const platform = identifyPlatform(currentTab?.url);
  const card = $('sortCard');
  const eligible = platform === 'jd' || platform === 'ali';
  card.hidden = !eligible;
  if (!eligible) return;
  const select = $('sortCutoff');
  const cutoff = Number(select.value || 0);
  $('sortPreview').textContent = sortItems.length
    ? `当前页共 ${sortItems.length} 条；将只把前 ${cutoff + 1} 条采集进池（含所选截止项），解析留给你在采集池里手动点。`
    : '先点击“读取当前列表顺序”。';
  $('sortRunButton').textContent = '采集截止项及之前（仅入池）';
  $('sortRunButton').hidden = !sortItems.length;
  $('sortRunButton').disabled = !sortItems.length || !$('latestSortConfirmed').checked
    || cutoff < 0 || !!parseTask?.active || !!captureTask?.active;
  refreshWatermarkInfo();
}

async function readSortList() {
  if (!currentTab?.id) return;
  $('readSortButton').disabled = true;
  if (!$('latestSortConfirmed').checked) {
    setStatus('请先在网页上选择“最新发布”排序并勾选确认。', 'error');
    $('readSortButton').disabled = false;
    return;
  }
  setStatus('正在读取当前列表的排序顺序…');
  try {
    const platform = identifyPlatform(currentTab.url);
    // v0.5.9：先等列表「长停」再读。骨架屏/懒加载没渲染完就读，条数会偏少，
    // rank 跟着整体前移，截止点就选歪了。
    let loadInfo = null;
    try {
      const waitRun = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: waitForAuctionListStable,
        args: [platform],
      });
      loadInfo = waitRun?.[0]?.result || null;
    } catch { loadInfo = null; }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: readAuctionList,
      args: [platform],
    });
    if (result?.blocked) throw new Error(result.gate
      ? '当前是淘宝登录/风控页，不是列表页：先把淘宝登录好，再打开筛选好的法拍列表页。'
      : '页面处于验证码/滑块验证状态，不能读取排序列表。');
    if (!result?.items?.length) throw new Error('当前页没有识别到可采集的法拍标的，请先切到列表页并选择“最新发布”。');
    sortItems = result.items;

    // 读一次水位，算增量计划
    try { watermark = await watermarkLoad(); } catch { watermark = { version: 1, lanes: {} }; }
    const lane = currentLane();
    wsPlan = lane ? watermarkPlan(sortItems, lane, watermark, 20) : null;

    const select = $('sortCutoff');
    select.textContent = '';
    for (const item of sortItems) {
      const option = document.createElement('option');
      option.value = String(item.rank - 1);
      option.textContent = `${item.rank}. ${item.title || item.id}`;
      select.appendChild(option);
    }
    // 有水位就默认选到水位前一位，让「截止点采集」也跟水位对齐
    if (wsPlan && wsPlan.anchorIndex > 0) select.value = String(wsPlan.anchorIndex - 1);

    $('sortCutoffWrap').hidden = false;
    refreshSortCard();

    // 增量计划写进预览，让人一眼看到「这次会采几条、为什么」
    if (wsPlan) {
      const extra = wsPlan.mode === 'no-new'
        ? '（没有新标的，可跳过）'
        : wsPlan.mode === 'first-run'
          ? '（该通道首次采集）'
          : wsPlan.mode === 'anchor-gone'
            ? '（⚠ 水位那条已不在首页，可能漏采）'
            : '';
      $('watermarkInfo').textContent =
        `水位[${lane}]：${wsPlan.reason}；本次将采 ${wsPlan.picks.length} 条 ${extra}`.trim();
    }

    // 没等到稳定就说明列表可能只渲染了一半：条数和 rank 都不可信，必须让人知道。
    const unstable = loadInfo && loadInfo.stable === false;
    if (unstable) {
      setStatus(`列表可能还在加载：只读到 ${sortItems.length} 条（${Math.round(loadInfo.waited / 100) / 10}s 内条数一直在变）。`
        + '把列表滚到底、等它加载完，再点一次「读取当前列表顺序」。', 'error');
    } else {
      setStatus(`已读取 ${sortItems.length} 条当前页排序。请选择截止项后执行。`, 'success');
    }
  } catch (error) {
    setStatus(`读取排序失败：${error.message}`, 'error');
  } finally {
    $('readSortButton').disabled = false;
  }
}

// 「截止点采集」：和「采集到池」并列的入口。
// 点它 = 把排序卡片亮出来 + 自动读一次当前列表顺序，然后把截止项交给你选；
// 不在这里直接开跑，避免一不小心把整页 40 条全采进池。
async function focusCutoffCapture() {
  const platform = identifyPlatform(currentTab?.url);
  if (platform === 'blocked') {
    setStatus('当前页面是淘宝登录/风控页（常见于登录态过期或被风控），先登录好再回法拍列表页。', 'error');
    return;
  }
  if (platform !== 'jd' && platform !== 'ali') {
    setStatus('「截止点采集」只在阿里拍卖 / 京东拍卖的列表页可用：先打开筛选好的列表页再点。', 'error');
    return;
  }
  const card = $('sortCard');
  card.hidden = false;
  try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* 老浏览器忽略 */ }

  if (!$('latestSortConfirmed').checked) {
    setStatus('先在网页上把排序切到「最新发布」，勾选卡片里的确认项，再点「截止点采集」。', 'error');
    return;
  }
  if (!sortItems.length) {
    await readSortList();
    if (!sortItems.length) return;
  } else {
    $('sortCutoffWrap').hidden = false;
    $('sortCutoff').focus();
  }
  refreshSortCard();
  setStatus(`当前页已读取 ${sortItems.length} 条；选好截止项后点「采集截止项及之前」。`, 'success');
}

async function runSortBatch() {
  const cutoff = Number($('sortCutoff').value);
  const urls = sortItems.slice(0, cutoff + 1).map(item => item.url);
  if (!urls.length) return;
  // 只入池：不再校验模型 API、也不申请模型域权限。
  // 解析一律由你在采集池里点「重试所有未解析」手动触发。
  const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  if (!granted) {
    setStatus('未授予网页访问权限，已取消。', 'error');
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SORT_BATCH', urls });
    if (!response?.ok) {
      setStatus(`排序批量任务未启动：${response?.error || response?.reason || '未知原因'}`, 'error');
      return;
    }
    setStatus(`已开始处理前 ${urls.length} 条；只采集入池，采完不会解析，可关闭弹窗。`, 'success');
    captureTask = { active: true, total: urls.length, done: 0, failed: 0, skipped: 0 };
    renderPool();
    refreshSortCard();
  } catch (error) {
    setStatus(`排序批量任务失败：${describeMessageError(error)}`, 'error');
    await checkBackground();
  }
}

// ------------------------------------------------------------
// 水位增量采集
//   水位 = 上次采到的最新那条（列表最上面），下次只采比它更新的。
//   四路各自独立：阿里|住宅 / 阿里|商业 / 京东|住宅 / 京东|商业
// ------------------------------------------------------------
async function runWatermarkBatch() {
  const lane = currentLane();
  if (!lane) {
    setStatus('当前页不是阿里/京东列表页，无法按水位采集。', 'error');
    return;
  }
  if (!sortItems.length) {
    await readSortList();
    if (!sortItems.length) return;
  }
  if (!$('latestSortConfirmed').checked) {
    setStatus('请先确认网页上已切到「最新发布」排序。', 'error');
    return;
  }
  try { watermark = await watermarkLoad(); } catch { /* 保持旧值 */ }
  wsPlan = watermarkPlan(sortItems, lane, watermark, 20);
  const picked = wsPlan.picks;

  if (!picked.length) {
    setStatus(`水位[${lane}]：${wsPlan.reason}，本次无需采集。`, 'success');
    refreshWatermarkInfo();
    return;
  }

  const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  if (!granted) {
    setStatus('未授予网页访问权限，已取消。', 'error');
    return;
  }
  const urls = picked.map(item => item.url);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SORT_BATCH', urls });
    if (!response?.ok) {
      setStatus(`水位采集未启动：${response?.error || response?.reason || '未知原因'}`, 'error');
      return;
    }
    await watermarkCommit(lane, sortItems, picked);
    watermark = await watermarkLoad();
    await logEvent('info', '水位增量采集',
      `${lane} 采 ${urls.length} 条（${wsPlan.mode}）`,
      { 通道: lane, 条数: urls.length, 模式: wsPlan.mode, 水位锚点: picked[0]?.id || '' });

    setStatus(`水位[${lane}]：已提交 ${urls.length} 条（${wsPlan.reason}）。只入池不解析。`, 'success');
    captureTask = { active: true, total: urls.length, done: 0, failed: 0, skipped: 0 };
    renderPool();
    refreshSortCard();
  } catch (error) {
    setStatus(`水位采集失败：${describeMessageError(error)}`, 'error');
    await checkBackground();
  }
}

async function clearWatermark() {
  const lane = currentLane();
  if (!lane) return;
  await watermarkClear(lane);
  watermark = await watermarkLoad();
  await logEvent('info', '清空水位', lane, { 通道: lane });
  wsPlan = sortItems.length ? watermarkPlan(sortItems, lane, watermark, 20) : null;
  setStatus(`已清空水位[${lane}]，下次按首次采集处理。`, 'success');
  refreshSortCard();
}

// ------------------------------------------------------------
// 水位导入 / 导出
// 换扩展 ID（改了「已解压扩展」的目录路径就会换 ID）之后，旧 storage 读不到，
// 界面会显示「水位：未记录」。这里给一条手动的出口：先把旧的导出来，再导回去。
// ------------------------------------------------------------
async function exportWatermarks() {
  try {
    const wm = await watermarkExportPayload();
    const lanes = Object.keys(wm.lanes || {});
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await downloadFile(
      `法拍水位_${stamp}.json`,
      JSON.stringify(wm, null, 2),
      'application/json;charset=utf-8',
    );
    await logEvent('info', '导出水位', `${lanes.length} 个通道`, { 通道: lanes.join(',') });
    setStatus(lanes.length
      ? `已导出 ${lanes.length} 个通道的水位（${lanes.join(' / ')}）。换扩展 ID 后可用「导入水位」恢复。`
      : '当前没有任何水位记录，导出的是一份空文件。', lanes.length ? 'success' : 'error');
  } catch (error) {
    setStatus(`导出水位失败：${describeMessageError(error)}`, 'error');
  }
}

async function importWatermarksFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const result = await watermarkImport(text, { merge: true });
    if (!result.ok) {
      setStatus(`导入失败：${result.error}`, 'error');
      return;
    }
    watermark = await watermarkLoad();
    const lane = currentLane();
    wsPlan = lane && sortItems.length ? watermarkPlan(sortItems, lane, watermark, 20) : null;
    await logEvent('info', '导入水位', `${result.lanes.length} 个通道（${result.mode}）`, {
      通道: result.lanes.join(','), 来源: file.name,
    });
    setStatus(`已导入 ${result.lanes.length} 个通道的水位（${result.lanes.join(' / ')}）。`, 'success');
    refreshSortCard();
  } catch (error) {
    setStatus(`导入水位失败：${describeMessageError(error)}`, 'error');
  }
}

// ------------------------------------------------------------
// 采集池渲染
// ------------------------------------------------------------
function entryLabel(item) {
  const community = item.record?.community;
  if (community && community !== '/') return community;
  return (item.source?.title || item.source?.url || '未命名').slice(0, 48);
}

function renderPool() {
  const stats = poolStats(pool);
  const badge = $('poolBadge');
  badge.textContent = `${stats.total} 条`;
  // 配色一律交给 popup.css 的 .badge（黑白灰主题），
  // 这里只管「有没有待解析的」这一个状态位。
  badge.classList.toggle('badge-accent', Boolean(stats.raw));

  if (!stats.total) {
    $('poolSummary').textContent = '逐页点「采集到池」，攒够了一次解析、一次导出。';
  } else {
    const bits = [`共 ${stats.total} 条`];
    if (stats.raw) bits.push(`待解析 ${stats.raw}`);
    if (stats.parsedRecords) bits.push(`可导出 ${stats.parsedRecords}`);
    if (stats.error) bits.push(`失败 ${stats.error}`);
    $('poolSummary').textContent = `${bits.join(' · ')}`;
  }

  const list = $('poolList');
  list.textContent = '';
  for (const item of pool.items.slice(0, MAX_LIST_ROWS)) {
    const li = document.createElement('li');
    li.className = `pool-item status-${item.status}`;

    const name = document.createElement('span');
    name.className = 'pool-name';
    name.textContent = entryLabel(item);
    name.title = `${item.source?.url || ''}\n点一下可改字段`;

    const tag = document.createElement('span');
    tag.className = `pool-tag tag-${item.status}`;
    tag.textContent = POOL_STATUS_LABEL[item.status] || item.status;
    if (item.status === 'error' && item.extraction?.error) tag.title = item.extraction.error;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pool-del';
    del.textContent = '×';
    del.title = '从池中移除';

    name.addEventListener('click', () => openEditor(item.id));
    tag.addEventListener('click', () => openEditor(item.id));
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      await poolRemoveEntries([item.id]);
      await refreshPool();
      setStatus('已移除 1 条。');
    });

    li.append(name, tag, del);
    list.appendChild(li);
  }
  if (pool.items.length > MAX_LIST_ROWS) {
    const more = document.createElement('li');
    more.className = 'pool-more';
    more.textContent = `还有 ${pool.items.length - MAX_LIST_ROWS} 条，点下方「展开管理」查看全部`;
    list.appendChild(more);
  }

  const parsing = !!parseTask?.active;
  const capturing = !!captureTask?.active;
  $('parseButton').disabled = parsing || capturing || !stats.total;
  $('parseButton').textContent = stats.raw ? `解析字段（${stats.raw}）` : '解析字段';
  $('exportButton').disabled = !stats.parsedRecords;
  $('stopButton').hidden = !parsing;
  $('captureButton').disabled = parsing || capturing || !currentTab?.url || !/^https?:/i.test(currentTab.url);
}

function renderParseProgress() {
  const task = parseTask;
  const active = !!task?.active;
  // 解析结束后不再让进度条留在界面上（以前会自动铺满 100% 停在那儿）。
  // 完成信息改由状态栏那句「解析完成：…」承担，这里只显示运行中的进度。
  $('parseProgress').hidden = !active;
  if (!active) return;
  const finished = task.done + task.failed;
  $('progressBar').style.width = `${task.total ? Math.round(finished / task.total * 100) : 0}%`;
  $('progressText').textContent = `${finished}/${task.total}　${(task.current || '').slice(0, 24)}`;
}

async function refreshPool() {
  pool = await poolLoad();
  renderPool();
}

async function refreshParseTask() {
  const { parseTask: task } = await chrome.storage.local.get({ parseTask: null });
  parseTask = task;
  renderParseProgress();
  renderPool();
}

// ------------------------------------------------------------
// 采集池渲染
// ------------------------------------------------------------

// 采集任务快照：进度/完成状态来自 storage，界面只负责显示
async function refreshCaptureTask() {
  const { captureTask: task } = await chrome.storage.local.get({ captureTask: null });
  captureTask = task;
  renderPool();
}

// ------------------------------------------------------------
// 后台握手：识破「浏览器还在跑缓存的旧后台脚本」
// 见 common.js 第 1.5 节。命中时给出照着做就能好的中文步骤，
// 而不是把 "Uncaught ReferenceError: runParseTask is not defined" 直接丢出来。
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

// ------------------------------------------------------------
// 三步主流程：采集到池 → 解析字段 → 一次导出
//
// v0.6.2：单页采集不再在 popup 里直接 executeScript(collectPageEvidence)。
// 那条老路一点等待都没有，用户刚点进详情页就按采集，价格/公告区（XHR 后补）
// 还在路上就抓了 —— 就是「老是没出完就采集」的根因。
// 现在统一发 CAPTURE_ONE 给后台，走 waitForAuctionReady（关键字段出齐 +
// 内容指纹静默）等数据真正出完再采；进度与结果都由 captureTask 回传。
// ------------------------------------------------------------
async function captureToPool() {
  if (!currentTab?.id) return;
  if (captureTask?.active || parseTask?.active) {
    setStatus('正在采集/解析，等它跑完再单页采集（两边同时写采集池会互相覆盖）。', 'error');
    return;
  }
  $('captureButton').disabled = true;
  setStatus('正在等待页面数据出完（价格 / 面积 / 公告区）…');
  try {
    // 申请网页权限（批量入口同款）：没有 optional_host_permissions 时
    // chrome.scripting.executeScript 注入会失败。
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
    if (!granted) {
      setStatus('未授予网页访问权限，已取消。', 'error');
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_ONE', tabId: currentTab.id });
    if (!response?.ok) {
      setStatus(`单页采集未启动：${response?.error || response?.reason || '未知原因'}`, 'error');
      return;
    }
    // 立刻占位，避免连点；真实进度由 storage 的 captureTask 变化回调刷新。
    captureTask = { active: true, total: 1, done: 0, failed: 0 };
    renderPool();
    setStatus('正在等数据出完并采集入池，可关闭弹窗，任务会在后台跑完。', 'success');
  } catch (error) {
    setStatus(`单页采集失败：${describeMessageError(error)}`, 'error');
    await checkBackground();
  } finally {
    $('captureButton').disabled = !!parseTask?.active || !!captureTask?.active;
  }
}

async function parsePool() {
  const settings = await loadModelSettings();
  if (!settings.apiEndpoint) {
    setStatus('插件内置的模型地址为空，请重新加载扩展（edge://extensions）后再试。', 'error');
    return;
  }
  const granted = await chrome.permissions.request({ origins: [endpointOriginPattern(normalizeEndpoint(settings.apiEndpoint))] });
  if (!granted) {
    setStatus('未授予模型 API 的访问权限，已取消。', 'error');
    return;
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'PARSE_POOL' });
  } catch (error) {
    setStatus(`无法启动解析任务：${describeMessageError(error)}`, 'error');
    await checkBackground();
    return;
  }
  if (!response?.ok) {
    const reason = response?.reason;
    if (reason === 'nothing-to-parse') setStatus('池里没有待解析的条目。', 'error');
    else if (reason === 'no-endpoint') setStatus('还没配置模型 API。', 'error');
    else if (reason === 'already-running') setStatus('已有一个解析任务在跑。', 'error');
    else if (reason === 'capture-running') setStatus('正在批量采集页面，等它跑完再解析。', 'error');
    else if (reason === 'stale-worker') { setStatus(`启动失败：${response?.error || ''}`, 'error'); await checkBackground(); }
    else setStatus(`启动失败：${response?.error || reason || '未知原因'}`, 'error');
    return;
  }
  parseTask = { active: true, total: response.total, done: 0, failed: 0, current: '' };
  renderParseProgress();
  renderPool();
  setStatus(`开始解析 ${response.total} 条。可以关掉这个窗口，任务会在后台继续，图标上会显示进度。`, 'success');
}

async function stopParse() {
  await chrome.runtime.sendMessage({ type: 'STOP_PARSE' });
  setStatus('已请求停止，正在结束当前这一条…');
}

async function exportPool() {
  const records = poolRecords(pool);
  if (!records.length) {
    setStatus('池里还没有已解析的记录。先点「解析字段」。', 'error');
    return;
  }
  const stamp = todaySlashDate().replace(/\//g, '-');

  // 只出两份：16 列排版版 xlsx + PDF —— 100% 扩展内置引擎，无 Python/无本地路径
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
    const pdfKind = pdf.mode === 'vector' ? '矢量' : '位图回退';
    await logEvent('info', '导出排版 xlsx+PDF', `${kept} 行 / ${pdf.pages} 页（${pdfKind}），丢弃空名 ${data.dropped}`,
      { 分组: data.groups, 丢弃: data.dropped, 页数: pdf.pages, pdf模式: pdf.mode || '', 回退原因: pdf.fallbackReason || '' });
    setStatus(`已导出两份：①16 列排版 xlsx；②排版 PDF（${pdf.pages} 页，${pdfKind}，小区名可点）。共 ${kept} 行，丢弃空小区名 ${data.dropped} 行。`, 'success');
  } catch (error) {
    await logEvent('error', '排版导出失败', error.message || String(error));
    setStatus(`排版 xlsx/PDF 生成失败：${describeMessageError(error)}`, 'error');
  }
}

// 操作日志出口：与 20 列 CSV 完全独立。记录采集/解析/失败/导出的时间线，
// 失败原因在日志里是完整序列（池里每条只留最后一次）。
async function exportLog() {
  const { entries } = await logLoad();
  if (!entries.length) {
    setStatus('还没有日志。采集、解析、导出都会自动记一条。', 'error');
    return;
  }
  const stamp = todaySlashDate().replace(/\//g, '-');
  await downloadFile(`auction-pool/log-${entries.length}条-${stamp}.log`, buildLogText(entries), 'text/plain;charset=utf-8');
  setStatus(`已导出操作日志 ${entries.length} 条（含每条失败原因）。`, 'success');
}

// ------------------------------------------------------------
// 池内编辑（不跳页）
// ------------------------------------------------------------
function openEditor(id) {
  const item = pool.items.find(entry => entry.id === id);
  if (!item) return;
  editingId = id;
  const record = item.record || emptyRecord();
  const fields = $('editFields');
  fields.textContent = '';
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
  $('editTitle').textContent = item.source?.title || '未命名标的';
  $('editUrl').textContent = item.source?.url || '';
  $('editHint').textContent = item.status === 'raw'
    ? '这条还没解析，可以直接手工填写。'
    : (item.extraction?.model ? `模型 ${item.extraction.model}` : '');
  const notes = [
    ...(item.warnings || []).map(x => `采集警告：${x}`),
    ...((item.extraction?.warnings || []).map(x => `模型提示：${x}`)),
    ...(item.extraction?.error ? [`解析失败：${item.extraction.error}`] : []),
  ];
  $('editWarnings').hidden = notes.length === 0;
  $('editWarnings').textContent = notes.join('\n');
  $('editPanel').hidden = false;
  document.body.classList.add('editing');
}

async function saveEditor() {
  if (!editingId) return;
  const record = {};
  for (const input of $('editFields').querySelectorAll('input')) {
    const key = input.dataset.key;
    let value = parseEditedValue(key, input.value.trim());
    if (SLASH_TEXT_KEYS.includes(key) && !value) value = '/';
    record[key] = value;
  }
  await poolUpdateEntry(editingId, { record, status: 'parsed' });
  await logEvent('info', '保存手工修改', String($('editTitle').textContent || '').slice(0, 40));
  closeEditor();
  await refreshPool();
  setStatus('已保存，导出时会用修改后的值。', 'success');
}

function closeEditor() {
  editingId = null;
  $('editPanel').hidden = true;
  document.body.classList.remove('editing');
}

// ------------------------------------------------------------
// 初始化与事件
// ------------------------------------------------------------
async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refreshPool();
  await refreshParseTask();
  await refreshCaptureTask();
  await checkBackground();
  try { watermark = await watermarkLoad(); } catch { watermark = { version: 1, lanes: {} }; }
  refreshSortCard();

  if (!currentTab?.url || !/^https?:/i.test(currentTab.url)) {
    $('captureButton').disabled = true;
    setStatus('当前标签不是普通网页，采不了；请切到具体的法拍标的详情页再点「采集到池」。', 'error');
    return;
  }
  updatePageCard(currentTab);
  if (parseTask?.active) {
    setStatus(`解析中（${parseTask.done + parseTask.failed}/${parseTask.total}），可以关掉这个窗口。`);
  } else if (captureTask?.active) {
    // 把当前并发显示出来：被降级时（concurrency_now < concurrency）一眼能看见。
    const cc = captureTask.concurrency_now || captureTask.concurrency || 0;
    const downgraded = captureTask.concurrency && cc < captureTask.concurrency
      ? `，并发已降到 ${cc}` : '';
    setStatus(`采集中（${(captureTask.done || 0) + (captureTask.failed || 0)}/${captureTask.total}，${cc} 并发${downgraded}），关掉弹窗也会跑完。`);
  } else if (poolStats(pool).total) {
    setStatus('点「采集到池」收当前页；要一次收一批就回列表页用「截止点采集」。');
  } else {
    setStatus('点「采集到池」收当前页；列表页多选就用「截止点采集」一次入池。');
  }
}

$('captureButton').addEventListener('click', captureToPool);
$('cutoffButton').addEventListener('click', focusCutoffCapture);
$('readSortButton').addEventListener('click', readSortList);
$('sortCutoff').addEventListener('change', refreshSortCard);
$('latestSortConfirmed').addEventListener('change', refreshSortCard);
$('sortRunButton').addEventListener('click', runSortBatch);
$('wsRunButton').addEventListener('click', runWatermarkBatch);
$('wsClearButton').addEventListener('click', clearWatermark);
$('wsExportButton').addEventListener('click', exportWatermarks);
$('wsImportButton').addEventListener('click', () => $('wsImportFile').click());
$('wsImportFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';       // 允许连续导入同一个文件
  await importWatermarksFromFile(file);
});
$('laneType').addEventListener('change', () => {
  // 切通道后重算计划
  if (sortItems.length) {
    const lane = currentLane();
    wsPlan = lane ? watermarkPlan(sortItems, lane, watermark, 20) : null;
  }
  refreshSortCard();
});
$('parseButton').addEventListener('click', parsePool);
$('stopButton').addEventListener('click', stopParse);
$('exportButton').addEventListener('click', exportPool);
$('logButton').addEventListener('click', exportLog);
$('manageButton').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('pool.html') }));
$('editClose').addEventListener('click', closeEditor);
$('editSave').addEventListener('click', saveEditor);

// 池与解析进度变化时实时刷新（后台在解析时这里会跟着跳）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[POOL_STORAGE_KEY]) {
    pool = changes[POOL_STORAGE_KEY].newValue || poolEmpty();
    renderPool();
  }
  if (changes.parseTask) {
    const wasActive = !!parseTask?.active;
    parseTask = changes.parseTask.newValue;
    renderParseProgress();
    renderPool();
    if (wasActive && !parseTask?.active) {
      const okCount = parseTask?.done || 0;
      const failCount = parseTask?.failed || 0;
      setStatus(`解析完成：成功 ${okCount} 条${failCount ? `，失败 ${failCount} 条（点条目可见原因）` : ''}。现在点「一次导出 xlsx + PDF」。`, 'success');
    }
  }
  if (changes.captureTask) {
    const wasActive = !!captureTask?.active;
    captureTask = changes.captureTask.newValue;
    renderPool();
    if (wasActive && !captureTask?.active) {
      const okCount = captureTask?.done || 0;
      const failCount = captureTask?.failed || 0;
      const missCount = captureTask?.skipped || 0;
      // v0.5.3：连续失败会熔断，这里把中止原因直接摆出来，
      // 否则用户只看到「入池 0 条」，还得自己翻日志才知道为什么停。
      const stopReason = captureTask?.error ? ` 中止原因：${captureTask.error}` : '';
      setStatus(
        `采集完成：入池 ${okCount} 条${failCount ? `，失败 ${failCount} 条` : ''}${missCount ? `，跳过 ${missCount} 个非详情页` : ''}。`
        + stopReason
        + (okCount ? '可以点「解析字段」了。' : ''),
        failCount || stopReason ? 'error' : 'success',
      );
    }
  }
});

init().catch(error => setStatus(`初始化失败：${error.message}`, 'error'));
