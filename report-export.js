/* report-export.js —— 100% 自包含的 xlsx + PDF 导出引擎
 *
 * 不依赖任何外部库 / Python / 本地路径 / 注册表，全部在浏览器扩展沙箱内完成：
 *   · xlsx：手写 ZIP(store + CRC32) + OOXML（样式 / 超链接 / 列宽 / 合并单元格 / 完整外框）
 *   · PDF ：矢量文字表格 —— 真字体子集嵌入（Type0 / Identity-H），
 *           文字可选中、可检索、任意放大不糊；不再走「Canvas → JPEG」位图路线。
 *
 * PDF 依赖同目录三个模块（缺任意一个会自动退回旧的位图方案，不会导不出）：
 *   pdf-font.js    TrueType 解析 + 子集化 + PDF 字体对象
 *   pdf-writer.js  极简 PDF 写入器（多页 / 链接 / FlateDecode）
 *   report-pdf.js  表格排版（列宽求解 / 折行 / 分页 / 绘制指令）
 *
 * 对外暴露 window.ReportExport：
 *   buildReportData(records) -> {rows, groups, dropped}
 *   buildXlsx(rows, title)   -> Uint8Array   (.xlsx 字节)
 *   buildPdf(rows, title)    -> Promise<{bytes:Uint8Array, pages:number, mode:'vector'|'bitmap'}>
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 0. 数据模型：把 pool 记录转成排版行（复刻 auction_merge4 的转换）
  // ------------------------------------------------------------------
  const HEADERS = ['小区名称', '面积', '市场价/万元', '起拍价/万元', '捡漏金额/万元',
    '折扣/（%）', '小区地址', '单元/楼层', '室内结构', '装修/情况',
    '单价/㎡/元', '拍卖/状态', '竞拍日期', '建成/时间', '房屋/情况', '类型'];
  const WIDTHS = [14, 8, 9, 10, 10, 7, 22, 16, 11, 7, 9, 10, 11, 8, 8, 7];

  const num = v => {
    if (v === null || v === undefined || v === '' || v === '/' || v === '\\') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (v, nd = 2) => v === null ? '/' : Number(v.toFixed(nd));
  const slash = v => {
    const s = String(v ?? '').trim();
    return (!s || s === '/' || s === '\\' || s === '-') ? '/' : s;
  };
  const date = v => {
    const s = String(v ?? '').trim();
    if (!s || s === '/') return '/';
    const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${+m[1]}/${+m[2]}/${+m[3]}` : s;
  };

  function buildReportData(records) {
    const clean = [];
    let dropped = 0;
    for (const rec of (records || [])) {
      const name = slash(rec?.community);
      if (name === '/') { dropped++; continue; }
      const area = num(rec?.area_sqm);
      const market = num(rec?.market_price_wan);
      const start = num(rec?.starting_price_wan);
      const save = (market !== null && start !== null) ? market - start : null;
      const disc = (market && market > 0 && start !== null) ? start / market * 100 : null;
      const unit = (start !== null && area) ? Math.round(start * 10000 / area) : null;
      const dist = (String(rec?.district || '').trim().split('/')[0].trim()) || '未分类';
      const link = String(rec?.detail_url || '').trim();
      clean.push({
        dist,
        cells: [
          name, fmt(area), fmt(market), fmt(start), fmt(save),
          disc === null ? '/' : `${Math.round(disc)}%`,
          slash(rec?.address), slash(rec?.unit_floor), slash(rec?.room_structure),
          slash(rec?.decoration), unit === null ? '/' : unit, slash(rec?.auction_result),
          date(rec?.auction_date), '/', slash(rec?.property_status), slash(rec?.asset_type),
        ],
        link: /^https?:\/\//i.test(link) ? link : null,
      });
    }
    const groups = new Map();
    for (const r of clean) {
      if (!groups.has(r.dist)) groups.set(r.dist, []);
      groups.get(r.dist).push(r);
    }
    const rows = [];
    for (const [dist, sub] of groups) {
      rows.push({ kind: 'dist', text: dist });
      rows.push({ kind: 'head', cells: HEADERS.slice() });
      for (const r of sub) rows.push({ kind: 'data', cells: r.cells, link: r.link });
    }
    const groupStat = {};
    for (const [k, v] of groups) groupStat[k] = v.length;
    return { rows, groups: groupStat, dropped };
  }

  function reportTitle() {
    const d = new Date();
    return `陕西源动创科（${d.getMonth() + 1}月${d.getDate()}日房源汇总）`;
  }

  // 整个报表的行序列 = 标题行 + 各区(区名 + 表头 + 数据)
  // xlsx 与 PDF 共用同一份，避免两边版式走岔（PDF 曾因缺这一行而没有标题）。
  function withTitle(rows, title) {
    return [{ kind: 'title', text: title || reportTitle() }, ...rows];
  }

  // ------------------------------------------------------------------
  // 1. CRC32 + ZIP(store) —— xlsx 本质就是 zip 包
  // ------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function concat(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let p = 0;
    for (const a of arrays) { out.set(a, p); p += a.length; }
    return out;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    const local = [], central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data));
      const crc = crc32(data);
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); lh.set(nameBytes, 30);
      local.push(lh, data);
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46); central.push(cd);
      offset += lh.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return concat([...local, ...central, eocd]);
  }

  // ------------------------------------------------------------------
  // 2. OOXML 生成
  // ------------------------------------------------------------------
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colLetter = n => {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  };

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="房源汇总" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  // ---- 边框策略 ----
  //   1) 只有「左上角 cell 的内容」会被合并单元格渲染，但边框是逐格绘制的：
  //      标题行/区名行如果只写 A 列的 cell，B..P 就是无边框的空格，合并区
  //      右侧那条竖线根本不存在 —— 这正是「区名行只有上下两条横线、没有
  //      竖边收口」的根因。所以合并行必须把 B..P 的 cell 也写进 XML 并挂
  //      同一套边框（openpyxl 的 merged_cells 四边检查也依赖这一点）。
  //   2) 每格四边统一 thin（等价于 Excel「所有框线」）。相邻两格对同一条线
  //      各声明一次时，Excel / WPS 都会自己去重，实测渲染仍是 1px；反过来
  //      刻意「只让一边声明」反而会在合并行边界处留下断口。
  //   3) 样式复用：全部单元格 borderId=1，不再按行列算变体。
  const THIN = (tag) => `<${tag} style="thin"><color rgb="FF000000"/></${tag}>`;
  const BORDERS_XML = `<border><left/><right/><top/><bottom/><diagonal/></border>`
    + `<border>${THIN('left')}${THIN('right')}${THIN('top')}${THIN('bottom')}<diagonal/></border>`;

  const CENTER = '<alignment horizontal="center" vertical="center"/>';
  const CENTER_WRAP = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
  const LEFT_WRAP = '<alignment horizontal="left" vertical="center" wrapText="1"/>';
  const LEFT = '<alignment horizontal="left" vertical="center"/>';
  // 行角色：字体 / 底纹 / 对齐。索引即 s 值（0 号留给 Normal）。
  const ROLES = [
    { font: 1, fill: 0, align: CENTER },      // 1 title  14pt 红             ← 原来 borderId=0，表格顶部没横线
    { font: 2, fill: 2, align: CENTER },      // 2 dist   浅蓝底 DDEBF7
    { font: 3, fill: 3, align: CENTER_WRAP }, // 3 head   深蓝底 1F4E79
    { font: 0, fill: 0, align: CENTER },      // 4 data 居中
    { font: 0, fill: 0, align: LEFT_WRAP },   // 5 data 左对齐(地址/楼层)
    { font: 4, fill: 0, align: LEFT },        // 6 超链接
  ];
  const ROLE = { title: 1, dist: 2, head: 3, dataC: 4, dataL: 5, link: 6 };
  const CELL_XFS = ROLES.map(d =>
    `<xf numFmtId="0" fontId="${d.font}" fillId="${d.fill}" borderId="1" xfId="0" applyFont="1"`
    + ` applyFill="${d.fill ? 1 : 0}" applyBorder="1" applyAlignment="1">${d.align}</xf>`
  ).join('');

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="7"/><name val="微软雅黑"/></font>
<font><b/><sz val="14"/><color rgb="FFC00000"/><name val="微软雅黑"/></font>
<font><b/><sz val="10"/><color rgb="FF1F3864"/><name val="微软雅黑"/></font>
<font><b/><sz val="7"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>
<font><u/><sz val="7"/><color rgb="FF0563C1"/><name val="微软雅黑"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">${BORDERS_XML}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${1 + ROLES.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${CELL_XFS}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildSheet(rows, title) {
    const nc = HEADERS.length;
    const all = withTitle(rows, title);
    const lastRowIdx = all.length;          // 「数据行」总行数（含标题行）
    const merges = [];
    const hyperlinks = [];
    const sheetRels = [];
    let relId = 1;

    // 边框：所有 cell 统一「四边 thin」。相邻格对同一条线各声明一次，由
    // Excel / WPS 自行去重（实测渲染仍是 1px，不会叠成 2px）。
    // s 值就是 ROLES 下标 + 1（0 号是 Normal）。
    const cell = (style, colIdx, rowIdx, value) => {
      const ref = `${colLetter(colIdx + 1)}${rowIdx}`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
    };

    const rowXml = [];
    all.forEach((row, i) => {
      const r = i + 1;
      if (row.kind === 'title') {
        // 合并 A:P —— 但 B..P 的 cell 必须存在，否则合并区右侧竖边无从渲染。
        merges.push(`A${r}:${colLetter(nc)}${r}`);
        const cells = [];
        for (let c = 0; c < nc; c++) cells.push(cell(ROLE.title, c, r, c === 0 ? (row.text || title) : ''));
        rowXml.push(`<row r="${r}" ht="30" customHeight="1">${cells.join('')}</row>`);
      } else if (row.kind === 'dist') {
        merges.push(`A${r}:${colLetter(nc)}${r}`);
        const cells = [];
        for (let c = 0; c < nc; c++) cells.push(cell(ROLE.dist, c, r, c === 0 ? row.text : ''));
        rowXml.push(`<row r="${r}" ht="22" customHeight="1">${cells.join('')}</row>`);
      } else if (row.kind === 'head') {
        // 表头放宽到 32：'市场价/万元' 折两行时 26 会被裁。
        const cells = row.cells.map((v, c) => cell(ROLE.head, c, r, v));
        rowXml.push(`<row r="${r}" ht="32" customHeight="1">${cells.join('')}</row>`);
      } else {
        const cells = [];
        for (let c = 0; c < row.cells.length; c++) {
          const v = row.cells[c];
          const ref = `${colLetter(c + 1)}${r}`;
          const s = (c === 0 && row.link) ? ROLE.link : ((c === 6 || c === 7) ? ROLE.dataL : ROLE.dataC);
          if (c === 0 && row.link) {
            cells.push(`<c r="${ref}" s="${s}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`);
            const rid = `rId${relId++}`;
            hyperlinks.push(`<hyperlink ref="${ref}" r:id="${rid}"/>`);
            sheetRels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(row.link)}" TargetMode="External"/>`);
          } else if (typeof v === 'number' || (v !== '' && !isNaN(Number(v)) && !/^[%/]/.test(String(v)))) {
            cells.push(`<c r="${ref}" s="${s}"><v>${Number(v)}</v></c>`);
          } else {
            cells.push(`<c r="${ref}" s="${s}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`);
          }
        }
        rowXml.push(`<row r="${r}">${cells.join('')}</row>`);
      }
    });

    const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const hyperXml = hyperlinks.length ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : '';
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${colLetter(nc)}${lastRowIdx}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rowXml.join('')}</sheetData>
${mergeXml}
${hyperXml}
<pageMargins left="0.15" right="0.15" top="0.3" bottom="0.3" header="0.1" footer="0.1"/>
<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;

    const files = [
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'xl/workbook.xml', data: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
      { name: 'xl/styles.xml', data: STYLES },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ];
    if (sheetRels.length) {
      files.push({
        name: 'xl/worksheets/_rels/sheet1.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels.join('')}</Relationships>`,
      });
      // workbook rels 不需要改：hyperlink rels 是 sheet 级别的
    }
    return zipStore(files);
  }

  function buildXlsx(rows, title) {
    return buildSheet(rows, title || reportTitle());
  }

  // ------------------------------------------------------------------
  // 3. PDF —— Canvas 画表格 → 图片型 PDF（中文绝不乱码）
  // ------------------------------------------------------------------
  const PAGE_W = 1600, PAGE_H = 1130, PAD = 24; // canvas 像素，比例≈A4横向
  const ROW_H = { title: 44, dist: 32, head: 32, data: 25 };

  function paginate(rows) {
    const pages = [];
    let cur = [], used = 0;
    for (const row of rows) {
      const h = ROW_H[row.kind] || 25;
      if (used + h > PAGE_H - PAD * 2 && cur.length) { pages.push(cur); cur = []; used = 0; }
      cur.push(row); used += h;
    }
    if (cur.length) pages.push(cur);
    return pages;
  }

  // PDF 的列宽不能直接照搬 Excel 的字符单位（13px 字下 9 字符宽的列
  // 只放得下 6 个字，"88293.11"/"2026/12/23" 会被截成 "8829…"）。
  // 这里按「表头字数 + 数据实际内容」给每列定一个够用的权重。
  const PDF_WEIGHTS = [13, 6, 10, 10, 10, 7, 20, 18, 9, 7, 9, 8, 10, 7, 7, 6];

  // 按真实像素宽度把文本塞进列宽：优先缩字号，仍放不下才折行/截断。
  // 之前用「字符数 / 13」估宽，数字 88293.11 和长楼层会被从中切断，很难看。
  function fitText(ctx, txt, maxW, basePx) {
    let px = basePx;
    ctx.font = ctx.font.replace(/\d+(\.\d+)?px/, px + 'px');
    if (ctx.measureText(txt).width <= maxW) return { text: txt, px };
    while (px > 8) {
      px -= 1;
      ctx.font = ctx.font.replace(/\d+(\.\d+)?px/, px + 'px');
      if (ctx.measureText(txt).width <= maxW) return { text: txt, px };
    }
    let lo = 0, hi = txt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(txt.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return { text: lo > 0 ? txt.slice(0, lo) + '…' : '', px };
  }

  function drawPage(rows, pageIndex, totalPages, title) {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W; canvas.height = PAGE_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    const usable = PAGE_W - PAD * 2;
    const totalW = PDF_WEIGHTS.reduce((a, b) => a + b, 0);
    const colW = PDF_WEIGHTS.map(w => w / totalW * usable);
    let x0 = PAD, y = PAD;
    const links = [];
    ctx.textBaseline = 'middle';

    for (const row of rows) {
      const h = ROW_H[row.kind] || 25;
      if (row.kind === 'title') {
        ctx.fillStyle = '#C00000'; ctx.font = 'bold 30px "Microsoft YaHei","微软雅黑",sans-serif';
        ctx.textAlign = 'center'; ctx.fillText(row.text || title, PAGE_W / 2, y + h / 2);
      } else if (row.kind === 'dist') {
        ctx.fillStyle = '#DDEBF7'; ctx.fillRect(x0, y, usable, h);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x0, y, usable, h);
        ctx.fillStyle = '#1F3864'; ctx.font = 'bold 17px "Microsoft YaHei","微软雅黑",sans-serif';
        ctx.textAlign = 'center'; ctx.fillText(row.text, PAGE_W / 2, y + h / 2);
      } else {
        let x = x0;
        for (let i = 0; i < row.cells.length; i++) {
          const cw = colW[i];
          if (row.kind === 'head') { ctx.fillStyle = '#1F4E79'; ctx.fillRect(x, y, cw, h); }
          ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x, y, cw, h);
          ctx.fillStyle = row.kind === 'head' ? '#fff' : (i === 0 && row.link ? '#0563C1' : '#000');
          ctx.font = (row.kind === 'head' ? 'bold ' : '') + '13px "Microsoft YaHei","微软雅黑",sans-serif';
          const centered = (i === 1 || i === 2 || i === 3 || i === 4 || i === 5 || i === 10);
          ctx.textAlign = centered ? 'center' : 'left';
          const txt = String(row.cells[i] ?? '');
          const fit = fitText(ctx, txt, cw - 8, 13);
          ctx.fillText(fit.text, centered ? x + cw / 2 : x + 4, y + h / 2);
          if (i === 0 && row.link) links.push({ x, y, w: cw, h, url: row.link });
          x += cw;
        }
      }
      y += h;
    }
    ctx.fillStyle = '#888'; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`${pageIndex + 1} / ${totalPages}`, PAGE_W - PAD, PAGE_H - 8);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), links, w: PAGE_W, h: PAGE_H };
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function escapePdf(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  // 把若干页 canvas → 一份多页 PDF（每页一张 JPEG + 小区名 /Link 注释）
  function assemblePdf(pages) {
    const enc = new TextEncoder();
    const objs = [];           // 1-based，objs[i-1] 是第 i 个对象
    const add = s => { objs.push(s); return objs.length; };

    const catalogId = add(null);   // 占位，稍后填
    const pagesId = add(null);
    const pageIds = [], contentIds = [], imageIds = [], linkIdsPerPage = [];

    for (const pg of pages) {
      const jpeg = b64ToBytes(pg.dataUrl.slice(pg.dataUrl.indexOf(',') + 1));
      const imgId = add({ stream: jpeg, dict: `/Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length}` });
      imageIds.push(imgId);
      // 图像铺满 A4 横向（842x595 pt）
      const content = enc.encode(`q\n842 0 0 595 0 0 cm\n/Im0 Do\nQ\n`);
      const cid = add({ stream: content, dict: `/Length ${content.length}` });
      contentIds.push(cid);
      const sx = 842 / pg.w, sy = 595 / pg.h;
      const linkIds = [];
      for (const l of pg.links) {
        const rect = `${(l.x * sx).toFixed(1)} ${(595 - (l.y + l.h) * sy).toFixed(1)} ${((l.x + l.w) * sx).toFixed(1)} ${(595 - l.y * sy).toFixed(1)}`;
        const aid = add(`<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /Type /Action /S /URI /URI (${escapePdf(l.url)}) >> >>`);
        linkIds.push(aid);
      }
      linkIdsPerPage.push(linkIds);
    }

    // 回填 page 对象（每个 page 必须在它引用的 content/image/annot 之后声明没关系，PDF 无所谓顺序）
    for (let i = 0; i < pages.length; i++) {
      const annots = linkIdsPerPage[i].length
        ? `/Annots [${linkIdsPerPage[i].map(id => `${id} 0 R`).join(' ')}]` : '';
      const pid = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im0 ${imageIds[i]} 0 R >> >> /Contents ${contentIds[i]} 0 R ${annots} >>`);
      pageIds.push(pid);
    }
    objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    // 序列化
    const chunks = [];
    chunks.push(enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const offsets = [0];
    let len = chunks[0].length;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      offsets.push(len);
      let body;
      if (typeof o === 'string') body = enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`);
      else body = concat([enc.encode(`${i + 1} 0 obj\n<< ${o.dict} >>\nstream\n`), o.stream, enc.encode(`\nendstream\nendobj\n`)]);
      chunks.push(body); len += body.length;
    }
    const xrefPos = len;
    const n = objs.length + 1;
    let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${n} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    chunks.push(enc.encode(xref));
    return concat(chunks);
  }

  // 矢量链路失败的原因（供 UI / 日志显示）。必须在 buildPdf 之前声明：
  // 之前写在 buildPdf 后面，赋值时命中 TDZ 会直接抛 ReferenceError。
  let lastPdfError = null;

  async function buildPdf(rows, title) {
    const t = title || reportTitle();
    lastPdfError = null;

    // 首选：矢量文字 PDF（pdf-font.js + pdf-writer.js + report-pdf.js）
    //   文字是真字体嵌入（Type0/Identity-H 子集），放大/打印都是清晰矢量，
    //   可选中、可全文检索，体积比旧版 JPEG 方案还小一个数量级。
    const RP = global.ReportPdf;
    if (RP && global.PdfFont && global.PdfWriter) {
      try {
        const out = await RP.build(rows, t);
        if (out && out.bytes && out.bytes.length > 1000) {
          return { bytes: out.bytes, pages: out.pages, mode: 'vector' };
        }
      } catch (err) {
        // 矢量链路失败就退回 canvas 位图，绝不因为字体问题让用户导不出文件
        console.warn('[report-export] 矢量 PDF 失败，回退位图模式：', err);
        lastPdfError = err && err.message ? err.message : String(err);
      }
    }

    // 兜底：Canvas 画表格 → JPEG → PDF（老路径，字会糊但一定出得来）
    const pages = paginate(withTitle(rows, t));
    const rendered = [];
    for (let i = 0; i < pages.length; i++) {
      rendered.push(drawPage(pages[i], i, pages.length, t));
    }
    return { bytes: assemblePdf(rendered), pages: rendered.length, mode: 'bitmap', fallbackReason: lastPdfError };
  }

  global.ReportExport = {
    buildReportData, buildXlsx, buildPdf, reportTitle, HEADERS, WIDTHS,
    get lastPdfError() { return lastPdfError; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
