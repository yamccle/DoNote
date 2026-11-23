/**
 * [INPUT]: 读取工作台模板及其本地样式和经典脚本。
 * [OUTPUT]: 将每个外部引用交给对应的打包入口。
 * [POS]: 桌面工作台与独立 HTML 共享的资源引用规则。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export const readAsset = (name, encoding) => readFileSync(path.join(publicDir, name), encoding);

// 匹配完整的脚本和注释，避免处理正文脚本中的标签。
const assetTags = /<!--[\s\S]*?-->|<script\b[^>]*>(?:[\s\S]*?<\/script\s*>)?|<link\b[^>]*>/gi;
const classicScript = /^<script\s+src\s*=\s*(["'])((?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.js)\1\s*>\s*<\/script\s*>$/i;
const localStylesheet = /^<link\s+rel\s*=\s*(["'])stylesheet\1\s+href\s*=\s*(["'])((?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.css)\2\s*\/?>$/i;

export function mapWorkspaceAssets(html, transform) {
  return html.replace(assetTags, element => {
    const openingTag = element.slice(0, element.indexOf('>') + 1);
    if (/^<script\b[^>]*\ssrc(?=[\s=>])/i.test(openingTag)) {
      const match = classicScript.exec(element);
      if (!match) throw new Error('Expected a local classic script with only src: ' + openingTag);
      return transform(match[2], 'script', element);
    }
    if (/^<link\b[^>]*\srel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet(?=[\s/>]))/i.test(openingTag)) {
      const match = localStylesheet.exec(element);
      if (!match) throw new Error('Expected a local stylesheet with only rel and href: ' + openingTag);
      return transform(match[3], 'style', element);
    }
    return element;
  });
}
