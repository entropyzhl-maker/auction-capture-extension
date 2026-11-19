/**
 * ============================================================================
 * pdf-writer.js —— 纯 JS / 零依赖极简 PDF 写入器（矢量文字 + 嵌入字体）
 * ============================================================================
 *
 * 配合 pdf-font.js 使用。坐标系统：**页面左上角为原点，y 向下**（和 canvas / DOM 一致），
 * 内部自动翻转成 PDF 的左下原点坐标。text() 的 y 就是基线距页面顶部的距离，不做额外偏移。
 *
 * ---------------------------------------------------------------------------
 * 给 report-export.js 用的 API
 * ---------------------------------------------------------------------------
 *
 *   const pdf = PdfWriter.create({ width: 842, height: 595, title: '房源汇总', author: '法拍插件' });
 *   const page = pdf.addPage();
 *   page.font(facesR);                        // 常规字体（PdfFont.prepare 的返回值）
 *   page.font(facesB, { bold: true });        // 粗体字体（真字形，不做伪粗体）
 *   // 或一次设定：page.setFaces({ regular: facesR, bold: facesB })
 *
 *   page.text('标题', x, yBaselineFromTop, {
 *     size: 16, bold: true, color: [0, 0, 0],   // color 可给 0~255 或 0~1
 *     align: 'left' | 'center' | 'right',       // 需要同时给 width
 *     width: 200
 *   });
 *
 *   page.rect(x, y, w, h, { fill: [r,g,b], stroke: [r,g,b], lineWidth: 0.5 });
 *   page.line(x1, y1, x2, y2, { color: [r,g,b], width: 0.5 });
 *   page.link(x, y, w, h, 'https://example.com');   // 可点击注释区
 *   page.measure('文本', 12)                         // -> 宽度(pt)
 *   page.textLines(str, x, y, { size, width, lineHeight, bold, color })  // 自动折行
 *
 *   const bytes = await pdf.build();          // -> Uint8Array
 *   fs.writeFileSync('out.pdf', bytes);       // 或 new Blob([bytes], {type:'application/pdf'})
 *
 * ---------------------------------------------------------------------------
 * 其它
 * ---------------------------------------------------------------------------
 *   pdf.addPage(fn)    传回调时回调里直接画，返回 page
 *   pdf.pages          页数组
 *   pdf.width / pdf.height
 *
 * 压缩：有 CompressionStream 就用 FlateDecode（Chrome / Node 18+ 都有），
 * 没有或 create({compress:false}) 就 store（不压缩、省略 /Filter），xref 长度依然正确。
 *
 * 字体对象：由 PdfFont 的 faces.objects() 提供，本文件负责分配对象号、
 * 把 @@KEY@@ 占位符替换成 "N 0 R"、压缩流、补 /Length。
 * ============================================================================
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 工具 */

  function toColor(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      var h = String(c).replace('#', '');
      if (h.length === 6) {
        return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
      }
      if (h.length === 3) {
        return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
      }
      return [0, 0, 0];
    }
    var big = (c[0] > 1 || c[1] > 1 || c[2] > 1);
    var d = big ? 255 : 1;
    var out = [c[0] / d, c[1] / d, c[2] / d];
    for (var i = 0; i < 3; i++) {
      if (!isFinite(out[i])) out[i] = 0;
      if (out[i] < 0) out[i] = 0;
      if (out[i] > 1) out[i] = 1;
    }
    return out;
  }

  function fnum(v) {
    if (!isFinite(v)) return '0';
    var r = Math.round(v * 1000) / 1000;
    if (r === 0) return '0';
    return String(r);
  }

  function rgbOp(c, stroke) {
    return fnum(c[0]) + ' ' + fnum(c[1]) + ' ' + fnum(c[2]) + (stroke ? ' RG' : ' rg');
  }

  /** PDF 字面字符串；非 ASCII 走 UTF-16BE + BOM 的十六进制串 */
  function pdfString(str) {
    var s = String(str == null ? '' : str);
    var ascii = true;
    for (var i = 0; i < s.length; i++) {
      var cc = s.charCodeAt(i);
      if (cc > 0x7E || cc < 0x20) { ascii = false; break; }
    }
    if (ascii) return '(' + s.replace(/[\\()]/g, function (m) { return '\\' + m; }) + ')';
    var hex = 'FEFF';
    for (var j = 0; j < s.length; j++) hex += ('0000' + s.charCodeAt(j).toString(16).toUpperCase()).slice(-4);
    return '<' + hex + '>';
  }

  function latin1Bytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }

  /* ---------------------------------------------------------------- 压缩 */

  var hasCS = (typeof CompressionStream !== 'undefined') && (typeof Response !== 'undefined');

  function deflate(bytes) {
    if (!hasCS || bytes.length < 32) return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate');
      var w = cs.writable.getWriter();
      w.write(bytes);
      w.close();
      return new Response(cs.readable).arrayBuffer()
        .then(function (ab) {
          var z = new Uint8Array(ab);
          return z.length < bytes.length ? z : null;
        })
        .catch(function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /* ---------------------------------------------------------------- 页面 */

  function makePage(doc) {
    var ops = [];
    var annots = [];
    var facesByRole = { regular: null, bold: null };

    var page = {
      width: doc.width,
      height: doc.height,

      setFaces: function (map) {
        if (!map) return page;
        if (map.regular) facesByRole.regular = map.regular;
        if (map.bold) facesByRole.bold = map.bold;
        return page;
      },

      /**
       * page.font(faces)                     -> 设常规（regular 已存在时设粗体，便于连续两次调用）
       * page.font(faces, { bold: true })     -> 设粗体
       * page.font(faces, { bold: false })    -> 明确设常规
       * page.font(faces, { regular: true })  -> 明确设常规
       */
      font: function (f, opts) {
        if (!f) return page;
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'bold')) {
          if (opts.bold) facesByRole.bold = f;
          else facesByRole.regular = f;
          return page;
        }
        if (opts && opts.regular) {
          facesByRole.regular = f;
          return page;
        }
        if (!facesByRole.regular) facesByRole.regular = f;
        else facesByRole.bold = f;
        return page;
      },

      _pick: function (bold) {
        if (bold) {
          var fb = facesByRole.bold || facesByRole.regular;
          if (!fb) throw new Error('PdfWriter: 未设置 bold 字体，先 page.font(faces,{bold:true})');
          return { f: fb, name: fb.name || 'F2' };
        }
        var fr = facesByRole.regular || facesByRole.bold;
        if (!fr) throw new Error('PdfWriter: 未设置字体，先 page.font(faces)');
        return { f: fr, name: fr.name || 'F1' };
      },

      _faces: function () {
        var out = [];
        if (facesByRole.regular) out.push(facesByRole.regular);
        if (facesByRole.bold && facesByRole.bold !== facesByRole.regular) out.push(facesByRole.bold);
        return out;
      },

      measure: function (str, size, bold) {
        return page._pick(bold).f.measure(str, size);
      },

      /** y = 基线距页面顶部；返回实际绘制宽度 */
      text: function (str, x, y, opts) {
        opts = opts || {};
        var s = String(str == null ? '' : str);
        if (!s.length) return 0;
        var size = opts.size == null ? 10 : opts.size;
        var sel = page._pick(opts.bold);
        var w = sel.f.measure(s, size);
        var tx = x;
        if (opts.align && opts.align !== 'left' && opts.width != null && opts.width > 0) {
          if (opts.align === 'center') tx = x + (opts.width - w) / 2;
          else if (opts.align === 'right') tx = x + opts.width - w;
        }
        var color = toColor(opts.color) || [0, 0, 0];
        ops.push('BT');
        ops.push('/' + sel.name + ' ' + fnum(size) + ' Tf');
        ops.push(rgbOp(color, false));
        ops.push('1 0 0 1 ' + fnum(tx) + ' ' + fnum(doc.height - y) + ' Tm');
        ops.push(sel.f.hex(s) + ' Tj');
        ops.push('ET');
        return w;
      },

      rect: function (x, y, w, h, opts) {
        opts = opts || {};
        var fill = toColor(opts.fill);
        var stroke = toColor(opts.stroke);
        var py = doc.height - y - h;
        ops.push('q');
        if (stroke) ops.push(fnum(opts.lineWidth == null ? 0.5 : opts.lineWidth) + ' w');
        if (fill) ops.push(rgbOp(fill, false));
        if (stroke) ops.push(rgbOp(stroke, true));
        ops.push(fnum(x) + ' ' + fnum(py) + ' ' + fnum(w) + ' ' + fnum(h) + ' re');
        if (fill && stroke) ops.push('B');
        else if (fill) ops.push('f');
        else if (stroke) ops.push('S');
        else ops.push('n');
        ops.push('Q');
        return page;
      },

      line: function (x1, y1, x2, y2, opts) {
        opts = opts || {};
        var color = toColor(opts.color) || [0, 0, 0];
        ops.push('q');
        ops.push(fnum(opts.width == null ? 0.5 : opts.width) + ' w');
        ops.push(rgbOp(color, true));
        ops.push(fnum(x1) + ' ' + fnum(doc.height - y1) + ' m');
        ops.push(fnum(x2) + ' ' + fnum(doc.height - y2) + ' l');
        ops.push('S');
        ops.push('Q');
        return page;
      },

      link: function (x, y, w, h, url) {
        annots.push({
          rect: [x, doc.height - y - h, x + w, doc.height - y],
          url: String(url)
        });
        return page;
      },

      /** 按宽度自动折行（按字符断，中文友好） */
      textLines: function (str, x, y, opts) {
        opts = opts || {};
        var size = opts.size == null ? 10 : opts.size;
        var lineH = opts.lineHeight == null ? size * 1.35 : opts.lineHeight;
        var maxW = opts.width == null ? (doc.width - x * 2) : opts.width;
        var sel = page._pick(opts.bold);
        var s = String(str == null ? '' : str);
        var lines = [];
        var cur = '';
        for (var i = 0; i < s.length; i++) {
          var ch = s[i];
          if (ch === '\n') { lines.push(cur); cur = ''; continue; }
          var test = cur + ch;
          if (cur && sel.f.measure(test, size) > maxW) { lines.push(cur); cur = ch; }
          else cur = test;
        }
        if (cur) lines.push(cur);
        for (var j = 0; j < lines.length; j++) {
          page.text(lines[j], x, y + j * lineH, opts);
        }
        return lines.length;
      },

      _ops: function () { return ops; },
      _annots: function () { return annots; }
    };
    return page;
  }

  /* ---------------------------------------------------------------- 文档 */

  function create(opts) {
    opts = opts || {};
    var doc = {
      width: opts.width || 595,
      height: opts.height || 842,
      title: opts.title || '',
      author: opts.author || '',
      subject: opts.subject || '',
      compress: opts.compress !== false
    };
    var pages = [];

    var api = {
      pages: pages,
      width: doc.width,
      height: doc.height,
      addPage: function (fn) {
        var p = makePage(doc);
        pages.push(p);
        if (typeof fn === 'function') fn(p);
        return p;
      },
      build: function () { return buildPdf(doc, pages); }
    };
    return api;
  }

  /* ---------------------------------------------------------------- 构建 */

  /**
   * 对象模型：objs = [{ key, dict, stream }]
   *   dict 里用 @@KEY@@ 引用其它对象
   *   stream 非空 = stream 对象（dict 里的 /Length、/Filter 由这里补）
   * 编号：1 = /Catalog，2 = /Pages，其余 3..N；最后 N+1 = /Info
   */
  function buildPdf(doc, pages) {
    var objs = [];
    var seen = new Set();

    function push(obj) {
      if (seen.has(obj.key)) return obj.key || null;
      seen.add(obj.key);
      objs.push(obj);
      return obj.key;
    }

    // ---- 1. 字体对象（同一 faces 只加一次）
    var faceKeyMap = new Map(); // faces -> type0 key
    for (var i = 0; i < pages.length; i++) {
      var list = pages[i]._faces();
      for (var j = 0; j < list.length; j++) {
        var f = list[j];
        if (faceKeyMap.has(f)) continue;
        var fobjs = f.objects();
        for (var k = 0; k < fobjs.length; k++) {
          push({ key: fobjs[k].key, dict: fobjs[k].dict, stream: fobjs[k].stream || null });
        }
        faceKeyMap.set(f, fobjs[0].key);
      }
    }

    // ---- 2. 页面 + 内容流 + 链接注释
    var pageKeys = [];
    for (var pi = 0; pi < pages.length; pi++) {
      var page = pages[pi];
      var contentKey = 'PAGE_CONTENT_' + pi;
      push({ key: contentKey, dict: '', stream: latin1Bytes(page._ops().join('\n')) });

      var annotKeys = [];
      var annots = page._annots();
      for (var ai = 0; ai < annots.length; ai++) {
        var ak = 'PAGE_ANNOT_' + pi + '_' + ai;
        var r = annots[ai].rect.map(function (v) { return fnum(v); }).join(' ');
        push({
          key: ak,
          dict: '/Type /Annot /Subtype /Link /Rect [' + r + '] /Border [0 0 0] /F 4' +
            ' /A << /S /URI /URI ' + pdfString(annots[ai].url) + ' >>',
          stream: null
        });
        annotKeys.push(ak);
      }

      var pk = 'PAGE_' + pi;
      var resList = page._faces();
      var fontRes = resList.map(function (fx) {
        return '/' + (fx.name || 'F1') + ' @@' + faceKeyMap.get(fx) + '@@';
      }).join(' ');
      var dict = '/Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fnum(page.width) + ' ' + fnum(page.height) + ']' +
        ' /Resources << /Font << ' + fontRes + ' >> /ProcSet [/PDF /Text] >>' +
        ' /Contents @@' + contentKey + '@@';
      if (annotKeys.length) {
        dict += ' /Annots [' + annotKeys.map(function (a) { return '@@' + a + '@@'; }).join(' ') + ']';
      }
      push({ key: pk, dict: dict, stream: null });
      pageKeys.push(pk);
    }

    // ---- 3. 分配对象号
    var idMap = new Map();
    for (var oi = 0; oi < objs.length; oi++) idMap.set(objs[oi].key, oi + 3);
    var total = objs.length + 2;     // 含 catalog(1) + pages(2)
    var infoId = total + 1;

    function ref(key) {
      var id = idMap.get(key);
      if (id == null) throw new Error('PdfWriter: 未登记对象 ' + key);
      return id + ' 0 R';
    }

    function resolve(dict) {
      if (!dict) return '';
      return dict.replace(/@@([A-Za-z0-9_]+)@@/g, function (_m, kk) {
        return ref(kk);
      });
    }

    // ---- 4. 逐个序列化（流可压缩）
    var jobs = objs.map(function (o) {
      if (!o.stream) {
        return Promise.resolve({ id: idMap.get(o.key), dictBytes: latin1Bytes(resolve(o.dict)), streamBytes: null });
      }
      var raw = o.stream;
      if (!doc.compress) {
        return Promise.resolve({ id: idMap.get(o.key), dictBytes: latin1Bytes(resolve(o.dict) + ' /Length ' + raw.length), streamBytes: raw });
      }
      return deflate(raw).then(function (z) {
        if (!z) {
          return { id: idMap.get(o.key), dictBytes: latin1Bytes(resolve(o.dict) + ' /Length ' + raw.length), streamBytes: raw };
        }
        return {
          id: idMap.get(o.key),
          dictBytes: latin1Bytes(resolve(o.dict) + ' /Filter /FlateDecode /Length ' + z.length),
          streamBytes: z
        };
      });
    });

    return Promise.all(jobs).then(function (parts) {
      var chunks = [];
      var offsets = new Array(infoId + 1);
      var pos = 0;

      function writeStr(s) {
        var b = latin1Bytes(s);
        chunks.push(b);
        pos += b.length;
      }
      function writeBytes(b) {
        chunks.push(b);
        pos += b.length;
      }
      // dictBytes 可能是 '<< ... >>'（PdfFont 产出的）也可能是不带括号的片段，统一补齐
      function wrapDict(dictBytes) {
        var s = '';
        for (var q = 0; q < dictBytes.length; q++) s += String.fromCharCode(dictBytes[q]);
        var t = s.trim();
        if (t.slice(0, 2) === '<<' && t.slice(-2) === '>>') return latin1Bytes('<< ' + t.slice(2, -2) + ' >>');
        return latin1Bytes('<< ' + t + ' >>');
      }

      function writeObj(id, dictBytes, streamBytes) {
        offsets[id] = pos;
        writeStr(id + ' 0 obj\n');
        writeBytes(wrapDict(dictBytes));
        if (streamBytes) {
          writeStr('\nstream\n');
          writeBytes(streamBytes);
          writeStr('\nendstream');
        }
        writeStr('\nendobj\n');
      }

      writeStr('%PDF-1.7\n%\u00E2\u00E3\u00CF\u00D3\n');

      // 1 = Catalog
      writeObj(1, latin1Bytes('/Type /Catalog /Pages 2 0 R'), null);
      // 2 = Pages
      var kids = pageKeys.map(function (k) { return ref(k); }).join(' ');
      writeObj(2, latin1Bytes('/Type /Pages /Kids [' + kids + '] /Count ' + pageKeys.length), null);
      // 3..N
      for (var i2 = 0; i2 < parts.length; i2++) {
        writeObj(parts[i2].id, parts[i2].dictBytes, parts[i2].streamBytes);
      }
      // Info
      var info = '/Producer ' + pdfString('PdfWriter.js 1.0 (法拍插件)') +
        (doc.title ? ' /Title ' + pdfString(doc.title) : '') +
        (doc.author ? ' /Author ' + pdfString(doc.author) : '') +
        (doc.subject ? ' /Subject ' + pdfString(doc.subject) : '');
      writeObj(infoId, latin1Bytes(info), null);

      // xref
      var xrefStart = pos;
      writeStr('xref\n0 ' + (infoId + 1) + '\n');
      writeStr('0000000000 65535 f \n');
      for (var x = 1; x <= infoId; x++) {
        writeStr(('0000000000' + (offsets[x] || 0)).slice(-10) + ' 00000 n \n');
      }
      writeStr('trailer\n<< /Size ' + (infoId + 1) + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\n');
      writeStr('startxref\n' + xrefStart + '\n%%EOF\n');

      var out = new Uint8Array(pos);
      var p = 0;
      for (var c = 0; c < chunks.length; c++) {
        out.set(chunks[c], p);
        p += chunks[c].length;
      }
      return out;
    });
  }

  /* ---------------------------------------------------------------- 导出 */

  var PdfWriter = {
    version: '1.0.0',
    create: create,
    hasCompressionStream: hasCS,
    utils: { toColor: toColor, pdfString: pdfString, deflate: deflate }
  };

  global.PdfWriter = PdfWriter;
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfWriter;
})(typeof window !== 'undefined' ? window : globalThis);
