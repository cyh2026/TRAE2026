// 零依赖的迷你 xlsx 生成器 / 解析器（store 方式 zip + OpenXML inline strings）
// 浏览器全局版（供安卓 App 的 index.html 使用）：挂载到 window.MiniXLSX
// sheets: [{ name, cols:[宽度...], rows:[[cell,...]] }]，cell 可为 string/number
// 解析：parseXlsxToSheets(base64) -> [{ name, rows:[[cell,...]] }]

var crcTable = (function () {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function push16(arr, n) { arr.push(n & 0xFF, (n >> 8) & 0xFF); }
function push32(arr, n) {
  arr.push(n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF);
}

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    else if (c >= 0xD800 && c <= 0xDBFF) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return out;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
  var s = '', i, len = bytes.length;
  for (i = 0; i < len; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : (b1 >> 4))];
    s += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : (b2 >> 6))];
    s += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return s;
}

function escXml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;';
  });
}

function colName(idx) {
  var s = ''; idx++;
  while (idx > 0) { var m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

function buildSheet(sheet) {
  var parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  if (sheet.cols && sheet.cols.length) {
    parts.push('<cols>');
    sheet.cols.forEach(function (w, i) {
      parts.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
    });
    parts.push('</cols>');
  }
  parts.push('<sheetData>');
  var rows = sheet.rows || [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    parts.push('<row r="' + (r + 1) + '">');
    for (var c = 0; c < row.length; c++) {
      var cell = row[c];
      var ref = colName(c) + (r + 1);
      if (typeof cell === 'number' && isFinite(cell)) {
        parts.push('<c r="' + ref + '"><v>' + cell + '</v></c>');
      } else {
        parts.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escXml(cell == null ? '' : cell) + '</t></is></c>');
      }
    }
    parts.push('</row>');
  }
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

function buildXlsxBase64(sheets) {
  sheets = sheets || [];
  var files = [];

  var ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'];
  sheets.forEach(function (s, i) {
    ct.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
  });
  ct.push('</Types>');
  files.push({ name: '[Content_Types].xml', data: ct.join('') });

  files.push({ name: '_rels/.rels', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>' });

  var wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'];
  sheets.forEach(function (s, i) {
    var nm = escXml(s.name || ('Sheet' + (i + 1))).slice(0, 31);
    wb.push('<sheet name="' + nm + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>');
  });
  wb.push('</sheets></workbook>');
  files.push({ name: 'xl/workbook.xml', data: wb.join('') });

  var wbRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
  sheets.forEach(function (s, i) {
    wbRels.push('<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
  });
  wbRels.push('</Relationships>');
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: wbRels.join('') });

  sheets.forEach(function (s, i) {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: buildSheet(s) });
  });

  var bytes = [];
  var central = [];
  var offset = 0;
  files.forEach(function (f) {
    var dataBytes = utf8Bytes(f.data);
    var crc = crc32(dataBytes);
    var nameBytes = utf8Bytes(f.name);
    push32(bytes, 0x04034b50);
    push16(bytes, 20);
    push16(bytes, 0);
    push16(bytes, 0);
    push16(bytes, 0);
    push16(bytes, 0);
    push32(bytes, crc);
    push32(bytes, dataBytes.length);
    push32(bytes, dataBytes.length);
    push16(bytes, nameBytes.length);
    push16(bytes, 0);
    bytes.push.apply(bytes, nameBytes);
    bytes.push.apply(bytes, dataBytes);
    push32(central, 0x02014b50);
    push16(central, 20);
    push16(central, 20);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, crc);
    push32(central, dataBytes.length);
    push32(central, dataBytes.length);
    push16(central, nameBytes.length);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, offset);
    central.push.apply(central, nameBytes);
    offset = bytes.length;
  });

  var cdStart = bytes.length;
  bytes.push.apply(bytes, central);
  push32(bytes, 0x06054b50);
  push16(bytes, 0);
  push16(bytes, 0);
  push16(bytes, files.length);
  push16(bytes, files.length);
  push32(bytes, central.length);
  push32(bytes, cdStart);
  push16(bytes, 0);

  return bytesToBase64(bytes);
}

// ===== 解析：base64 -> 文件字典 -> 二维表 =====
var B64I = (function () {
  var m = {};
  for (var i = 0; i < B64.length; i++) m[B64[i]] = i;
  return m;
})();

function base64ToBytes(s) {
  var out = [], i = 0, len = s.length;
  while (i < len) {
    var c1 = B64I[s[i++]]; if (c1 === undefined) continue;
    var c2 = B64I[s[i++]]; if (c2 === undefined) continue;
    out.push((c1 << 2) | (c2 >> 4));
    if (s[i] === '=' || s[i] === undefined) break;
    var c3 = B64I[s[i++]]; if (c3 === undefined) continue;
    out.push(((c2 & 15) << 4) | (c3 >> 2));
    if (s[i] === '=' || s[i] === undefined) break;
    var c4 = B64I[s[i++]]; if (c4 === undefined) continue;
    out.push(((c3 & 3) << 6) | c4);
  }
  return out;
}

function utf8String(bytes) {
  var out = '', i = 0;
  while (i < bytes.length) {
    var c = bytes[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c >= 0xC0 && c < 0xE0) { var c2 = bytes[i++]; out += String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F)); }
    else if (c >= 0xE0 && c < 0xF0) { var c2 = bytes[i++], c3 = bytes[i++]; out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F)); }
    else if (c >= 0xF0) { var c2 = bytes[i++], c3 = bytes[i++], c4 = bytes[i++]; var cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F); cp -= 0x10000; out += String.fromCharCode(0xD800 + ((cp >> 10) & 0x3FF), 0xDC00 + (cp & 0x3FF)); }
    else out += String.fromCharCode(c);
  }
  return out;
}

function colLetterToIndex(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function unescXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 解析 xlsx base64 -> { 'xl/workbook.xml': text, 'xl/worksheets/sheet1.xml': text, ... }
function parseXlsxBase64(b64) {
  var bytes = base64ToBytes(b64);
  var eocd = -1;
  for (var i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Excel 文件');
  var p = eocd;
  var cdOffset = bytes[p + 16] | (bytes[p + 17] << 8) | (bytes[p + 18] << 16) | (bytes[p + 19] << 24);
  var cdCount = bytes[p + 10] | (bytes[p + 11] << 8);
  var entries = [];
  var o = cdOffset;
  for (var e = 0; e < cdCount; e++) {
    if (!(bytes[o] === 0x50 && bytes[o + 1] === 0x4b && bytes[o + 2] === 0x01 && bytes[o + 3] === 0x02)) break;
    var method = bytes[o + 10] | (bytes[o + 11] << 8);
    var csize = (bytes[o + 20] | (bytes[o + 21] << 8) | (bytes[o + 22] << 16) | (bytes[o + 23] << 24)) >>> 0;
    var nlen = bytes[o + 28] | (bytes[o + 29] << 8);
    var elen = bytes[o + 30] | (bytes[o + 31] << 8);
    var clen = bytes[o + 32] | (bytes[o + 33] << 8);
    var nameBytes = bytes.slice(o + 46, o + 46 + nlen);
    var name = utf8String(nameBytes);
    var lho = (bytes[o + 42] | (bytes[o + 43] << 8) | (bytes[o + 44] << 16) | (bytes[o + 45] << 24)) >>> 0;
    entries.push({ name: name, method: method, csize: csize, lho: lho });
    o = o + 46 + nlen + elen + clen;
  }
  var files = {};
  entries.forEach(function (en) {
    var lp = en.lho;
    var method = bytes[lp + 8] | (bytes[lp + 9] << 8);
    var csize = (bytes[lp + 18] | (bytes[lp + 19] << 8) | (bytes[lp + 20] << 16) | (bytes[lp + 21] << 24)) >>> 0;
    var nlen = bytes[lp + 26] | (bytes[lp + 27] << 8);
    var elen = bytes[lp + 28] | (bytes[lp + 29] << 8);
    var dataStart = lp + 30 + nlen + elen;
    var dataBytes = bytes.slice(dataStart, dataStart + csize);
    if (en.method !== 0 && method !== 0) throw new Error('暂仅支持本程序导出的未压缩 Excel 文件');
    files[en.name] = utf8String(dataBytes);
  });
  return files;
}

function parseSheetXml(xml) {
  var rows = [];
  var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  var rm;
  while ((rm = rowRe.exec(xml))) {
    var open = rm[0].slice(0, rm[0].indexOf('>'));
    var inner = rm[1];
    var rnoM = /\br="(\d+)"/.exec(open);
    var rno = rnoM ? parseInt(rnoM[1], 10) : (rows.length + 1);
    var row = [];
    var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var cm;
    while ((cm = cellRe.exec(inner))) {
      var cattrs = cm[1], cinner = cm[2] || '';
      var refM = /\br="([A-Z]+)\d+"/.exec(cattrs);
      var colIdx = refM ? colLetterToIndex(refM[1]) : row.length;
      var val = '';
      if (/\bt="inlineStr"/.test(cattrs)) {
        var tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, tm, s = '';
        while ((tm = tRe.exec(cinner))) s += tm[1];
        val = unescXml(s);
      } else {
        var vM = /<v>([\s\S]*?)<\/v>/.exec(cinner);
        val = vM ? vM[1] : '';
      }
      while (row.length <= colIdx) row.push('');
      row[colIdx] = val;
    }
    rows.push({ rno: rno, row: row });
  }
  rows.sort(function (a, b) { return a.rno - b.rno; });
  return rows.map(function (x) { return x.row; });
}

// files 字典 -> [{ name, rows:[[cell,...]] }]
function filesToSheets(files) {
  var wb = files['xl/workbook.xml'] || files['xl\\workbook.xml'];
  if (!wb) throw new Error('文件缺少 workbook 结构');
  var sheetDefs = [];
  var sheetRe = /<sheet\b([^>]*?)\/?>/g, sm;
  while ((sm = sheetRe.exec(wb))) {
    var a = sm[1];
    var nm = /name="([^"]*)"/.exec(a);
    var rm2 = /r:id="([^"]*)"/.exec(a);
    if (nm && rm2) sheetDefs.push({ name: nm[1], rid: rm2[1] });
  }
  var rels = files['xl/_rels/workbook.xml.rels'] || files['xl\\_rels\\workbook.xml.rels'] || '';
  var relMap = {};
  var relRe = /<Relationship\s+([^>]*?)\/?>/g, rlm;
  while ((rlm = relRe.exec(rels))) {
    var ra = rlm[1];
    var idM = /Id="([^"]*)"/.exec(ra);
    var tgtM = /Target="([^"]*)"/.exec(ra);
    if (idM && tgtM) relMap[idM[1]] = tgtM[1];
  }
  var out = [];
  sheetDefs.forEach(function (def) {
    var tgt = relMap[def.rid];
    if (!tgt) return;
    var path = tgt.indexOf('/') === 0 ? tgt.slice(1) : ('xl/' + tgt);
    path = path.replace(/\\/g, '/');
    var xml = files[path];
    if (xml === undefined) return;
    out.push({ name: def.name, rows: parseSheetXml(xml) });
  });
  if (!out.length) throw new Error('文件中没有可识别的工作表');
  return out;
}

function parseXlsxToSheets(b64) {
  return filesToSheets(parseXlsxBase64(b64));
}

window.MiniXLSX = {
  buildXlsxBase64: buildXlsxBase64,
  parseXlsxBase64: parseXlsxBase64,
  filesToSheets: filesToSheets,
  parseXlsxToSheets: parseXlsxToSheets
};
