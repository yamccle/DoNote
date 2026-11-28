/**
 * [INPUT]: 读取 work/analog-notes/public/、work/desktop/、work/analog-notes/scripts/ 及 tools/tests/ 下的全部自研脚本。
 * [OUTPUT]: 执行零构建侵入的四重静态门禁：800 行体量红线、跨经典脚本顶层词法重名检测、ESLint no-undef 等核心规则、以及 TypeScript allowJs 语法与绑定诊断。
 * [POS]: 开发与 tools/release.ps1 发布前置静态门禁，在 2 秒内拦截未声明符号（如 pdf2zhPending）、常量误写与跨文件冲突。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

function resolveToolPackage(pkgName) {
  const candidates = [
    process.env.DONOTE_LINT_MODULES,
    path.join(repoRoot, 'work/analog-notes/node_modules'),
    'H:/WorkSpace/Codex/2026-11-03/sites-plugin-sites-openai-curated-remote-2/work/analog-notes/node_modules',
    path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')
  ].filter(Boolean);

  try {
    return require(pkgName);
  } catch {}
  for (const dir of candidates) {
    try {
      const reqFrom = createRequire(path.join(dir, 'noop.js'));
      return reqFrom(pkgName);
    } catch {}
  }
  throw new Error(`Static gate missing required package "${pkgName}". Set DONOTE_LINT_MODULES to node_modules path.`);
}

const { Linter } = resolveToolPackage('eslint');
const ts = resolveToolPackage('typescript');

const VENDOR_PUBLIC_FILES = new Set([
  'pdf-assets.js',
  'pdf-lib.min.js',
  'jszip.min.js',
  'marked.umd.js',
  'minisearch.min.js',
  'sha256.min.js',
  'readability.js',
  'citation-engine.js',
  'ppt-preview-engine.mjs'
]);
const VENDOR_DESKTOP_FILES = new Set([
  'startup-wordmark.js'
]);
const VENDOR_DIRS = new Set([
  'node_modules', 'katex', 'ocr', 'pdfjs',
  'pdfmathtranslate-src', 'bilingual-book-maker-src',
  'vendor-citation', 'connector-preview', 'vite'
]);

function walkFiles(dir, predicate, bucket = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (VENDOR_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, bucket);
    else if (predicate(full, entry.name)) bucket.push(full);
  }
  return bucket;
}

// ── Gate 1: Enforce <= 800 lines ceiling across all authored work/ code files ──
const CODE_EXT = new Set(['.js', '.mjs', '.cs', '.py', '.css', '.ps1', '.html']);
const workFiles = walkFiles(path.join(repoRoot, 'work'), (full, name) => {
  const ext = path.extname(name).toLowerCase();
  if (!CODE_EXT.has(ext)) return false;
  if (VENDOR_PUBLIC_FILES.has(name) || VENDOR_DESKTOP_FILES.has(name)) return false;
  return statSync(full).size < 512 * 1024;
});

const oversized = [];
for (const file of workFiles) {
  const count = readFileSync(file, 'utf8').split(/\r?\n/).length;
  if (count > 800) {
    oversized.push(`${path.relative(repoRoot, file).replace(/\\/g, '/')} (${count} lines > 800)`);
  }
}
if (oversized.length) {
  throw new Error('Static Gate [max-lines <= 800] failed:\n  ' + oversized.join('\n  '));
}

// ── Gate 2: Parse classic script load graph & detect cross-file top-level lexical collisions ──
const publicDir = path.join(repoRoot, 'work/analog-notes/public');
const desktopDir = path.join(repoRoot, 'work/desktop');
const notebookHtml = readFileSync(path.join(publicDir, 'notebook.html'), 'utf8');

const inlineScripts = [];
const inlineScriptRe = /<script(?:\s+type="text\/javascript")?\s*>([\s\S]*?)<\/script>/gi;
let inlineIdx = 0;
for (const match of notebookHtml.matchAll(inlineScriptRe)) {
  const lineOffset = notebookHtml.slice(0, match.index).split(/\r?\n/).length;
  inlineScripts.push({
    virtualName: `work/analog-notes/public/notebook.html#inline-${++inlineIdx}(L${lineOffset})`,
    code: match[1]
  });
}

const scriptSrcRe = /<script\s+src="([^"]+\.js)"\s*><\/script>/gi;
const orderedClassicScripts = [];
for (const match of notebookHtml.matchAll(scriptSrcRe)) {
  const rel = match[1];
  if (VENDOR_PUBLIC_FILES.has(rel) || rel.startsWith('katex/') || rel.startsWith('ocr/') || rel.startsWith('pdfjs/')) continue;
  orderedClassicScripts.push(path.join(publicDir, rel));
}

const desktopInjected = [
  'startup-splash.js',
  'desktop-settings.js',
  'desktop-translation.js',
  'desktop-ai-hub.js',
  'desktop-large-backup.js',
  'desktop-cloud-backup.js',
  'folder-sync-merge.js',
  'folder-sync.js'
].map(name => path.join(desktopDir, name));

const allClassicScripts = [
  ...inlineScripts,
  ...orderedClassicScripts.map(p => ({
    virtualName: path.relative(repoRoot, p).replace(/\\/g, '/'),
    code: readFileSync(p, 'utf8')
  })),
  ...desktopInjected.map(p => ({
    virtualName: path.relative(repoRoot, p).replace(/\\/g, '/'),
    code: readFileSync(p, 'utf8')
  }))
];

function collectBindingIdentifiers(nameNode, out) {
  if (ts.isIdentifier(nameNode)) {
    out.push(nameNode.text);
  } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el)) collectBindingIdentifiers(el.name, out);
    }
  }
}

const lexicalOwners = new Map(); // identifier -> first file
const harvestedGlobals = new Set([
  // Browser & Web Platform standard globals (ES2024 + Chromium WebView2)
  'window', 'self', 'globalThis', 'document', 'location', 'history', 'navigator', 'screen',
  'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange', 'caches', 'crypto', 'performance',
  'console', 'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask',
  'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'MessageEvent', 'ErrorEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'DragEvent', 'ClipboardEvent', 'EventTarget', 'DataTransfer', 'ClipboardItem', 'WheelEvent', 'FocusEvent', 'InputEvent', 'ToggleEvent', 'HashChangeEvent', 'PopStateEvent', 'BeforeUnloadEvent', 'PromiseRejectionEvent',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLDialogElement', 'SVGElement', 'DocumentFragment', 'Range', 'Selection', 'NodeFilter',
  'DOMParser', 'XMLSerializer', 'Image', 'Audio', 'Option', 'VTTCue', 'Highlight', 'MediaRecorder', 'DOMException', 'getSelection',
  'OffscreenCanvas', 'ImageBitmap', 'createImageBitmap', 'DOMPoint', 'DOMRect', 'DOMMatrix', 'Path2D',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'BroadcastChannel', 'MessageChannel', 'Worker',
  'TextEncoder', 'TextDecoder', 'CompressionStream', 'DecompressionStream', 'ReadableStream', 'WritableStream', 'TransformStream',
  'atob', 'btoa', 'structuredClone', 'CSS', 'getComputedStyle', 'matchMedia', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'scrollTo', 'open', 'print',
  'Notification', 'webkitSpeechRecognition', 'SpeechRecognition', 'Translator', 'LanguageDetector', 'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker',
  // Bundled vendor globals loaded in notebook.html / desktop build
  'PDFLib', 'marked', 'katex', 'renderMathInElement', 'MiniSearch', 'sha256', 'Readability', 'Tesseract', 'Cite', 'JSZip',
  'DoNoteCitationEngine', 'PDFJS_SOURCE', 'PDFJS_WORKER_SOURCE', 'startupWordmark'
]);

const lexicalCollisions = [];

for (const unit of allClassicScripts) {
  const { code, virtualName: relName } = unit;
  const sf = ts.createSourceFile(relName, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      harvestedGlobals.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      if (lexicalOwners.has(name)) lexicalCollisions.push(`"${name}" declared in both ${lexicalOwners.get(name)} and ${relName}`);
      else lexicalOwners.set(name, relName);
      harvestedGlobals.add(name);
    } else if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      const isLexical = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0;
      const names = [];
      for (const decl of stmt.declarationList.declarations) {
        collectBindingIdentifiers(decl.name, names);
      }
      for (const name of names) {
        if (isLexical) {
          if (lexicalOwners.has(name)) lexicalCollisions.push(`"${name}" (let/const) declared in both ${lexicalOwners.get(name)} and ${relName}`);
          else lexicalOwners.set(name, relName);
        }
        harvestedGlobals.add(name);
      }
    }
  }

  // Also harvest explicit window.Foo = ... / globalThis.Foo = ... assignments
  const winAssignRe = /\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*(?:\?\?=|\|\|=|=)(?!=)/g;
  for (const m of code.matchAll(winAssignRe)) {
    harvestedGlobals.add(m[1]);
  }
}

if (lexicalCollisions.length) {
  throw new Error('Static Gate [cross-script top-level let/const collision] failed:\n  ' + lexicalCollisions.join('\n  '));
}

// ── Gate 3: ESLint 9 AST Verification (no-undef, no-const-assign, no-dupe-keys, etc.) ──
const linter = new Linter({ configType: 'flat' });
const sharedGlobalsConfig = {};
for (const g of harvestedGlobals) sharedGlobalsConfig[g] = 'writable';

const CORE_RULES = {
  'no-undef': ['error', { typeof: false }],
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error'
};

const classicConfig = [{
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script',
    globals: sharedGlobalsConfig
  },
  rules: CORE_RULES
}];

const nodeGlobals = {
  ...sharedGlobalsConfig,
  process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  module: 'readonly', exports: 'readonly', require: 'readonly', global: 'readonly',
  qaRelease: 'readonly'
};

const esmConfig = [{
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: nodeGlobals
  },
  rules: CORE_RULES
}];

const esmFiles = [
  ...walkFiles(path.join(repoRoot, 'work/analog-notes/scripts'), f => f.endsWith('.mjs')),
  ...walkFiles(desktopDir, f => f.endsWith('.mjs')),
  ...walkFiles(path.join(repoRoot, 'tools/tests'), f => f.endsWith('.mjs'))
];

const lintErrors = [];
for (const unit of allClassicScripts) {
  const messages = linter.verify(unit.code, classicConfig, { filename: unit.virtualName });
  for (const msg of messages) {
    if (msg.severity === 2) {
      lintErrors.push(`${unit.virtualName}:${msg.line}:${msg.column} [${msg.ruleId || 'syntax'}] ${msg.message}`);
    }
  }
}

for (const file of esmFiles) {
  const code = readFileSync(file, 'utf8');
  const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  const messages = linter.verify(code, esmConfig, { filename: rel });
  for (const msg of messages) {
    if (msg.severity === 2) {
      lintErrors.push(`${rel}:${msg.line}:${msg.column} [${msg.ruleId || 'syntax'}] ${msg.message}`);
    }
  }
}

if (lintErrors.length) {
  throw new Error(`Static Gate [ESLint AST checks] found ${lintErrors.length} error(s):\n  ` + lintErrors.join('\n  '));
}

// ── Gate 4: TypeScript Compiler (--allowJs) Syntactic & Binding Diagnostics ──
const tsDiagnostics = [];
const allTsUnits = [
  ...allClassicScripts.map(u => ({ ...u, isModule: false })),
  ...esmFiles.map(f => ({
    virtualName: path.relative(repoRoot, f).replace(/\\/g, '/'),
    code: readFileSync(f, 'utf8'),
    isModule: true
  }))
];
for (const unit of allTsUnits) {
  const result = ts.transpileModule(unit.code, {
    fileName: unit.virtualName.replace(/#.*$/, '.js'),
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ESNext,
      module: unit.isModule ? ts.ModuleKind.ESNext : ts.ModuleKind.None
    }
  });
  for (const diag of result.diagnostics || []) {
    if (diag.category === ts.DiagnosticCategory.Error) {
      const pos = diag.file && diag.start !== undefined
        ? diag.file.getLineAndCharacterOfPosition(diag.start)
        : { line: 0, character: 0 };
      const msgText = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      tsDiagnostics.push(`${unit.virtualName}:${pos.line + 1}:${pos.character + 1} [TS${diag.code}] ${msgText}`);
    }
  }
}

if (tsDiagnostics.length) {
  throw new Error(`Static Gate [TypeScript --allowJs] found ${tsDiagnostics.length} error(s):\n  ` + tsDiagnostics.join('\n  '));
}

// ── Canary Self-Test: Prove the gate catches undeclared symbols like pdf2zhPending ──
const canaryMsgs = linter.verify(
  "'use strict'; function canaryProbe() { return undeclaredGhostPendingMap.get('p1'); }",
  classicConfig,
  { filename: 'canary.js' }
);
assert.ok(
  canaryMsgs.some(m => m.ruleId === 'no-undef' && m.message.includes('undeclaredGhostPendingMap')),
  'Canary self-test failed: no-undef must reject undeclaredGhostPendingMap'
);

console.log(
  `PASS static gate: ${workFiles.length} files <= 800 lines, ` +
  `${allClassicScripts.length} classic scripts + ${esmFiles.length} ES modules verified via ESLint (no-undef) & TypeScript (allowJs)`
);
