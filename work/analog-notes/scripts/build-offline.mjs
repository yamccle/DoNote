/**
 * [INPUT]: 读取工作台模板及其本地脚本、样式和品牌标志。
 * [OUTPUT]: 生成内联脚本和样式的独立 HTML。
 * [POS]: 为便携工作台保留单文件入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mapWorkspaceAssets, readAsset } from './workspace-assets.mjs';

const target = process.argv[2];
if (!target) throw new Error('Provide the destination HTML path.');

let html = mapWorkspaceAssets(readAsset('notebook.html', 'utf8'), (name, type) => {
  const source = readAsset(name, 'utf8');
  return type === 'script'
    ? '<script>\n' + source.replace(/<\/script/gi, '<\\/script') + '\n</script>'
    : '<style>' + source + '</style>';
});
const presentationEngine = readAsset('ppt-preview-engine.mjs').toString('base64');
html = html.replace(/<\/body>(?=\s*<\/html>\s*$)/i, () =>
  '<script type="text/plain" id="embeddedPresentationEngine">' + presentationEngine + '</script>\n</body>'
);
const logo = 'data:image/png;base64,' + readAsset('brand-logo.png').toString('base64');
html = html.replaceAll('"brand-logo.png"', () => '"' + logo + '"');

const destination = path.resolve(target);
writeFileSync(destination, html);
console.log('Offline HTML created: ' + destination);
