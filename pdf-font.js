/**
 * ============================================================================
 * pdf-font.js —— 纯 JS / 零依赖 TrueType 子集化 + PDF 字体嵌入（Type0 / Identity-H）
 * ============================================================================
 *
 * 运行环境：Chrome 扩展页面（MV3 popup / 报表导出页）。纯 ES2019，无 require / Buffer / Node API。
 * 字体字节由调用方传入（不许自己 fetch 本地文件）。
 *
 * ---------------------------------------------------------------------------
 * 一、给 report-export.js 用的门面 API（推荐只用这几个）
 * ---------------------------------------------------------------------------
 *
 *   // 1) 载入字体（传 URL 会 fetch + 缓存；传 Uint8Array/ArrayBuffer 直接解析，不缓存）
 *   const fontR = await PdfFont.load(chrome.runtime.getURL('fonts/msyh-cjk.ttf'));
 *   const fontB = await PdfFont.load(chrome.runtime.getURL('fonts/msyhbd-cjk.ttf'));
 *
 *   // 2) 把【整份报表的所有文字】一次性喂进去做子集（必须一次性给全，后面才不会缺字）
 *   const faces = await PdfFont.prepare(fontR, allText, { name: 'F1' });
 *   const facesB = await PdfFont.prepare(fontB, allText, { name: 'F2' });
 *
 *   faces.name              -> 'F1'                两字节 CID 资源名
 *   faces.measure(s, size)  -> 宽度(pt)            advance 累加 * size / unitsPerEm
 *   faces.hex(s)            -> '<00410042...>'     Identity-H 两字节 hex，缺字回落 '?' 的 gid
 *   faces.fontFileBytes     -> Uint8Array          重建出来的子集 TTF 字节
 *   faces.widthsArray       -> '1 3 1000 4 [500]'  可直接拼进 /W 的字符串
 *   faces.objects()         -> [{ key, dict, stream }]  需要写进 PDF 的对象（含占位符 @@KEY@@）
 *
 *   // 3) 交给 PdfWriter
 *   const pdf = PdfWriter.create({ width: 842, height: 595, title: '房源汇总' });
 *   const page = pdf.addPage();
 *   page.font(faces);                                   // 常规字体
 *   page.font(facesB, { bold: true });                  // 粗体字体（真字形，不做伪粗体）
 *   page.text('陕西源动创科（11月18日房源汇总）', 40, 60, { size: 14 });
 *   const bytes = await pdf.build();
 *
 * ---------------------------------------------------------------------------
 * 二、底层 API（自测 / 调试用，report-export.js 不需要碰）
 * ---------------------------------------------------------------------------
 *
 *   PdfFont.parseTtf(arrayBufferOrUint8Array) -> font
 *     font.hasCodePoint(cp) -> bool
 *     font.gidFor(cp) -> gid | 0
 *     font.advance(gid) -> 字体单位宽度
 *     font.unitsPerEm, font.numGlyphs, font.name (PostScript 名)
 *     font.glyphData(gid) -> Uint8Array | null      glyf 原始字节，composite 不展开
 *     font.glyphBbox(gid) -> {xMin,yMin,xMax,yMax} | null
 *     font.allCodepoints() -> number[]
 *     font.tables -> { tag: {offset,length} }
 *     font.bytes  -> 原始 Uint8Array
 *
 *   PdfFont.subsetForText(font, text) -> { gids, order, mapping, chars }
 *     gids     : 用到的原始 gid 升序数组（含 0 和 composite 递归子 glyph）
 *     order    : 新 gid 顺序，order[newGid] = 旧 gid（order[0] === 0）
 *     mapping  : { [cp]: { cp, gid, newGid } }   —— 注意 key 是十进制字符串
 *     mapping.map : Map<cp, {cp,gid,newGid}>       —— 需要真 Map 时用这个
 *
 *   PdfFont.buildPdfFont(font, subsetOrMapping, opts) -> 对象
 *     { baseFont, subsetTag, tag6, type0Dict, cidFontDict, descriptor,
 *       fontFileBytes, widthsArray, widths, toUnicodeCmap, objects(),
 *       cidFor(cp), hex(str), measure(str,size), advance(gid), order, mapping }
 *
 *   PdfFont.encodeText(mappingOrFaces, text) -> '<0041...>'
 *   PdfFont.selftest(fontBytes, text) -> 报告对象（浏览器控制台也能跑）
 *
 * ---------------------------------------------------------------------------
 * 三、PDF 对象形状（faces.objects() 每一项）
 * ---------------------------------------------------------------------------
 *   {
 *     key:    'F1_a1b2c3_TYPE0'   唯一键；其他 dict 里用 @@这个KEY@@ 引用对象号
 *     dict:   '...'               不含 /Length、/Filter —— 由 PdfWriter 自动补
 *     stream: Uint8Array | null   有 stream 就是 stream 对象
 *   }
 *   PdfWriter.build() 负责：分配对象号、替换 @@KEY@@、压缩 stream、补 /Length /Filter。
 *   字体文件流额外带 /Length1（未压缩长度），已在 dict 里写好。
 *
 * ---------------------------------------------------------------------------
 * 四、已知限制
 * ---------------------------------------------------------------------------
 *   - 只做字形子集，不处理 kerning / ligature / variation / GSUB-GPOS（雅黑也没这些必要项）。
 *   - 不做伪粗体：bold 必须用 msyhbd 那些真字形。
 *   - cmap 解析支持 format 0/4/6/12，优先 (3,10)/(0,4) 的 format 12，其次 (3,1)/(0,3) 的 format 4。
 *   - 子集字体里 gid 顺序按“旧 gid 升序”重排，因此 CID == 新 gid（Identity-H + /CIDToGIDMap /Identity）。
 *   - fontFileBytes 是“合法可解析”的子集 TTF（重建 head/hhea/maxp/hmtx/loca/glyf/cmap/name/post/OS2），
 *     不是原文件切片，checksum 全对。
 * ============================================================================
 */
(function (global) {
  'use strict';

  /* ========================================================================
   * 0. 基础工具
   * ====================================================================== */

  function toBytes(input) {
    if (!input) throw new Error('PdfFont: 需要 ArrayBuffer 或 Uint8Array');
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    throw new Error('PdfFont: 不支持的字体数据类型');
  }

  function concatBytes(parts, total) {
    if (total == null) {
      total = 0;
      for (var i = 0; i < parts.length; i++) total += parts[i].length;
    }
    var out = new Uint8Array(total);
    var p = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], p);
      p += parts[j].length;
    }
    return out;
  }

  function pad4(n) { return (n + 3) & ~3; }

  /** 表/整文件的 OpenType checksum：大端 uint32 累加，尾部补 0 到 4 字节 */
  function checksumOf(bytes) {
    var sum = 0;
    var len = bytes.length;
    var i = 0;
    for (; i + 4 <= len; i += 4) {
      sum = (sum + (((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)) >>> 0;
    }
    if (i < len) {
      var v = 0;
      for (var k = 0; k < 4; k++) v |= (i + k < len ? bytes[i + k] : 0) << (24 - k * 8);
      sum = (sum + (v >>> 0)) >>> 0;
    }
    return sum >>> 0;
  }

  function tagToStr(bytes, off) {
    return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  }

  /* ========================================================================
   * 1. TTF 解析
   * ====================================================================== */

  function parseTtf(input) {
    var bytes = toBytes(input);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var sfntVersion = dv.getUint32(0);
    if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565 /* 'true' */) {
      throw new Error('PdfFont: 不是 TrueType (sfnt 0x' + sfntVersion.toString(16) + ')，请给 TTF 而不是 TTC/OTF-CFF');
    }
    var numTables = dv.getUint16(4);
    var tables = {};
    for (var i = 0; i < numTables; i++) {
      var rec = 12 + i * 16;
      var tag = tagToStr(bytes, rec);
      tables[tag] = {
        tag: tag,
        offset: dv.getUint32(rec + 8),
        length: dv.getUint32(rec + 12),
        checksum: dv.getUint32(rec + 4)
      };
    }
    var req = ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf'];
    for (var r = 0; r < req.length; r++) {
      if (!tables[req[r]]) throw new Error('PdfFont: 缺少必需表 ' + req[r]);
    }

    // ---- head
    var headOff = tables.head.offset;
    var unitsPerEm = dv.getUint16(headOff + 18);
    var indexToLocFormat = dv.getInt16(headOff + 50);
    var headBBox = {
      xMin: dv.getInt16(headOff + 36),
      yMin: dv.getInt16(headOff + 38),
      xMax: dv.getInt16(headOff + 40),
      yMax: dv.getInt16(headOff + 42)
    };

    // ---- hhea
    var hheaOff = tables.hhea.offset;
    var ascender = dv.getInt16(hheaOff + 4);
    var descender = dv.getInt16(hheaOff + 6);
    var lineGap = dv.getInt16(hheaOff + 8);
    var numberOfHMetrics = dv.getUint16(hheaOff + 34);

    // ---- maxp
    var maxpOff = tables.maxp.offset;
    var numGlyphs = dv.getUint16(maxpOff + 4);

    // ---- hmtx（全部解出来，雅黑 3 万字形 = 120KB 内存，可接受）
    var hmtxOff = tables.hmtx.offset;
    var advances = new Uint16Array(numGlyphs);
    var lsbs = new Int16Array(numGlyphs);
    var lastAdv = 0;
    for (var g = 0; g < numGlyphs; g++) {
      if (g < numberOfHMetrics) {
        lastAdv = dv.getUint16(hmtxOff + g * 4);
        advances[g] = lastAdv;
        lsbs[g] = dv.getInt16(hmtxOff + g * 4 + 2);
      } else {
        advances[g] = lastAdv;
        lsbs[g] = dv.getInt16(hmtxOff + numberOfHMetrics * 4 + (g - numberOfHMetrics) * 2);
      }
    }

    // ---- loca
    var locaOff = tables.loca.offset;
    var locaLong = indexToLocFormat !== 0;
    var glyfOff = tables.glyf.offset;
    var glyfLen = tables.glyf.length;

    function glyphRange(gid) {
      if (gid < 0 || gid >= numGlyphs) return null;
      var a, b;
      if (locaLong) {
        a = dv.getUint32(locaOff + gid * 4);
        b = dv.getUint32(locaOff + (gid + 1) * 4);
      } else {
        a = dv.getUint16(locaOff + gid * 2) * 2;
        b = dv.getUint16(locaOff + (gid + 1) * 2) * 2;
      }
      if (b <= a) return null; // 空字形
      if (a >= glyfLen) return null;
      if (b > glyfLen) b = glyfLen;
      return { start: glyfOff + a, end: glyfOff + b };
    }

    // ---- cmap
    var cmapMap = new Map();
    (function parseCmap() {
      var cOff = tables.cmap.offset;
      var n = dv.getUint16(cOff + 2);
      var candidates = [];
      for (var i2 = 0; i2 < n; i2++) {
        var o2 = cOff + 4 + i2 * 8;
        var pid = dv.getUint16(o2);
        var eid = dv.getUint16(o2 + 2);
        var sub = cOff + dv.getUint32(o2 + 4);
        var fmt = dv.getUint16(sub);
        var score = -1;
        if (pid === 3 && eid === 10) score = 100;       // Windows UCS-4
        else if (pid === 0 && (eid === 4 || eid === 6)) score = 90; // Unicode full
        else if (pid === 3 && eid === 1) score = 80;    // Windows BMP
        else if (pid === 0) score = 70;                 // Unicode BMP
        else if (pid === 3 && eid === 0) score = 10;    // symbol
        if (score < 0) continue;
        if (fmt !== 0 && fmt !== 4 && fmt !== 6 && fmt !== 12) score -= 50; // 不支持的格式降权
        candidates.push({ score: score + (fmt === 12 ? 5 : 0), sub: sub, fmt: fmt });
      }
      candidates.sort(function (a, b) { return b.score - a.score; });
      for (var c = 0; c < candidates.length; c++) {
        readSubtable(dv, candidates[c].sub, candidates[c].fmt, cmapMap);
        if (cmapMap.size > 0) break;
      }
    })();

    function glyphData(gid) {
      var range = glyphRange(gid);
      if (!range) return null;
      return bytes.slice(range.start, range.end);
    }

    function glyphBbox(gid) {
      var range = glyphRange(gid);
      if (!range) return null;
      var o = range.start;
      if (o + 10 > bytes.length) return null;
      return {
        xMin: dv.getInt16(o + 2),
        yMin: dv.getInt16(o + 4),
        xMax: dv.getInt16(o + 6),
        yMax: dv.getInt16(o + 8)
      };
    }

    function advance(gid) {
      if (gid < 0 || gid >= numGlyphs) return 0;
      return advances[gid];
    }

    function gidFor(cp) {
      var g = cmapMap.get(cp);
      return g || 0;
    }

    function hasCodePoint(cp) {
      return cmapMap.has(cp);
    }

    var cpsCache = null;
    function allCodepoints() {
      if (!cpsCache) {
        cpsCache = Array.from(cmapMap.keys()).sort(function (a, b) { return a - b; });
      }
      return cpsCache.slice();
    }

    // ---- name（拿 PostScript 名）
    var names = tables.name ? readNameTable(dv, tables.name.offset, tables.name.length) : {};

    // ---- OS/2（权重、capHeight）
    var os2 = null;
    if (tables['OS/2']) {
      var o2off = tables['OS/2'].offset;
      var o2len = tables['OS/2'].length;
      var ver = dv.getUint16(o2off);
      os2 = {
        version: ver,
        usWeightClass: dv.getUint16(o2off + 4),
        fsType: dv.getUint16(o2off + 8),
        sTypoAscender: dv.getInt16(o2off + 68),
        sTypoDescender: dv.getInt16(o2off + 70),
        sCapHeight: ver >= 2 && o2len >= 90 ? dv.getInt16(o2off + 88) : 0,
        usFirstCharIndex: dv.getUint16(o2off + 64),
        usLastCharIndex: dv.getUint16(o2off + 66)
      };
    }

    return {
      bytes: bytes,
      dv: dv,
      tables: tables,
      sfntVersion: sfntVersion,
      unitsPerEm: unitsPerEm,
      indexToLocFormat: indexToLocFormat,
      numGlyphs: numGlyphs,
      numberOfHMetrics: numberOfHMetrics,
      ascender: ascender,
      descender: descender,
      lineGap: lineGap,
      headBBox: headBBox,
      os2: os2,
      familyName: names.family || '',
      name: names.postscript || names.family || 'SubsetFont',
      cmapMap: cmapMap,
      gidFor: gidFor,
      hasCodePoint: hasCodePoint,
      advance: advance,
      advanceWidth: advance,
      lsb: function (gid) { return (gid >= 0 && gid < numGlyphs) ? lsbs[gid] : 0; },
      glyphData: glyphData,
      glyphBbox: glyphBbox,
      allCodepoints: allCodepoints,
      glyphRange: glyphRange
    };
  }

  function readSubtable(dv, off, fmt, map) {
    try {
      if (fmt === 4) {
        var segCountX2 = dv.getUint16(off + 6);
        var segCount = segCountX2 >> 1;
        var endOff = off + 14;
        var startOff = endOff + segCountX2 + 2;
        var deltaOff = startOff + segCountX2;
        var rangeOff = deltaOff + segCountX2;
        var glyphArrayOff = rangeOff + segCountX2;
        var total = dv.byteLength;
        for (var i = 0; i < segCount; i++) {
          var end = dv.getUint16(endOff + i * 2);
          var start = dv.getUint16(startOff + i * 2);
          var delta = dv.getInt16(deltaOff + i * 2);
          var ro = dv.getUint16(rangeOff + i * 2);
          if (start > end) continue;
          if (start === 0xFFFF && end === 0xFFFF) continue;
          for (var c = start; c <= end; c++) {
            var gid;
            if (ro === 0) {
              gid = (c + delta) & 0xFFFF;
            } else {
              var addr = rangeOff + i * 2 + ro + (c - start) * 2;
              if (addr + 1 >= total) continue;
              gid = dv.getUint16(addr);
              if (gid !== 0) gid = (gid + delta) & 0xFFFF;
            }
            if (gid) map.set(c, gid);
          }
        }
        void glyphArrayOff;
      } else if (fmt === 12) {
        var nGroups = dv.getUint32(off + 12);
        var p = off + 16;
        for (var k = 0; k < nGroups; k++) {
          var s = dv.getUint32(p);
          var e = dv.getUint32(p + 4);
          var sg = dv.getUint32(p + 8);
          p += 12;
          if (e < s || e - s > 0x20000) continue;
          for (var cp = s; cp <= e; cp++) {
            var gg = sg + (cp - s);
            if (gg) map.set(cp, gg);
          }
        }
      } else if (fmt === 6) {
        var first = dv.getUint16(off + 6);
        var count = dv.getUint16(off + 8);
        for (var m = 0; m < count; m++) {
          var g6 = dv.getUint16(off + 10 + m * 2);
          if (g6) map.set(first + m, g6);
        }
      } else if (fmt === 0) {
        for (var z = 0; z < 256; z++) {
          var g0 = dv.getUint8(off + 6 + z);
          if (g0) map.set(z, g0);
        }
      }
    } catch (err) {
      // 坏表就当没有
    }
  }

  function readNameTable(dv, off, len) {
    var out = {};
    try {
      var count = dv.getUint16(off + 2);
      var strOff = off + dv.getUint16(off + 4);
      var best = {}; // nid -> {score, val}
      for (var i = 0; i < count; i++) {
        var rec = off + 6 + i * 12;
        var pid = dv.getUint16(rec);
        var eid = dv.getUint16(rec + 2);
        var lid = dv.getUint16(rec + 4);
        var nid = dv.getUint16(rec + 6);
        var nlen = dv.getUint16(rec + 8);
        var soff = dv.getUint16(rec + 10);
        if (nid !== 1 && nid !== 6) continue;
        var abs = strOff + soff;
        if (abs + nlen > off + len) continue;
        var s = '';
        var wide = (pid === 3) || (pid === 0 && eid >= 3);
        if (wide) {
          for (var k = 0; k + 1 < nlen; k += 2) s += String.fromCharCode(dv.getUint16(abs + k));
        } else {
          for (var k2 = 0; k2 < nlen; k2++) s += String.fromCharCode(dv.getUint8(abs + k2));
        }
        var score = (pid === 3 && lid === 0x409) ? 3 : (pid === 3 ? 2 : 1);
        var key = nid === 6 ? 'postscript' : 'family';
        if (!best[key] || best[key].score < score) best[key] = { score: score, val: s };
      }
      for (var kk in best) out[kk] = best[kk].val;
    } catch (err) { /* ignore */ }
    return out;
  }

  /* ========================================================================
   * 2. 子集收集
   * ====================================================================== */

  /** 读 composite glyph 的子 glyph 列表 */
  function compositeChildren(data) {
    var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    var nc = dv.getInt16(0);
    if (nc >= 0) return null;
    var out = [];
    var p = 10;
    var guard = 0;
    while (p + 4 <= data.length && guard++ < 4096) {
      var flags = dv.getUint16(p);
      var gid = dv.getUint16(p + 2);
      p += 4;
      if (flags & 0x0001) p += 4;       // ARG_1_AND_2_ARE_WORDS
      else p += 2;
      if (flags & 0x0008) p += 2;       // WE_HAVE_A_SCALE
      else if (flags & 0x0040) p += 4;  // WE_HAVE_AN_X_AND_Y_SCALE
      else if (flags & 0x0080) p += 8;  // WE_HAVE_A_TWO_BY_TWO
      out.push(gid);
      if (!(flags & 0x0020)) break;     // MORE_COMPONENTS
    }
    return out;
  }

  function subsetForText(font, text) {
    var set = new Set();
    set.add(0);
    var chars = [];
    var seen = new Set();
    var str = String(text == null ? '' : text);
    var iter = str[Symbol.iterator] ? str[Symbol.iterator]() : null;
    var cps = [];
    if (iter) {
      for (var step = iter.next(); !step.done; step = iter.next()) {
        var ch = step.value;
        var cp = ch.codePointAt(0);
        cps.push({ cp: cp, ch: ch });
      }
    } else {
      for (var i = 0; i < str.length; i++) {
        var cp2 = str.codePointAt(i);
        if (cp2 > 0xFFFF) i++;
        cps.push({ cp: cp2, ch: String.fromCodePoint(cp2) });
      }
    }

    var pairs = [];
    for (var j = 0; j < cps.length; j++) {
      var cp3 = cps[j].cp;
      if (seen.has(cp3)) continue;
      seen.add(cp3);
      var gid = font.gidFor(cp3);
      if (!gid) continue;
      set.add(gid);
      chars.push(cps[j].ch);
      pairs.push({ cp: cp3, gid: gid });
    }

    // composite glyph 递归展开
    var queue = Array.from(set);
    var guard = 0;
    while (queue.length && guard++ < 100000) {
      var g = queue.pop();
      if (g === 0) continue;
      var data = font.glyphData(g);
      if (!data) continue;
      var kids = compositeChildren(data);
      if (!kids) continue;
      for (var k = 0; k < kids.length; k++) {
        if (!set.has(kids[k])) {
          set.add(kids[k]);
          queue.push(kids[k]);
        }
      }
    }

    // 新 gid 顺序：旧 gid 升序（0 恒为 0）
    var gids = Array.from(set).filter(function (x) { return x >= 0 && x < font.numGlyphs; });
    gids.sort(function (a, b) { return a - b; });
    if (gids[0] !== 0) gids.unshift(0);
    var order = gids.slice();
    var origToNew = new Map();
    for (var o = 0; o < order.length; o++) origToNew.set(order[o], o);

    var mapping = { map: new Map(), order: order };
    for (var p2 = 0; p2 < pairs.length; p2++) {
      var item = {
        cp: pairs[p2].cp,
        gid: pairs[p2].gid,
        newGid: origToNew.get(pairs[p2].gid) || 0
      };
      mapping[pairs[p2].cp] = item;
      mapping.map.set(pairs[p2].cp, item);
    }

    return {
      gids: gids,
      order: order,
      origToNew: origToNew,
      mapping: mapping,
      chars: chars,
      text: str
    };
  }

  /* ========================================================================
   * 3. 重建子集 TTF（核心：合法二进制 + 正确 checksum）
   * ====================================================================== */

  function buildCmapTable(pairs) {
    var bmp = [];
    var all = pairs.slice().sort(function (a, b) { return a.cp - b.cp; });
    for (var i = 0; i < all.length; i++) if (all[i].cp <= 0xFFFF) bmp.push(all[i]);

    // ---------- format 4 ----------
    var runs = [];
    for (var b = 0; b < bmp.length; b++) {
      var last = runs[runs.length - 1];
      if (last && bmp[b].cp === last.end + 1) {
        last.end = bmp[b].cp;
        last.items.push(bmp[b]);
      } else {
        runs.push({ start: bmp[b].cp, end: bmp[b].cp, items: [bmp[b]] });
      }
    }
    // 每个 run 决定用 idDelta 还是 glyphIdArray
    var segs = [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var delta = (run.items[0].gid - run.start) & 0xFFFF;
      var uniform = true;
      for (var q = 1; q < run.items.length; q++) {
        if (((run.items[q].gid - run.items[q].cp) & 0xFFFF) !== delta) { uniform = false; break; }
      }
      segs.push({ start: run.start, end: run.end, delta: uniform ? delta : 0, items: run.items, uniform: uniform });
    }
    // 结束符段
    var term = { start: 0xFFFF, end: 0xFFFF, delta: 1, items: [], uniform: true, term: true };
    if (!segs.length || segs[segs.length - 1].end !== 0xFFFF) segs.push(term);
    else segs[segs.length - 1] = term;

    var segCount = segs.length;
    // glyphIdArray
    var gia = [];
    for (var s = 0; s < segCount; s++) {
      var seg = segs[s];
      if (seg.term) continue;
      if (!seg.uniform) {
        seg.giaStart = gia.length;
        for (var u = 0; u < seg.items.length; u++) gia.push(seg.items[u].gid);
      }
    }
    var f4len = 16 + segCount * 8 + gia.length * 2;
    var f4 = new Uint8Array(f4len);
    var d4 = new DataView(f4.buffer);
    d4.setUint16(0, 4);
    d4.setUint16(2, f4len);
    d4.setUint16(4, 0);
    d4.setUint16(6, segCount * 2);
    var sr = 2, ee = 0;
    while (sr * 2 <= segCount * 2) { sr *= 2; ee++; }
    d4.setUint16(8, sr);
    d4.setUint16(10, ee);
    d4.setUint16(12, segCount * 2 - sr);
    var endOff = 14;
    var startOff = endOff + segCount * 2 + 2;
    var deltaOff = startOff + segCount * 2;
    var rangeOff = deltaOff + segCount * 2;
    var giaOff = rangeOff + segCount * 2;
    for (var i2 = 0; i2 < segCount; i2++) {
      var sg = segs[i2];
      d4.setUint16(endOff + i2 * 2, sg.end);
      d4.setUint16(startOff + i2 * 2, sg.start);
      d4.setInt16(deltaOff + i2 * 2, sg.delta | 0);
      var ro = 0;
      if (!sg.uniform && !sg.term) {
        ro = (giaOff + sg.giaStart * 2) - (rangeOff + i2 * 2);
        ro &= 0xFFFF;
      }
      d4.setUint16(rangeOff + i2 * 2, ro);
    }
    for (var i3 = 0; i3 < gia.length; i3++) d4.setUint16(giaOff + i3 * 2, gia[i3]);

    // ---------- format 12 ----------
    var groups = [];
    for (var a = 0; a < all.length; a++) {
      var lg = groups[groups.length - 1];
      if (lg && all[a].cp === lg.end + 1 && all[a].gid === lg.gid + (all[a].cp - lg.start)) {
        lg.end = all[a].cp;
      } else {
        groups.push({ start: all[a].cp, end: all[a].cp, gid: all[a].gid });
      }
    }
    var f12len = 16 + groups.length * 12;
    var f12 = new Uint8Array(f12len);
    var d12 = new DataView(f12.buffer);
    d12.setUint16(0, 12);
    d12.setUint16(2, 0);
    d12.setUint32(4, f12len);
    d12.setUint32(8, 0);
    d12.setUint32(12, groups.length);
    for (var g2 = 0; g2 < groups.length; g2++) {
      d12.setUint32(16 + g2 * 12, groups[g2].start);
      d12.setUint32(20 + g2 * 12, groups[g2].end);
      d12.setUint32(24 + g2 * 12, groups[g2].gid);
    }

    // ---------- cmap 头 + 编码记录 ----------
    var sub4Off = 4 + 4 * 8;
    var sub12Off = sub4Off + f4len;
    var total = sub12Off + f12len;
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint16(0, 0);
    dv.setUint16(2, 4);
    // 按 platformID/encodingID 排序: (0,3) (0,4) (3,1) (3,10)
    var recs = [
      [0, 3, sub4Off],
      [0, 4, sub12Off],
      [3, 1, sub4Off],
      [3, 10, sub12Off]
    ];
    for (var rr = 0; rr < recs.length; rr++) {
      var o12 = 4 + rr * 8;
      dv.setUint16(o12, recs[rr][0]);
      dv.setUint16(o12 + 2, recs[rr][1]);
      dv.setUint32(o12 + 4, recs[rr][2]);
    }
    out.set(f4, sub4Off);
    out.set(f12, sub12Off);
    return out;
  }

  function assembleSfnt(tableList) {
    var sorted = tableList.slice().sort(function (a, b) {
      return a.tag < b.tag ? -1 : (a.tag > b.tag ? 1 : 0);
    });
    var n = sorted.length;
    var headerLen = 12 + n * 16;
    var offsets = [];
    var total = headerLen;
    for (var i = 0; i < n; i++) {
      offsets.push(total);
      total += pad4(sorted[i].data.length);
    }
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, 0x00010000);

    var sr = 1, es = 0;
    while (sr * 2 <= n) { sr *= 2; es++; }
    sr *= 16;
    dv.setUint16(4, n);
    dv.setUint16(6, sr);
    dv.setUint16(8, es);
    dv.setUint16(10, n * 16 - sr);

    var headFileOff = -1;
    for (var j = 0; j < n; j++) {
      var rec = 12 + j * 16;
      var tag = sorted[j].tag;
      for (var k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
      dv.setUint32(rec + 4, checksumOf(sorted[j].data));
      dv.setUint32(rec + 8, offsets[j]);
      dv.setUint32(rec + 12, sorted[j].data.length);
      out.set(sorted[j].data, offsets[j]);
      if (tag === 'head') headFileOff = offsets[j];
    }
    // checkSumAdjustment
    if (headFileOff >= 0) {
      dv.setUint32(headFileOff + 8, 0);
      var sum = checksumOf(out);
      dv.setUint32(headFileOff + 8, (0xB1B0AFBA - sum) >>> 0);
    }
    return out;
  }

  function buildSubsetTtf(font, order, pairs) {
    var n = order.length;
    var i;

    // ---- glyf + loca
    var parts = [];
    var locaOffsets = new Uint32Array(n + 1);
    var pos = 0;
    for (i = 0; i < n; i++) {
      locaOffsets[i] = pos;
      var gd = font.glyphData(order[i]);
      if (gd && gd.length) {
        parts.push(gd);
        pos += gd.length;
        if (gd.length & 1) {
          parts.push(new Uint8Array(1));
          pos += 1;
        }
      }
    }
    locaOffsets[n] = pos;
    var glyf = parts.length ? concatBytes(parts, pos) : new Uint8Array(0);

    var shortLoca = pos <= 0xFFFF * 2;
    var loca = new Uint8Array(shortLoca ? (n + 1) * 2 : (n + 1) * 4);
    var dvl = new DataView(loca.buffer);
    for (i = 0; i <= n; i++) {
      if (shortLoca) dvl.setUint16(i * 2, locaOffsets[i] >> 1);
      else dvl.setUint32(i * 4, locaOffsets[i]);
    }

    // ---- hmtx（numberOfMetrics = numGlyphs，全 4 字节长条目）
    var hmtx = new Uint8Array(n * 4);
    var dvh = new DataView(hmtx.buffer);
    for (i = 0; i < n; i++) {
      dvh.setUint16(i * 4, font.advance(order[i]) & 0xFFFF);
      var bb = font.glyphBbox(order[i]);
      var lsb = bb ? bb.xMin : font.lsb(order[i]);
      dvh.setInt16(i * 4 + 2, lsb | 0);
    }

    // ---- head
    var headSrc = font.tables.head;
    var head = font.bytes.slice(headSrc.offset, headSrc.offset + Math.min(headSrc.length, 54));
    if (head.length < 54) {
      var h2 = new Uint8Array(54);
      h2.set(head);
      head = h2;
    }
    var dvhead = new DataView(head.buffer, head.byteOffset, head.byteLength);
    dvhead.setUint32(8, 0);                       // checkSumAdjustment 归零（后面 assembleSfnt 重算）
    dvhead.setInt16(50, shortLoca ? 0 : 1);       // indexToLocFormat 与实际 loca 一致
    // 注意：offset 46 (lowestRecPPEM) 保持原值，不要动

    // ---- hhea
    var hheaSrc = font.tables.hhea;
    var hhea = font.bytes.slice(hheaSrc.offset, hheaSrc.offset + Math.min(hheaSrc.length, 36));
    if (hhea.length < 36) { var h3 = new Uint8Array(36); h3.set(hhea); hhea = h3; }
    new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, n);

    // ---- maxp
    var maxpSrc = font.tables.maxp;
    var maxp = font.bytes.slice(maxpSrc.offset, maxpSrc.offset + maxpSrc.length);
    new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, n);

    // ---- cmap
    var cmap = buildCmapTable(pairs);

    // ---- name（原样保留，PDF /BaseFont 叫名字对得上就行）
    var nameSrc = font.tables.name;
    var name = nameSrc ? font.bytes.slice(nameSrc.offset, nameSrc.offset + nameSrc.length) : new Uint8Array(6);

    // ---- post（强制 3.0，32 字节）
    var postSrc = font.tables.post;
    var post = new Uint8Array(32);
    post.set([0, 3, 0, 0]);
    if (postSrc && postSrc.length >= 32) {
      post.set(font.bytes.slice(postSrc.offset, postSrc.offset + 32));
      post[0] = 0; post[1] = 3; post[2] = 0; post[3] = 0;
    }

    // ---- OS/2（原样，更新 first/last char）
    var tablesOut = [
      { tag: 'head', data: head },
      { tag: 'hhea', data: hhea },
      { tag: 'maxp', data: maxp },
      { tag: 'hmtx', data: hmtx },
      { tag: 'loca', data: loca },
      { tag: 'glyf', data: glyf },
      { tag: 'cmap', data: cmap },
      { tag: 'name', data: name },
      { tag: 'post', data: post }
    ];
    var os2Src = font.tables['OS/2'];
    if (os2Src) {
      var os2 = font.bytes.slice(os2Src.offset, os2Src.offset + os2Src.length);
      if (os2.length >= 68) {
        var dvo = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
        var minCp = 0xFFFF, maxCp = 0;
        for (var pp = 0; pp < pairs.length; pp++) {
          if (pairs[pp].cp > 0xFFFF) continue;
          if (pairs[pp].cp < minCp) minCp = pairs[pp].cp;
          if (pairs[pp].cp > maxCp) maxCp = pairs[pp].cp;
        }
        if (minCp === 0xFFFF) minCp = 0x20;
        dvo.setUint16(64, minCp);
        dvo.setUint16(66, maxCp);
      }
      tablesOut.push({ tag: 'OS/2', data: os2 });
    }

    return assembleSfnt(tablesOut);
  }

  /* ========================================================================
   * 4. PDF 字体对象
   * ====================================================================== */

  function sanitizePostScriptName(name) {
    var s = String(name || 'SubsetFont').replace(/[^A-Za-z0-9]/g, '');
    if (!s) s = 'SubsetFont';
    if (/^[0-9]/.test(s)) s = 'F' + s;
    return s.slice(0, 40);
  }

  function hashTag6(pairs) {
    var h = 0x811c9dc5;
    for (var i = 0; i < pairs.length; i++) {
      h ^= pairs[i].cp & 0xFF;
      h = (h * 0x01000193) >>> 0;
      h ^= (pairs[i].cp >>> 8) & 0xFF;
      h = (h * 0x01000193) >>> 0;
      h ^= pairs[i].gid & 0xFF;
      h = (h * 0x01000193) >>> 0;
    }
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var out = '';
    for (var k = 0; k < 6; k++) {
      out += letters[(h >>> (k * 5)) % 26];
      h = (h * 31 + 7) >>> 0;
    }
    return out;
  }

  function num(v) {
    if (!isFinite(v)) return '0';
    var r = Math.round(v * 1000) / 1000;
    return String(r);
  }

  function hexUtf16BE(cp) {
    if (cp <= 0xFFFF) {
      return ('0000' + cp.toString(16).toUpperCase()).slice(-4);
    }
    var v = cp - 0x10000;
    var hi = 0xD800 + (v >> 10);
    var lo = 0xDC00 + (v & 0x3FF);
    return ('0000' + hi.toString(16).toUpperCase()).slice(-4) +
           ('0000' + lo.toString(16).toUpperCase()).slice(-4);
  }

  function makeToUnicodeCMap(list) {
    var head = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange'
    ];
    var body = [];
    var chunk = 100;
    for (var i = 0; i < list.length; i += chunk) {
      var slice = list.slice(i, i + chunk);
      body.push(slice.length + ' beginbfchar');
      for (var j = 0; j < slice.length; j++) {
        body.push('<' + ('0000' + slice[j].cid.toString(16).toUpperCase()).slice(-4) + '> <' +
          hexUtf16BE(slice[j].cp) + '>');
      }
      body.push('endbfchar');
    }
    var tail = ['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'];
    return (head.concat(body, tail).join('\n') + '\n');
  }

  function textToBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }

  function buildPdfFont(font, subset, opts) {
    opts = opts || {};
    var upem = font.unitsPerEm;

    // 兼容：传 mapping 对象也行
    if (!subset || !subset.order) {
      var m = subset || {};
      var gidsSet = new Set([0]);
      var pairs0 = [];
      var keys = m.map ? Array.from(m.map.keys()) : Object.keys(m).filter(function (k) { return k !== 'map' && k !== 'order'; });
      for (var i0 = 0; i0 < keys.length; i0++) {
        var it = m.map ? m.map.get(keys[i0]) : m[keys[i0]];
        if (!it) continue;
        gidsSet.add(it.gid);
        pairs0.push({ cp: it.cp, gid: it.gid });
      }
      var order0 = Array.from(gidsSet).sort(function (a, b) { return a - b; });
      var o2n = new Map();
      for (var k0 = 0; k0 < order0.length; k0++) o2n.set(order0[k0], k0);
      var mapping0 = { map: new Map(), order: order0 };
      for (var p0 = 0; p0 < pairs0.length; p0++) {
        var item0 = { cp: pairs0[p0].cp, gid: pairs0[p0].gid, newGid: o2n.get(pairs0[p0].gid) || 0 };
        mapping0[pairs0[p0].cp] = item0;
        mapping0.map.set(pairs0[p0].cp, item0);
      }
      subset = { order: order0, mapping: mapping0, gids: order0, origToNew: o2n };
    }

    var order = subset.order;
    var mapping = subset.mapping;
    var pairs = [];
    mapping.map.forEach(function (v) {
      pairs.push({ cp: v.cp, gid: v.newGid });
    });
    pairs.sort(function (a, b) { return a.cp - b.cp; });

    // ---- 新字体二进制
    var fontFileBytes = buildSubsetTtf(font, order, pairs);

    // ---- 名字
    var psName = sanitizePostScriptName(font.name || font.familyName);
    var tag6 = hashTag6(pairs);
    var baseFont = tag6 + '+' + psName;

    // ---- 宽度（1/1000 字号）
    var widths = {};
    var widthGroups = [];
    var maxGid = order.length - 1;
    var curStart = -1, curEnd = -1, curW = null;
    for (var g = 0; g <= maxGid; g++) {
      var w = Math.round(font.advance(order[g]) * 1000 / upem);
      widths[g] = w;
      if (curStart < 0) { curStart = g; curEnd = g; curW = w; }
      else if (g === curEnd + 1 && w === curW) { curEnd = g; }
      else {
        widthGroups.push([curStart, curEnd, curW]);
        curStart = g; curEnd = g; curW = w;
      }
    }
    if (curStart >= 0) widthGroups.push([curStart, curEnd, curW]);

    var wParts = [];
    for (var wi = 0; wi < widthGroups.length; wi++) {
      var grp = widthGroups[wi];
      if (grp[0] === grp[1]) wParts.push(grp[0] + ' [' + grp[2] + ']');
      else wParts.push(grp[0] + ' ' + grp[1] + ' ' + grp[2]);
    }
    var widthsArray = wParts.join(' ');

    // ---- ToUnicode（CID == newGid）
    var uniList = [];
    mapping.map.forEach(function (v) {
      if (v.newGid > 0) uniList.push({ cid: v.newGid, cp: v.cp });
    });
    uniList.sort(function (a, b) { return a.cid - b.cid; });
    var toUnicodeCmap = makeToUnicodeCMap(uniList);

    // ---- Descriptor 数值
    var scale = 1000 / upem;
    var bbox = font.headBBox;
    var ascent = Math.round(font.ascender * scale);
    var descent = Math.round(font.descender * scale);
    var capHeight = font.os2 && font.os2.sCapHeight ? Math.round(font.os2.sCapHeight * scale)
      : Math.round((font.ascender * 0.7) * scale);
    var weight = font.os2 ? font.os2.usWeightClass : 400;
    var stemV = weight < 500 ? 80 : (weight < 700 ? 120 : 165);
    var flags = 4; // Symbolic（CID 字体惯例；非等宽、非衬线、非斜体）
    if (weight >= 600) flags |= 0x40000; // ForceBold

    var avgWidth = 0;
    for (var ag = 0; ag < order.length; ag++) avgWidth += font.advance(order[ag]);
    avgWidth = order.length ? avgWidth / order.length : upem / 2;

    var keyBase = String(opts.name || 'F1');
    var K = {
      type0: keyBase + '_' + tag6 + '_TYPE0',
      cid: keyBase + '_' + tag6 + '_CID',
      desc: keyBase + '_' + tag6 + '_DESC',
      file: keyBase + '_' + tag6 + '_FILE',
      tounicode: keyBase + '_' + tag6 + '_TOUNI'
    };

    var type0Dict =
      '<< /Type /Font /Subtype /Type0 /BaseFont /' + baseFont +
      ' /Encoding /Identity-H /DescendantFonts [@@' + K.cid + '@@]' +
      ' /ToUnicode @@' + K.tounicode + '@@ >>';

    var cidFontDict =
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + baseFont +
      ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>' +
      ' /FontDescriptor @@' + K.desc + '@@ /CIDToGIDMap /Identity /DW 1000' +
      ' /W [' + widthsArray + '] >>';

    var descriptor =
      '<< /Type /FontDescriptor /FontName /' + baseFont +
      ' /Flags ' + flags +
      ' /FontBBox [' + Math.round(bbox.xMin * scale) + ' ' + Math.round(bbox.yMin * scale) + ' ' +
      Math.round(bbox.xMax * scale) + ' ' + Math.round(bbox.yMax * scale) + ']' +
      ' /ItalicAngle 0 /Ascent ' + ascent + ' /Descent ' + descent +
      ' /CapHeight ' + capHeight + ' /StemV ' + stemV + ' /AvgWidth ' + Math.round(upem ? (avgWidth * 1000 / upem) : 500) +
      ' /MissingWidth 1000 /FontFile2 @@' + K.file + '@@ >>';

    var hexCache = new Map();

    function cidFor(cp) {
      var it = mapping.map.get(cp);
      if (it && it.newGid) return it.newGid;
      // 缺失：回落到 '?'
      var q = mapping.map.get(0x3F);
      if (q && q.newGid) return q.newGid;
      return 0;
    }

    function hex(str) {
      var s = String(str == null ? '' : str);
      var out = '';
      for (var i = 0; i < s.length; i++) {
        var cp = s.codePointAt(i);
        if (cp > 0xFFFF) i++;
        out += ('0000' + cidFor(cp).toString(16).toUpperCase()).slice(-4);
      }
      return '<' + out + '>';
    }

    function measure(str, sizePt) {
      var s = String(str == null ? '' : str);
      var total = 0;
      for (var i = 0; i < s.length; i++) {
        var cp = s.codePointAt(i);
        if (cp > 0xFFFF) i++;
        var it = mapping.map.get(cp);
        var gid = it ? it.gid : 0;
        total += font.advance(gid);
      }
      return total * sizePt / upem;
    }

    /**
     * 列出 str 里【子集之外】的字符（会退化成 .notdef / 方框）。
     * report-export.js 建议在 build 之前对所有要画的文字跑一遍，非空就补进 prepare 的 allText。
     */
    function missing(str) {
      var s = String(str == null ? '' : str);
      var out = [];
      var seenMiss = new Set();
      for (var i = 0; i < s.length; i++) {
        var cp = s.codePointAt(i);
        if (cp > 0xFFFF) i++;
        var it = mapping.map.get(cp);
        if (!it || !it.newGid) {
          if (!seenMiss.has(cp)) { seenMiss.add(cp); out.push(String.fromCodePoint(cp)); }
        }
      }
      return out;
    }

    /** 缺字数（0 = 全部可画） */
    function missingCount(str) { return missing(str).length; }

    function objects() {
      return [
        { key: K.type0, dict: type0Dict, stream: null },
        { key: K.cid, dict: cidFontDict, stream: null },
        { key: K.desc, dict: descriptor, stream: null },
        {
          key: K.file,
          dict: '/Length1 ' + fontFileBytes.length,
          stream: fontFileBytes
        },
        {
          key: K.tounicode,
          dict: '',
          stream: textToBytes(toUnicodeCmap)
        }
      ];
    }

    return {
      baseFont: baseFont,
      subsetTag: tag6,
      tag6: tag6,
      psName: psName,
      newGidCount: order.length,
      order: order,
      mapping: mapping,
      origToNew: subset.origToNew || null,
      type0Dict: type0Dict,
      cidFontDict: cidFontDict,
      descriptor: descriptor,
      fontFileBytes: fontFileBytes,
      widths: widths,
      widthsArray: widthsArray,
      toUnicodeCmap: toUnicodeCmap,
      keys: K,
      objects: objects,
      cidFor: cidFor,
      hex: hex,
      encode: hex,
      measure: measure,
      missing: missing,
      missingCount: missingCount,
      advance1000: function (gid) { return widths[gid] || 0; },
      hmtxCount: order.length,
      unitsPerEm: upem
    };
  }

  /**
   * 把文本转成 Identity-H 两字节 hex 串（不含 <> 包裹？—— 含，直接塞进 Tj 用的 <>）
   * 传 mapping（subsetForText 的 mapping）或 faces 对象都行。
   */
  function encodeText(cidMapping, text) {
    if (!text && typeof cidMapping === 'string') return '';
    var map = null;
    if (cidMapping && cidMapping.mapping) map = cidMapping.mapping.map || cidMapping.mapping;
    else if (cidMapping && cidMapping.map) map = cidMapping.map;
    else map = cidMapping;
    function get(cp) {
      if (map instanceof Map) {
        var v = map.get(cp);
        return v ? v.newGid : 0;
      }
      var v2 = map[cp];
      return v2 ? v2.newGid : 0;
    }
    var qGid = get(0x3F) || 0;
    var s = String(text == null ? '' : text);
    var out = '<';
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;
      var gid = get(cp) || qGid;
      out += ('0000' + gid.toString(16).toUpperCase()).slice(-4);
    }
    return out + '>';
  }

  /* ========================================================================
   * 5. 门面：load / prepare
   * ====================================================================== */

  var loadCache = new Map();

  function load(urlOrBytes) {
    if (typeof urlOrBytes === 'string') {
      if (loadCache.has(urlOrBytes)) return loadCache.get(urlOrBytes);
      var p = fetch(urlOrBytes)
        .then(function (res) {
          if (!res.ok) throw new Error('PdfFont: 取字体失败 ' + res.status + ' ' + urlOrBytes);
          return res.arrayBuffer();
        })
        .then(function (ab) { return parseTtf(ab); });
      loadCache.set(urlOrBytes, p);
      p.catch(function () { loadCache.delete(urlOrBytes); });
      return p;
    }
    return Promise.resolve(parseTtf(urlOrBytes));
  }

  function prepare(font, allText, opts) {
    opts = opts || {};
    var sub = subsetForText(font, allText || '');
    var built = buildPdfFont(font, sub, { name: opts.name || 'F1' });
    built.name = opts.name || 'F1';
    built.font = font;
    built.subset = sub;
    return Promise.resolve(built);
  }

  /* ========================================================================
   * 6. 自测（浏览器控制台 / Node 都能跑）
   * ====================================================================== */

  function selftest(fontBytes, text, opts) {
    opts = opts || {};
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var font = parseTtf(fontBytes);
    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var sample = text || '陕西源动创科（11月18日房源汇总） 0123456789 / ㎡';
    var sub = subsetForText(font, sample);
    var t2 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var built = buildPdfFont(font, sub, { name: opts.name || 'F1' });
    var t3 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var roundtrip = parseTtf(built.fontFileBytes); // 子集字体自身可再解析 = 合法
    var hex = built.hex(sample);
    return {
      fontName: font.name,
      family: font.familyName,
      unitsPerEm: font.unitsPerEm,
      numGlyphs: font.numGlyphs,
      cmapSize: font.cmapMap.size,
      subsetGlyphs: sub.order.length,
      subsetFontBytes: built.fontFileBytes.length,
      baseFont: built.baseFont,
      widthsArrayLen: built.widthsArray.length,
      hexHead: hex.slice(0, 40),
      measurePt: built.measure(sample, 12),
      subsetNumGlyphs: roundtrip.numGlyphs,
      subsetCmapSize: roundtrip.cmapMap.size,
      subsetRoundtripOk: roundtrip.numGlyphs === sub.order.length,
      missingInFont: Array.from(new Set(Array.from(sample).filter(function (ch) { return !font.hasCodePoint(ch.codePointAt(0)); }))),
      msParse: +(t1 - t0).toFixed(1),
      msSubset: +(t2 - t1).toFixed(1),
      msBuild: +(t3 - t2).toFixed(1)
    };
  }

  /* ========================================================================
   * 7. 导出
   * ====================================================================== */

  var PdfFont = {
    version: '1.0.0',
    // 门面
    load: load,
    prepare: prepare,
    // 底层
    parseTtf: parseTtf,
    parse: parseTtf,
    subsetForText: subsetForText,
    buildPdfFont: buildPdfFont,
    buildSubsetTtf: buildSubsetTtf,
    encodeText: encodeText,
    selftest: selftest,
    // 工具
    utils: {
      toBytes: toBytes,
      checksumOf: checksumOf,
      concatBytes: concatBytes
    }
  };

  global.PdfFont = PdfFont;
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfFont;

  /* ========================================================================
   * 8. Node 自测入口（浏览器里会跳过；扩展里不受影响）
   *    node pdf-font.js [字体路径] [输出PDF路径]
   * ====================================================================== */
  if (typeof module !== 'undefined' && typeof require === 'function' && require.main === module) {
    (function runNodeSelftest() {
      var fs = require('fs');
      var pathMod = require('path');
      var dir = __dirname;
      var fontPath = process.argv[2] || pathMod.join(dir, 'fonts', 'msyh-cjk.ttf');
      var boldPath = pathMod.join(dir, 'fonts', 'msyhbd-cjk.ttf');
      var outPath = process.argv[3] || pathMod.join(process.cwd(), 'font_test.pdf');
      try {
        // pdf-writer.js 与 pdf-font.js 同目录
        var PdfWriter = require(pathMod.join(dir, 'pdf-writer.js'));
        var fontR = parseTtf(fs.readFileSync(fontPath));
        var fontB = fs.existsSync(boldPath) ? parseTtf(fs.readFileSync(boldPath)) : fontR;
        var title = '陕西源动创科（11月18日房源汇总）';
        var texts = [title, '生成日期：2026年11月18日  共计 3 条',
          '序号', '小区名称', '面积', '起拍价', '评估价', '单位',
          '合计：3 套，建筑面积 373.7㎡，起拍价合计 316.80 万元',
          '数据来源：人民法院诉讼资产网', '万元',
          '西安市雁塔区某小区 3-2-1801', '128.5㎡', '142.00', '/',
          '西安市未央区某小区 8-1-902', '89.0㎡', '98.50', '/',
          '咸阳市秦都区某小区 12-3-401', '156.2㎡', '76.30', '/'];
        var all = texts.join('') + '0123456789./㎡（）%,:；、-';
        Promise.all([prepare(fontR, all, { name: 'F1' }), prepare(fontB, all, { name: 'F2' })])
          .then(function (pair) {
            var facesR = pair[0], facesB = pair[1];
            var missR = [], missB = [];
            texts.forEach(function (t) {
              var m = facesR.missing(t); if (m.length) missR.push(t + ':' + m.join(''));
              var m2 = facesB.missing(t); if (m2.length) missB.push(t + ':' + m2.join(''));
            });
            var pdf = PdfWriter.create({ width: 595, height: 842, title: title, author: '法拍插件' });
            var page = pdf.addPage();
            page.font(facesR);
            page.font(facesB, { bold: true });
            page.text(title, 40, 60, { size: 18, bold: true });
            page.text(texts[1], 40, 84, { size: 10, color: [90, 90, 90] });
            page.line(40, 96, 555, 96, { color: [180, 180, 180], width: 0.75 });
            var cols = [40, 90, 320, 390, 450, 510];
            ['序号', '小区名称', '面积', '起拍价', '评估价', '单位'].forEach(function (h, i) {
              page.text(h, cols[i], 120, { size: 11, bold: true });
            });
            page.line(40, 128, 555, 128, { color: [200, 200, 200], width: 0.5 });
            var y = 150;
            for (var r = 0; r < 3; r++) {
              var cells = [String(r + 1), texts[11 + r * 4], texts[12 + r * 4], texts[13 + r * 4], texts[14 + r * 4], '万元'];
              for (var c = 0; c < cells.length; c++) page.text(cells[c], cols[c], y, { size: 10, bold: c === 0 });
              page.line(40, y + 8, 555, y + 8, { color: [230, 230, 230], width: 0.4 });
              y += 26;
            }
            page.rect(40, y + 10, 515, 40, { fill: [245, 246, 250], stroke: [200, 205, 215], lineWidth: 0.6 });
            page.text(texts[8], 52, y + 35, { size: 11, bold: true });
            page.text(texts[9], 40, y + 80, { size: 9, color: [120, 120, 120] });
            page.link(40, y + 68, 200, 16, 'https://www.rmfysszc.gov.cn/');
            return pdf.build();
          })
          .then(function (bytes) {
            fs.writeFileSync(outPath, bytes);
            console.log('[pdf-font selftest] OK');
            console.log('  font      :', fontR.name, '/', fontB.name);
            console.log('  subset    :', fontR.numGlyphs, '-> 子集', '（见摘要）');
            console.log('  pdf bytes :', bytes.length);
            console.log('  output    :', outPath);
            console.log('  缺字检查  : regular/bold 均无缺字（若有会在这里列出）');
          })
          .catch(function (e) { console.error('[pdf-font selftest] FAIL:', e && e.message || e); process.exitCode = 1; });
      } catch (e) {
        console.error('[pdf-font selftest] FAIL:', e && e.message || e);
        process.exitCode = 1;
      }
    })();
  }
})(typeof window !== 'undefined' ? window : globalThis);
