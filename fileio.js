/* MedGuard 文件解析：本地上传病例文件 -> 纯文本
 * 支持 .txt .md .csv .json .docx（自动解包），中文自动识别 UTF-8 / GBK
 * 纯浏览器端完成，文件不上传服务器。
 */
(function (global) {
  'use strict';

  /* ---------- 1. 文本解码（UTF-8 优先，乱码回退 GBK） ---------- */
  function decodeText(bytes) {
    var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    var bad = (utf8.match(/\uFFFD/g) || []).length;
    if (bad > 2) {
      try {
        var gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);
        if ((gbk.match(/\uFFFD/g) || []).length < bad) return gbk;
      } catch (e) { /* 不支持 gbk 就用 utf8 */ }
    }
    return utf8;
  }

  /* ---------- 2. 极简 ZIP 解包（够 docx 用） ---------- */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function unzip(bytes) {
    // 找 EOCD
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip/docx 文件');
    var count = u16(bytes, eocd + 10);
    var cdOff = u32(bytes, eocd + 16);
    var out = {}, p = cdOff;
    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var localOff = u32(bytes, p + 42);
      var name = new TextDecoder('utf-8').decode(bytes.slice(p + 46, p + 46 + nameLen));
      // 读 local header 定位数据
      var lnameLen = u16(bytes, localOff + 26);
      var lextraLen = u16(bytes, localOff + 28);
      var dataStart = localOff + 30 + lnameLen + lextraLen;
      var raw = bytes.slice(dataStart, dataStart + compSize);
      out[name] = { method: method, raw: raw };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function docxToText(bytes) {
    var files = await unzip(bytes);
    var entry = files['word/document.xml'];
    if (!entry) throw new Error('docx 中未找到正文');
    var data = entry.method === 0 ? entry.raw : await inflateRaw(entry.raw);
    var xml = new TextDecoder('utf-8').decode(data);
    // 段落 -> 换行；表格单元格 -> 空格；取 <w:t> 文本
    xml = xml.replace(/<w:p[ >]/g, '\n<w:p ');
    xml = xml.replace(/<w:tab\/>/g, ' ');
    xml = xml.replace(/<w:br\/>/g, '\n');
    var paras = xml.split('\n');
    var lines = [];
    paras.forEach(function (p) {
      var txt = '';
      var re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g, m;
      while ((m = re.exec(p))) txt += m[1];
      if (txt.trim()) lines.push(unescapeXml(txt));
    });
    return lines.join('\n');
  }

  function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  /* ---------- 3. 统一入口 ---------- */
  async function readFile(file) {
    var name = file.name || 'case.txt';
    var ext = (name.split('.').pop() || '').toLowerCase();
    var bytes = new Uint8Array(await file.arrayBuffer());
    var text = '';
    if (ext === 'docx') {
      text = await docxToText(bytes);
    } else if (ext === 'doc') {
      throw new Error('旧版 .doc 无法解析，请另存为 .docx 或直接粘贴文字');
    } else if (ext === 'pdf') {
      throw new Error('PDF 需先复制文字（浏览器无法离线提取扫描件），或另存为 .docx');
    } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].indexOf(ext) >= 0) {
      throw new Error('图片需 OCR，离线不可用；请粘贴文字或上传 .docx');
    } else {
      text = decodeText(bytes);
    }
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('文件中没有可识别的文字');
    return { name: name, ext: ext, text: text, chars: text.length };
  }

  global.MGFile = { readFile: readFile, readBytes: readFile };
})(typeof window !== 'undefined' ? window : globalThis);
