/**
 * [INPUT]: 读取工作台模板、应用资源和本地的第三方库。
 * [OUTPUT]: 生成桌面工作台目录，脚本、样式与第三方 worker 按文件存放。
 * [POS]: 由桌面构建脚本调用，输出供 WebView2 同源加载。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mapWorkspaceAssets, publicDir, readAsset } from './workspace-assets.mjs';

const target = process.argv[2];
if (!target) throw new Error('Provide the destination workspace directory.');
const destination = path.resolve(target);
mkdirSync(destination, { recursive: true });

const files = new Set(['brand-logo.png', 'NotoSansSC.ttf', 'ppt-preview-engine.mjs']);
const html = mapWorkspaceAssets(readAsset('notebook.html', 'utf8'), (name, type, element) => {
  if (name === 'pdf-assets.js' && type === 'script') return '';
  files.add(name);
  return element;
});
const vendorDirectories = ['katex', 'ocr', 'pdfjs'];
for (const directory of vendorDirectories) {
  cpSync(path.join(publicDir, directory), path.join(destination, directory), { recursive: true });
}
for (const name of files) {
  if (vendorDirectories.includes(name.split('/')[0])) continue;
  const output = path.join(destination, name);
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(path.join(publicDir, name), output);
}

// 旧 HTML 构建继续使用源码中的字符串。桌面构建只解包，不执行这些声明。
const embeddedPdf = readAsset('pdf-assets.js', 'utf8').trim().split(/\r?\n/);
for (const [binding, filename] of [['PDFJS_SOURCE', 'pdf.mjs'], ['PDFJS_WORKER_SOURCE', 'pdf.worker.mjs']]) {
  const prefix = 'const ' + binding + '=';
  const line = embeddedPdf.find(entry => entry.startsWith(prefix));
  if (!line?.endsWith(';')) throw new Error('Missing bundled PDF.js source: ' + binding);
  const source = JSON.parse(line.slice(prefix.length, -1));
  if (typeof source !== 'string' || !source.trim()) throw new Error('Invalid bundled PDF.js source: ' + binding);
  writeFileSync(path.join(destination, 'pdfjs', filename), source);
}

writeFileSync(path.join(destination, 'index.html'), html);
console.log('Desktop workspace created: ' + destination);
