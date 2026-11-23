/**
 * [INPUT]: 接收测试文件路径、页数与目标大小。
 * [OUTPUT]: 生成首尾可检索、可按区间读取的长 PDF。
 * [POS]: 发布回归测试夹具，不依赖第三方 PDF 生成库。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export const FIRST_PAGE_TEXT = 'Release smoke first page';
export const LAST_PAGE_TEXT = 'Release smoke last page';

export async function writeLargePdf(path, pageCount, targetSize) {
  const pdf = await open(path, 'wx');
  try {
    if (process.platform === 'win32') {
      // NTFS 支持稀疏文件时，只写交叉索引和实际的对象。
      spawnSync('fsutil.exe', ['sparse', 'setflag', path], { windowsHide: true, stdio: 'ignore' });
    }
    const catalog = 1;
    const pages = 2;
    const font = 3;
    const firstContent = 4;
    const lastContent = 5;
    const firstPage = 6;
    const padding = firstPage + pageCount;
    const offsets = [0];
    let cursor = 0;
    const write = async text => {
      const bytes = Buffer.from(text, 'ascii');
      await pdf.write(bytes, 0, bytes.length, cursor);
      cursor += bytes.length;
    };
    const object = async (id, body) => {
      offsets[id] = cursor;
      await write(id + ' 0 obj\n' + body + '\nendobj\n');
    };
    const content = text => {
      const stream = 'BT /F1 18 Tf 40 560 Td (' + text + ') Tj ET\n';
      return '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream';
    };

    await write('%PDF-1.4\n');
    await object(catalog, '<< /Type /Catalog /Pages ' + pages + ' 0 R >>');
    const children = Array.from({ length: pageCount }, (_, i) => firstPage + i + ' 0 R').join(' ');
    await object(pages, '<< /Type /Pages /Count ' + pageCount + ' /Kids [' + children + '] >>');
    await object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    await object(firstContent, content(FIRST_PAGE_TEXT));
    await object(lastContent, content(LAST_PAGE_TEXT));
    for (let i = 0; i < pageCount; i++) {
      const stream = i === pageCount - 1 ? lastContent : firstContent;
      await object(firstPage + i, '<< /Type /Page /Parent ' + pages + ' 0 R /MediaBox [0 0 450 650] ' +
        '/Resources << /Font << /F1 ' + font + ' 0 R >> >> /Contents ' + stream + ' 0 R >>');
    }
    offsets[padding] = cursor;
    await write(padding + ' 0 obj\n<< /Length ' + targetSize + ' >>\nstream\n');
    // 保留真实合法流长度。阅读器只需跳过该未引用对象。
    cursor += targetSize;
    await write('\nendstream\nendobj\n');
    const xref = cursor;
    await write('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n');
    await write(offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join(''));
    await write('trailer\n<< /Size ' + offsets.length + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  } finally {
    await pdf.close();
  }
}
