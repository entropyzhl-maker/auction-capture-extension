/* report-pdf.js —— 矢量表格 PDF 排版引擎（文字型，非图片）
 *
 * 为什么重写：
 *   旧实现 drawPage() 把表格画在 1600x1130 的 canvas 上，再 toDataURL('image/jpeg', .92)
 *   包进 PDF。等于「整页一张 200dpi 的 JPEG」：页面上放大到 300dpi 打印就是糊的，
 *   文字边缘全带 JPEG 色块；而且选中/搜索不到字。WPS 导出的 PDF 是同版式的**矢量文字 + 真字体嵌入**，
 *   所以清晰。
 *
 * 现在这条路：
 *   · 文字走 Type0/Identity-H + 子集化嵌入的微软雅黑（pdf-font.js）
 *   · 线/底色走 PDF 原生路径（pdf-writer.js）
 *   · 列宽/字号/换行按**真实字形宽度**测量后自适应，不再靠「字符数 / 13」猜
 *
 * 对外（在 report-export.js 里被调用，也可单独用）：
 *   ReportPdf.build(rows, title, { fontUrlRegular, fontUrlBold }) -> Promise<{bytes, pages}>
 *   ReportPdf.buildLayout(rows, title) -> 纯布局对象（可单测，不碰 DOM/PDF）
 *
 * 行序列约定与 report-export.js 一致：
 *   { kind:'title', text }
 *   { kind:'dist',  text }
 *   { kind:'head',  cells }
 *   { kind:'data',  cells, link }
 */
(function (global) {
  'use strict';

  // ---------------- 版面常量（单位 pt，A4 横向） ----------------
  const PAGE_W = 842, PAGE_H = 595;
  const M = { left: 18, right: 18, top: 16, bottom: 16 };
  const TABLE_W = PAGE_W - M.left - M.right;      // 806pt

  const SIZE = {
    title: 15,
    dist: 9.5,
    head: 8.2,
    data: 8.2,
    minData: 6.2,          // 内容过长时允许缩到这个字号
    footer: 7.2,
  };
  const LH = { data: 10.2, head: 9.6 };            // 行内行高
  const PAD_X = 4.2;                                // 单元格左右内边距
  const PAD_Y = 2.6;                                // 单元格上下内边距
  const H = { title: 30, dist: 17, minHead: 17, minData: 14.5 };

  const COLOR = {
    title: [0xC0, 0x00, 0x00],
    distText: [0x1F, 0x38, 0x64],
    distFill: [0xDD, 0xEB, 0xF7],
    headFill: [0x1F, 0x4E, 0x79],
    headText: [0xFF, 0xFF, 0xFF],
    body: [0x00, 0x00, 0x00],
    link: [0x05, 0x63, 0xC1],
    grid: [0x00, 0x00, 0x00],
    footer: [0x88, 0x88, 0x88],
  };

  // 对齐：右对齐的数值列下标（与 HEADERS 一致）
  const RIGHT = new Set([1, 2, 3, 4, 5, 10]);
  // 允许多行折行的列（地址 / 单元楼层 / 装修 / 房屋情况）
  const WRAPPABLE = new Set([0, 6, 7, 8, 9, 11, 14, 15]);

  // ---------------- 文本工具 ----------------
  // 无 measure 时可用的保守估算（CJK 1.0em，ASCII 数字 0.55em），只在测量函数缺失时兜底
  function roughWidth(str, size) {
    let w = 0;
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      if (cp > 0x2E80) w += 1.0;
      else if (cp === 0x20) w += 0.28;
      else if (/[0-9]/.test(ch)) w += 0.56;
      else if (/[A-Z]/.test(ch)) w += 0.66;
      else if (/[a-z]/.test(ch)) w += 0.53;
      else w += 0.42;
    }
    return w * size;
  }

  // 把文本按最大宽度折成若干行；CJK 逐字断，ASCII 尽量按空格/标点断
  function wrapText(text, maxW, sizePt, measure) {
    const s = String(text ?? '');
    if (!s) return [''];
    const m = (t) => (measure ? measure(t, sizePt) : roughWidth(t, sizePt));
    if (m(s) <= maxW) return [s];
    const lines = [];
    let cur = '';
    let lastBreak = -1;              // cur 里最后一个可断位（空格后）
    for (const ch of s) {
      const probe = cur + ch;
      if (m(probe) <= maxW || cur === '') { cur = probe; if (ch === ' ' || /[、，,\/·—]/.test(ch)) lastBreak = cur.length; continue; }
      // 放不下：若存在断点且断点不是开头，就从断点处断开
      if (lastBreak > 0 && lastBreak < cur.length) {
        lines.push(cur.slice(0, lastBreak).trim());
        cur = cur.slice(lastBreak).trimStart() + ch;
      } else {
        lines.push(cur);
        cur = ch;
      }
      lastBreak = -1;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  // 单行塞不下时：先缩字号，缩到底还塞不下就截断加省略号
  function fitOneLine(text, maxW, sizePt, minPt, measure) {
    const s = String(text ?? '');
    const m = (t, sz) => (measure ? measure(t, sz) : roughWidth(t, sz));
    let sz = sizePt;
    while (sz > minPt && m(s, sz) > maxW) sz = +(sz - 0.2).toFixed(2);
    if (m(s, sz) <= maxW) return { text: s, size: sz, lines: 1 };
    // 截断
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (m(s.slice(0, mid) + '…', sz) <= maxW) lo = mid; else hi = mid - 1;
    }
    return { text: lo > 0 ? s.slice(0, lo) + '…' : '', size: sz, lines: 1 };
  }

  // ---------------- 列宽求解 ----------------
  /* 用「每列在所有行里的最宽需求」当权重，再按可用宽度缩放。
   * 关键点：地址列天然很长，若按自然宽度均分，其它列会被压到 4pt 以下；
   * 所以给每列一个「理想宽度」和「最小可容忍宽度」，先保底再分余量。 */
  function solveColumns(rows, measure, availW, measureBold) {
    const nCol = (rows.find(r => r.kind === 'head')?.cells || []).length || 16;
    const mb = measureBold || measure;
    const ideal = new Array(nCol).fill(0);
    const floor = new Array(nCol).fill(0);

    const note = (i, w) => { if (w > ideal[i]) ideal[i] = w; };

    for (const row of rows) {
      if (row.kind === 'head') {
        for (let i = 0; i < nCol; i++) {
          // 表头按「最多折两行」算：取最长那一截的需求宽度（表头是粗体，要用粗体量）
          const parts = String(row.cells[i] ?? '').split('/');
          const w = Math.max(...parts.map(p => mb(p + '/', SIZE.head)));
          note(i, Math.max(w, mb(String(row.cells[i] ?? ''), SIZE.head) * 0.62));
        }
      } else if (row.kind === 'data') {
        for (let i = 0; i < nCol; i++) {
          const t = String(row.cells[i] ?? '');
          const w = measure ? measure(t, SIZE.data) : roughWidth(t, SIZE.data);
          // 可折行列只要「合理一段」就够，不可折行列要全宽
          note(i, WRAPPABLE.has(i) ? Math.min(w, SIZE.data * 11) : w);
        }
      }
    }

    // 最小宽度：表头两行折行后的最窄可行值 + 内边距
    for (let i = 0; i < nCol; i++) floor[i] = Math.max(SIZE.data * 2.4, Math.min(ideal[i], SIZE.data * 3.2));

    const pad = PAD_X * 2;
    const need = ideal.map(w => w + pad);
    const sumNeed = need.reduce((a, b) => a + b, 0);
    let widths;
    if (sumNeed <= availW) {
      // 有余量：按需求等比放大，让表格铺满整页
      const k = availW / sumNeed;
      widths = need.map(w => w * k);
    } else {
      // 不够：先给每列保底，余量按 (need - floor) 的比例分
      const floors = floor.map(w => w + pad);
      const sumFloor = floors.reduce((a, b) => a + b, 0);
      if (sumFloor >= availW) {
        widths = floors.map(w => w * availW / sumFloor);
      } else {
        const extra = availW - sumFloor;
        const wants = need.map((w, i) => Math.max(0, w - floors[i]));
        const sumWant = wants.reduce((a, b) => a + b, 0) || 1;
        widths = floors.map((f, i) => f + extra * wants[i] / sumWant);
      }
    }
    // 取整到 0.1pt，并把误差补到最后一列，保证总宽精确
    widths = widths.map(w => Math.round(w * 10) / 10);
    const diff = Math.round((availW - widths.reduce((a, b) => a + b, 0)) * 10) / 10;
    widths[widths.length - 1] = +(widths[widths.length - 1] + diff).toFixed(1);
    return widths;
  }

  // ---------------- 单元格排版 ----------------
  const MAX_LINES = 3;            // 数据单元格最多 3 行，超出截断

  function layoutCell(text, colW, isHead, measure, measureBold) {
    const inner = colW - PAD_X * 2;
    const base = isHead ? SIZE.head : SIZE.data;
    const m = isHead ? (measureBold || measure) : measure;
    const s = String(text ?? '');
    if (!s) return { lines: [''], size: base };
    const w = m ? m(s, base) : roughWidth(s, base);
    if (w <= inner) return { lines: [s], size: base };

    if (isHead) {
      // 表头：折行（最多 2 行），不缩字号；超了就截断
      const ls = wrapText(s, inner, base, m);
      if (ls.length <= 2) return { lines: ls, size: base };
      const merged = [ls[0], ls.slice(1).join('')];
      return {
        lines: [merged[0], fitOneLine(merged[1], inner, base, base, m).text],
        size: base,
      };
    }

    // 数据：先按基准字号折行（不缩字号，保持印刷体一致）
    let ls = wrapText(s, inner, base, m);
    if (ls.length <= MAX_LINES) {
      // 极短溢出（比如只多出一个「万」）缩一点字号换成单行更好看
      if (ls.length === 2 && m(s, base) <= inner * 1.12) return { lines: [s], size: +(base * 0.94).toFixed(2) };
      return { lines: ls, size: base };
    }
    // 超过 MAX_LINES：缩字号后重新折行
    let sz = +(base - 0.6).toFixed(2);
    while (sz > SIZE.minData) {
      ls = wrapText(s, inner, sz, m);
      if (ls.length <= MAX_LINES) return { lines: ls, size: sz };
      sz = +(sz - 0.4).toFixed(2);
    }
    // 仍放不下：保留前 MAX_LINES-1 行，末行截断
    const head = ls.slice(0, MAX_LINES - 1);
    const tail = fitOneLine(ls.slice(MAX_LINES - 1).join(''), inner, sz, sz, m).text;
    return { lines: [...head, tail], size: sz };
  }

  function rowHeightOf(row, colW, measure, measureBold) {
    if (row.kind === 'title') return H.title;
    if (row.kind === 'dist') return H.dist;
    const isHead = row.kind === 'head';
    let maxLines = 1;
    for (let i = 0; i < row.cells.length; i++) {
      const c = layoutCell(row.cells[i], colW[i] ?? 20, isHead, measure, measureBold);
      if (c.lines.length > maxLines) maxLines = c.lines.length;
    }
    const lh = isHead ? LH.head : LH.data;
    return isHead ? Math.max(H.minHead, maxLines * lh + PAD_Y * 2 + 3)
      : Math.max(H.minData, maxLines * lh + PAD_Y * 2);
  }

  // ---------------- 分页 ─ 含「组不拆头」与续页列头
  /* 规则：
   *  · 标题行只在首页（续页不重复大标题）
   *  · 区名行 + 表头行 必须和**至少一行数据**同页，放不下就整体翻页
   *  · 页尾预留页脚空间
   *  · 数据行跨页时，在续页顶部补一行列头，并在页脚标注「续」 */
  function paginate(rows, heights, colW, measure, measureBold) {
    const bottom = PAGE_H - M.bottom - 12;   // 12 = 页脚预留
    const pages = [];
    let cur = [];
    let y = M.top;
    const fits = h => y + h <= bottom;

    // 找「某个 head 行对应的续页列头高度」
    const headH = (() => {
      const hr = rows.find(r => r.kind === 'head');
      return hr ? rowHeightOf(hr, colW, measure, measureBold) : H.minHead;
    })();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const h = heights[i];
      const isGroupStart = row.kind === 'dist' || row.kind === 'head';

      if (isGroupStart) {
        // 本组要占：自己 + 后续同组头行 + 至少一行数据
        let probe = h;
        for (let j = i + 1; j < rows.length && rows[j].kind !== 'data'; j++) {
          if (rows[j].kind === 'head' || rows[j].kind === 'dist') probe += heights[j];
        }
        const hasNextData = rows.slice(i + 1).some(r => r.kind === 'data');
        if (hasNextData && !fits(probe + H.minData) && cur.length) {
          pages.push(cur);
          cur = [];
          y = M.top;
        }
      } else if (!fits(h) && cur.length) {
        // 数据行放不下 → 翻页，续页补列头
        pages.push(cur);
        cur = [];
        y = M.top;
        const prevHead = rows.slice(0, i).reverse().find(r => r.kind === 'head');
        const groupOpen = prevHead && rows.slice(0, i).reverse().findIndex(r => r.kind === 'dist')
          > rows.slice(0, i).reverse().findIndex(r => r.kind === 'head');
        if (prevHead && groupOpen) {
          cur.push({ kind: 'head', cells: prevHead.cells, __cont: true });
          y += headH;
        }
      }

      cur.push(row);
      y += h;
    }
    if (cur.length) pages.push(cur);
    return pages;
  }

  // ---------------- 单页绘制指令生成 ----------------
  /* 返回与 PDF 无关的绘制指令，便于单测：
   * { fills:[{x,y,w,h,color}], lines:[{x1,y1,x2,y2,width,color}], texts:[...], links:[...] } */
  function renderPage(pageRows, pageIndex, totalPages, title, colW, measure, opts) {
    const o = opts || {};
    const x0 = M.left;
    const fills = [], lines = [], texts = [], links = [];
    let y = M.top;
    const pageBottomHint = PAGE_H - M.bottom - 12;

    // 1) 计算每行位置
    const placed = [];
    for (const row of pageRows) {
      const h = row.kind === 'title' ? H.title
        : row.kind === 'dist' ? H.dist
          : rowHeightOf(row, colW, measure);
      placed.push({ row, y, h });
      y += h;
    }
    const tableTop = placed[0]?.y ?? M.top;
    const tableBottom = y;

    // 2) 底色
    for (const p of placed) {
      if (p.row.kind === 'dist') {
        fills.push({ x: x0, y: p.y, w: TABLE_W, h: p.h, color: COLOR.distFill });
      } else if (p.row.kind === 'head') {
        fills.push({ x: x0, y: p.y, w: TABLE_W, h: p.h, color: COLOR.headFill });
      } else if (p.row.kind === 'title') {
        // 标题行不再是白底：和原版一样留白，但加一条分隔线更精神
      }
    }

    // 3) 网格：竖线只画在 head/data 连段里（dist 行跨全宽，不画内竖线）
    let runStart = null, runEnd = null;
    const runs = [];
    for (const p of placed) {
      const isGridRow = p.row.kind === 'head' || p.row.kind === 'data';
      if (isGridRow) {
        if (runStart === null) runStart = p.y;
        runEnd = p.y + p.h;
      } else if (runStart !== null) {
        runs.push([runStart, runEnd]); runStart = null; runEnd = null;
      }
    }
    if (runStart !== null) runs.push([runStart, runEnd]);

    for (const [ya, yb] of runs) {
      let x = x0;
      for (let i = 0; i < colW.length - 1; i++) {
        x += colW[i];
        lines.push({ x1: x, y1: ya, x2: x, y2: yb, width: 0.4, color: COLOR.grid });
      }
    }

    // 横线：所有行边界去重后只画一次（避免相邻行 bottom+top 叠成 2px）
    const yBounds = new Set();
    for (const p of placed) { yBounds.add(+p.y.toFixed(2)); yBounds.add(+(p.y + p.h).toFixed(2)); }
    const sortedY = [...yBounds].sort((a, b) => a - b);
    for (const yy of sortedY) {
      const isOuter = Math.abs(yy - tableTop) < 0.01 || Math.abs(yy - tableBottom) < 0.01;
      lines.push({ x1: x0, y1: yy, x2: x0 + TABLE_W, y2: yy, width: isOuter ? 0.9 : 0.4, color: COLOR.grid });
    }
    // 外框左右两根竖线
    lines.push({ x1: x0, y1: tableTop, x2: x0, y2: tableBottom, width: 0.9, color: COLOR.grid });
    lines.push({ x1: x0 + TABLE_W, y1: tableTop, x2: x0 + TABLE_W, y2: tableBottom, width: 0.9, color: COLOR.grid });

    // 4) 文字
    // 注意：PdfWriter.text() 的 align 需要同时给 width 才生效；这里统一自己算左起点、
    // 一律用 align:'left' 输出，避免「右对齐列从右边界起笔、整列溢出到隔壁」。
    const measureBold = o.measureBold || measure;

    for (const p of placed) {
      const row = p.row;
      if (row.kind === 'title') {
        const t = row.text || title;
        const w = measureBold(t, SIZE.title);
        texts.push({
          text: t, x: x0 + (TABLE_W - w) / 2, y: p.y + p.h / 2 + SIZE.title * 0.36,
          size: SIZE.title, bold: true, color: COLOR.title, align: 'left',
        });
        continue;
      }
      if (row.kind === 'dist') {
        const w = measureBold(row.text, SIZE.dist);
        texts.push({
          text: row.text, x: x0 + (TABLE_W - w) / 2, y: p.y + p.h / 2 + SIZE.dist * 0.36,
          size: SIZE.dist, bold: true, color: COLOR.distText, align: 'left',
        });
        continue;
      }
      const isHead = row.kind === 'head';
      let x = x0;
      const lh = isHead ? LH.head : LH.data;
      for (let i = 0; i < colW.length; i++) {
        const cw = colW[i];
        const cell = layoutCell(row.cells[i], cw, isHead, measure);
        const totalTextH = cell.lines.length * lh;
        let ty = p.y + (p.h - totalTextH) / 2 + cell.size * 0.78;
        const align = isHead ? 'center' : (RIGHT.has(i) ? 'right' : 'left');
        for (const ln of cell.lines) {
          const lw = (isHead ? measureBold(ln, cell.size) : measure(ln, cell.size));
          const lx = align === 'center' ? x + (cw - lw) / 2
            : align === 'right' ? x + cw - PAD_X - lw
              : x + PAD_X;
          texts.push({
            text: ln, x: lx, y: ty, size: cell.size, bold: isHead,
            color: isHead ? COLOR.headText : ((i === 0 && row.link) ? COLOR.link : COLOR.body),
            align: 'left',
          });
          ty += lh;
        }
        if (i === 0 && row.link) links.push({ x, y: p.y, w: cw, h: p.h, url: row.link });
        x += cw;
      }
    }

    // 5) 页脚
    if (!o.hideFooter) {
      const ft = `第 ${pageIndex + 1} / ${totalPages} 页`;
      const fw = measure(ft, SIZE.footer);
      texts.push({
        text: ft, x: x0 + TABLE_W - fw, y: PAGE_H - M.bottom - 2,
        size: SIZE.footer, bold: false, color: COLOR.footer, align: 'left',
      });
    }

    return { fills, lines, texts, links, tableTop, tableBottom, pageBottomHint };
  }

  // ---------------- 纯布局（可单测：不碰 PDF） ----------------
  function withTitleRow(rows, title) {
    if (rows.length && rows[0].kind === 'title') return rows;
    return [{ kind: 'title', text: title || '' }, ...rows];
  }

  function buildLayout(rows, title, measure, measureBold) {
    const all = withTitleRow(rows, title);
    const colW = solveColumns(all, measure, TABLE_W, measureBold);
    const heights = all.map(r => rowHeightOf(r, colW, measure, measureBold));
    const pages = paginate(all, heights, colW, measure, measureBold);
    const views = pages.map((pg, i) => renderPage(pg, i, pages.length, title, colW, measure, { measureBold }));
    return { colW, pages, views };
  }

  // ---------------- 真正出 PDF ----------------
  let fontCache = null;

  function reportTitleFallback() {
    const d = new Date();
    return `陕西源动创科（${d.getMonth() + 1}月${d.getDate()}日房源汇总）`;
  }

  async function loadFonts(urlRegular, urlBold) {
    if (fontCache) return fontCache;
    const F = global.PdfFont;
    if (!F) throw new Error('pdf-font.js 未加载');
    const grab = async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`字体加载失败 ${res.status} ${u}`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [regBytes, bdBytes] = await Promise.all([
      grab(urlRegular || defaultUrl('fonts/msyh-cjk.ttf')),
      grab(urlBold || defaultUrl('fonts/msyhbd-cjk.ttf')),
    ]);
    const reg = F.parseTtf(regBytes);
    const bold = F.parseTtf(bdBytes);
    fontCache = { reg, bold };
    return fontCache;
  }

  function defaultUrl(rel) {
    try {
      if (global.chrome?.runtime?.getURL) return global.chrome.runtime.getURL(rel);
    } catch (_) { /* 非扩展环境 */ }
    return rel;
  }

  async function build(rows, title, opts) {
    const o = opts || {};
    const F = global.PdfFont, W = global.PdfWriter;
    if (!F || !W) throw new Error('PDF 引擎未就绪（pdf-font.js / pdf-writer.js 缺失）');

    const fonts = await loadFonts(o.fontUrlRegular, o.fontUrlBold);

    // 标题行由这里补上（调用方传的是纯业务行：区名/表头/数据）
    const all = withTitleRow(rows, title || reportTitleFallback());

    // 先把所有文字收集起来，一次子集化（两份字体各自子集）
    const text = [];
    for (const r of all) {
      if (r.text) text.push(String(r.text));
      if (r.cells) for (const c of r.cells) text.push(String(c ?? ''));
    }
    text.push(String(title || ''));
    text.push('第 1 / 1 页');

    const regFace = await F.prepare(fonts.reg, text.join(''), { name: 'F1' });
    const boldFace = await F.prepare(fonts.bold, text.join(''), { name: 'F2' });

    const measure = (str, size) => regFace.measure(str, size);
    const measureBold = (str, size) => boldFace.measure(str, size);

    const colW = solveColumns(all, measure, TABLE_W, measureBold);
    const heights = all.map(r => rowHeightOf(r, colW, measure, measureBold));
    const pages = paginate(all, heights, colW, measure, measureBold);

    const pdf = W.create({
      width: PAGE_W, height: PAGE_H,
      title: title || '', author: '法拍页面采集器',
      compress: true,
    });

    for (let i = 0; i < pages.length; i++) {
      const page = pdf.addPage();
      page.setFaces({ regular: regFace, bold: boldFace });
      const view = renderPage(pages[i], i, pages.length, title, colW, measure, { measureBold });
      for (const f of view.fills) page.rect(f.x, f.y, f.w, f.h, { fill: f.color });
      for (const l of view.lines) page.line(l.x1, l.y1, l.x2, l.y2, { color: l.color, width: l.width });
      for (const t of view.texts) {
        page.text(t.text, t.x, t.y, { size: t.size, bold: t.bold, color: t.color, align: t.align });
      }
      for (const lk of view.links) page.link(lk.x, lk.y, lk.w, lk.h, lk.url);
    }

    const bytes = await pdf.build();
    return { bytes, pages: pages.length, colW };
  }

  global.ReportPdf = {
    build, buildLayout, renderPage, solveColumns, rowHeightOf, layoutCell, wrapText,
    PAGE_W, PAGE_H, TABLE_W, SIZE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
