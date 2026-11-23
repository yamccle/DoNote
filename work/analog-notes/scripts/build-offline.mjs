import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const target = process.argv[2];
if (!target) throw new Error('Provide the destination HTML path.');

const readAsset = (name, encoding) => readFileSync(path.join(publicDir, name), encoding);

// Match complete script elements and comments so tags inside them are not bundled.
const assetTags = /<!--[\s\S]*?-->|<script\b[^>]*>(?:[\s\S]*?<\/script\s*>)?|<link\b[^>]*>/gi;
const classicScript = /^<script\s+src\s*=\s*(["'])((?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.js)\1\s*>\s*<\/script\s*>$/i;
const localStylesheet = /^<link\s+rel\s*=\s*(["'])stylesheet\1\s+href\s*=\s*(["'])((?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.css)\2\s*\/?>$/i;

function inlineAsset(element) {
  const openingTag = element.slice(0, element.indexOf('>') + 1);
  if (/^<script\b[^>]*\ssrc(?=[\s=>])/i.test(openingTag)) {
    const match = classicScript.exec(element);
    if (!match) throw new Error('Offline build requires a local classic script with only src: ' + openingTag);
    const source = readAsset(match[2], 'utf8').replace(/<\/script/gi, '<\\/script');
    return '<script>\n' + source + '\n</script>';
  }

  if (/^<link\b[^>]*\srel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet(?=[\s/>]))/i.test(openingTag)) {
    const match = localStylesheet.exec(element);
    if (!match) throw new Error('Offline build requires a local stylesheet: ' + openingTag);
    return '<style>' + readAsset(match[3], 'utf8') + '</style>';
  }

  return element;
}

let html = readAsset('notebook.html', 'utf8').replace(assetTags, inlineAsset);
const presentationEngine = readAsset('ppt-preview-engine.mjs').toString('base64');
html = html.replace(/<\/body>(?=\s*<\/html>\s*$)/i, () =>
  '<script type="text/plain" id="embeddedPresentationEngine">' + presentationEngine + '</script>\n</body>'
);
const logo = 'data:image/png;base64,' + readAsset('brand-logo.png').toString('base64');
html = html.replaceAll('"brand-logo.png"', () => '"' + logo + '"');

const destination = path.resolve(target);
writeFileSync(destination, html);
console.log('Offline HTML created: ' + destination);
