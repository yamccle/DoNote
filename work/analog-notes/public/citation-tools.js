'use strict';

const CITATION_TEXT_LIMITS = {
 type: 48, 'citation-key': 160, volume: 80, issue: 80, page: 160, 'page-first': 80,
 publisher: 500, 'publisher-place': 300, edition: 100, ISBN: 120, ISSN: 120,
 'collection-title': 500, 'container-title': 300, 'container-title-short': 300, language: 80, URL: 3000,
 'event-title': 500, 'event-place': 300, genre: 200, keyword: 2000,
};
const CITATION_NAME_FIELDS = ['literal', 'given', 'family', 'non-dropping-particle', 'dropping-particle', 'suffix'];
const CITATION_NAME_LISTS = ['author', 'editor', 'translator'];
const MAX_CITATION_FILE = 2 * 1024 ** 2;
const MAX_CITATION_ITEMS = 2000;
const CITATION_EXPORT_KEY = /^[\p{L}\p{N}][\p{L}\p{N}_.:+/-]{0,99}$/u;

function citationText(value, limit) {
 return typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, limit) : '';
}

function citationDates(value) {
 const parts = value?.['date-parts'];
 return Array.isArray(parts) && parts.length > 0 && parts.length <= 2 && parts.every(date =>
  Array.isArray(date) && date.length >= 1 && date.length <= 3 && date.every((n, i) =>
   Number.isInteger(n) && n >= 1 && n <= [9999, 12, 31][i]));
}

function validCitationRecord(data) {
 if (data === undefined) return true;
 if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
 return Object.entries(data).every(([key, value]) => {
  if (key === 'issued') return citationDates(value) && Object.keys(value).length === 1;
  if (CITATION_NAME_LISTS.includes(key)) return Array.isArray(value) && value.length <= 200 && value.every(name =>
   name && typeof name === 'object' && !Array.isArray(name) && Object.entries(name).every(([part, text]) =>
    CITATION_NAME_FIELDS.includes(part) && typeof text === 'string' && text.length <= 300));
  return Object.hasOwn(CITATION_TEXT_LIMITS, key) && typeof value === 'string' && value.length <= CITATION_TEXT_LIMITS[key];
 });
}

function citationMetadata(entry) {
 const metadata = {};
 for (const [field, limit] of Object.entries(CITATION_TEXT_LIMITS)) {
  const value = citationText(entry[field], limit);
  if (value && (field !== 'URL' || /^https?:\/\//i.test(value))) metadata[field] = value;
 }
 for (const key of CITATION_NAME_LISTS) {
  if (!Array.isArray(entry[key])) continue;
  const names = entry[key].slice(0, 200).map(name => Object.fromEntries(CITATION_NAME_FIELDS
   .map(field => [field, citationText(name?.[field], 300)]).filter(([, value]) => value)));
  if (names.some(name => Object.keys(name).length)) metadata[key] = names.filter(name => Object.keys(name).length);
 }
 if (citationDates(entry.issued)) metadata.issued = { 'date-parts': entry.issued['date-parts'] };
 return metadata;
}

function citationAuthorLabel(names = []) {
 return names.map(name => {
  if (name.literal) return name.literal;
  if (/^\p{Script=Han}+$/u.test(name.family || '') && /^\p{Script=Han}+$/u.test(name.given || '')) return name.family + name.given;
  return [name.given, name['dropping-particle'], name['non-dropping-particle'], name.family, name.suffix].filter(Boolean).join(' ');
 }).filter(Boolean).join('、');
}

function readCitationFile(file) {
 const format = /\.ris$/i.test(file.name) ? 'ris' : 'bibtex';
 return file.arrayBuffer().then(buffer => {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
   bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).trim();
  if (!text || (format === 'ris' ? !/^\s*TY {2}- /m.test(text) : !/@[a-z]+\s*[{(]/i.test(text))) return [];
  return DoNoteCitationEngine.parse(text, format);
 });
}

function citationDoi(value) {
 return literatureDoi(String(value || '')).toLowerCase();
}

function citationIdentity(value) {
 return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function addCitationRecords(entries) {
 const next = structuredClone(appState);
 const profile = next.profiles.find(item => item.id === next.activeId);
 const byDoi = new Map(), byTitle = new Map(), byId = new Map();
 let added = 0, enriched = 0, duplicates = 0, invalid = 0;
 const index = note => {
  byId.set(note.id, note);
  const doi = citationDoi(note.literature?.doi || note.url);
  if (doi && !byDoi.has(doi)) byDoi.set(doi, note);
  const title = citationIdentity(note.title);
  if (!byTitle.has(title)) byTitle.set(title, []);
  if (!byTitle.get(title).includes(note)) byTitle.get(title).push(note);
 };
 profile.records.filter(note => note.type === 'resource' || note.type === 'paper').forEach(index);
 const timestamp = new Date().toISOString();
 for (const entry of entries) {
  const title = citationText(entry.title, 240);
  if (!title) { invalid++; continue; }
  const citation = citationMetadata(entry);
  const author = citationAuthorLabel(citation.author).slice(0, 200);
  const year = citation.issued ? String(citation.issued['date-parts'][0][0]).padStart(4, '0') : '';
  const doi = literatureDoi(String(entry.DOI || citation.URL || ''));
  const publication = citationText(entry['container-title'] || entry.publisher, LITERATURE_LIMITS.publication);
  const abstract = citationText(entry.abstract, LITERATURE_LIMITS.abstract);
  const literature = Object.fromEntries(Object.entries({ doi, publication, year, abstract }).filter(([, value]) => value));
  const titleKey = citationIdentity(title);
  const firstAuthor = citationIdentity(author.split('、')[0]);
  const ownKey = byId.get(citation['citation-key']);
  const ownDoi = citationDoi(ownKey?.literature?.doi || ownKey?.url);
  const ownExport = ownKey && title === citationText(ownKey.title, 240) && (!doi || !ownDoi || citationDoi(doi) === ownDoi) ? ownKey : null;
  const matches = titleKey.length >= 5 ? (byTitle.get(titleKey) || []).filter(existing => {
   const oldDoi = citationDoi(existing.literature?.doi || existing.url);
   const oldYear = existing.literature?.year;
   const oldAuthor = citationIdentity((existing.author || '').split('、')[0]);
   if (doi && oldDoi && citationDoi(doi) !== oldDoi) return false;
   if (year && oldYear && year !== oldYear) return false;
   if (firstAuthor && oldAuthor && firstAuthor !== oldAuthor) return false;
   return !!((year && oldYear) || (firstAuthor && oldAuthor) ||
    (citation['citation-key'] && citation['citation-key'] === existing.citation?.['citation-key'] && title === existing.title));
  }) : [];
  const previous = byDoi.get(citationDoi(doi)) || ownExport || (matches.length === 1 ? matches[0] : null);
  if (previous) {
   const savedMetadata = { ...previous.citation };
   for (const [key, value] of Object.entries(citation)) if (!savedMetadata[key]) savedMetadata[key] = value;
   const savedLiterature = { ...previous.literature };
   for (const [key, value] of Object.entries(literature)) if (!savedLiterature[key]) savedLiterature[key] = value;
   const savedAuthor = previous.author || author;
   if (JSON.stringify(savedLiterature) === JSON.stringify(previous.literature || {}) &&
       JSON.stringify(savedMetadata) === JSON.stringify(previous.citation || {}) && savedAuthor === (previous.author || '')) {
    duplicates++;
    continue;
   }
   Object.assign(previous, {
    citation: savedMetadata, literature: savedLiterature, author: savedAuthor, updatedAt: timestamp,
    reference: previous.reference || [savedLiterature.publication, savedLiterature.year].filter(Boolean).join(' · '),
    url: previous.url || citation.URL || (doi ? 'https://doi.org/' + doi : ''),
   });
   index(previous);
   enriched++;
   continue;
  }
  const note = assignDefaultFolder({
   id: crypto.randomUUID(), type: 'resource', title, author, literature, citation,
   reference: [publication, year].filter(Boolean).join(' · '),
   url: citation.URL || (doi ? 'https://doi.org/' + doi : ''),
   body: '', bodyHtml: '', date: today(), tags: [], status: '待读', pinned: false,
   attachments: [], createdAt: timestamp, updatedAt: timestamp,
  });
  if (!validate(note)) { invalid++; continue; }
  profile.records.push(note);
  index(note);
  added++;
 }
 return { next, added, enriched, duplicates, invalid };
}

function citationEntry(note) {
 const entry = citationMetadata(note.citation || {});
 const { year, publication, doi, abstract } = note.literature || {};
 const author = (note.author || '').trim();
 if (author !== citationAuthorLabel(entry.author).slice(0, 200)) {
  entry.author = author.split(/\s*(?:、|[;；]|\band\b)\s*/i).filter(Boolean).map(literal => ({ literal }));
 }
 if (/^\d{4}$/.test(year || '') && Number(year) !== entry.issued?.['date-parts']?.[0]?.[0]) {
  entry.issued = { 'date-parts': [[Number(year)]] };
 } else if (!year) delete entry.issued;
 entry.id = note.id;
 entry.type ||= note.webArticle ? 'webpage' : publication ? 'article-journal' : 'document';
 entry.title = note.title;
 // The main field also shows publishers for books that have no container.
 if (publication && (entry['container-title'] || publication !== entry.publisher)) entry['container-title'] = publication;
 else delete entry['container-title'];
 if (!entry.page && entry['page-first']) entry.page = entry['page-first'];
 const identifier = literatureDoi(doi || note.url || '');
 if (identifier) entry.DOI = identifier;
 if (abstract) entry.abstract = abstract;
 if (note.url && /^https?:\/\//i.test(note.url)) entry.URL = note.url;
 return entry;
}

function formattedCitation(entry, style) {
 const authors = citationAuthorLabel(entry.author || entry.editor).replaceAll('、', ', ');
 const year = entry.issued?.['date-parts']?.[0]?.[0];
 const volumeIssue = [entry.volume, entry.issue && '(' + entry.issue + ')'].filter(Boolean).join('');
 const venue = [entry['container-title'], entry.publisher, volumeIssue, entry.page || entry['page-first']]
  .filter((value, index, fields) => value && fields.indexOf(value) === index).join(', ');
 const parts = [authors, year && '(' + year + ')', entry.title, venue].filter(Boolean);
 const text = parts.map(part => /[.!?。！？)]$/.test(String(part)) ? part : part + '.').join(' ');
 const url = entry.DOI ? 'https://doi.org/' + entry.DOI : entry.URL;
 return (style === 'numbered' ? '[1] ' : '') + text + (url ? ' ' + url : '');
}

function citationDownload(notes, format, name) {
 const reserved = new Set(notes.map(note => note.id.toLowerCase()));
 const keys = new Set();
 const entries = notes.map(note => {
  const entry = citationEntry(note);
  const sourceKey = entry['citation-key'] || '';
  const sourceLower = sourceKey.toLowerCase();
  const canKeep = CITATION_EXPORT_KEY.test(sourceKey) && !reserved.has(sourceLower) && !keys.has(sourceLower);
  const base = canKeep ? sourceKey : note.id;
  let key = base, suffix = 1;
  while (keys.has(key.toLowerCase())) key = base.slice(0, 94) + '-' + ++suffix;
  keys.add(key.toLowerCase());
  return { ...entry, id: key, 'citation-key': key };
 });
 const text = DoNoteCitationEngine.format(entries, format);
 download(name + (format === 'ris' ? '.ris' : '.bib'), text, 'text/plain;charset=utf-8');
}

function installCitationButton(container, note) {
 const button = document.createElement('button');
 button.type = 'button';
 button.className = 'secondary';
 button.dataset.citationAction = 'open';
 button.textContent = '复制 / 导出引用';
 button.onclick = () => {
  const entry = citationEntry(note), preview = $('citationPreview'), style = $('citationStyle');
  const update = () => { preview.value = formattedCitation(entry, style.value); };
  $('citationDetailStatus').textContent = '';
  style.onchange = update;
  $('citationCopy').onclick = async () => {
   try {
    await navigator.clipboard.writeText(preview.value);
    $('citationDetailStatus').textContent = '引用已复制。';
   } catch {
    preview.focus();
    preview.select();
    $('citationDetailStatus').textContent = '请按 Ctrl+C 复制选中的引用。';
   }
  };
  const exportOne = format => {
   try { citationDownload([note], format, note.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120)); }
   catch { $('citationDetailStatus').textContent = '无法导出这条引用。'; }
  };
  $('citationDownloadBib').onclick = () => exportOne('bibtex');
  $('citationDownloadRis').onclick = () => exportOne('ris');
  update();
  $('citationDetail').showModal();
 };
 container.append(button);
}

for (const id of ['citationManager', 'citationDetail']) {
 $(id).querySelector('[data-close]').onclick = () => $(id).close();
}

const openCitationManager = document.createElement('button');
openCitationManager.type = 'button';
openCitationManager.className = 'secondary';
openCitationManager.id = 'openCitationManager';
openCitationManager.textContent = '文献引用';
openCitationManager.onclick = () => {
 if (!ensureReady()) return;
 $('citationImportStatus').textContent = '';
 $('citationManager').showModal();
};
$('openLiteratureMatrix').before(openCitationManager);
$('citationImport').onclick = () => $('citationFileInput').click();
$('citationFileInput').onchange = async event => {
 const input = event.currentTarget, files = [...input.files], button = $('citationImport');
 const message = $('citationImportStatus'), profile = appState.activeId;
 input.value = '';
 if (!files.length || !ensureReady() || button.disabled) return;
 if (files.some(file => !/\.(?:bib|bibtex|ris)$/i.test(file.name)) || files.reduce((sum, file) => sum + file.size, 0) > MAX_CITATION_FILE) {
  message.textContent = '请选择 BibTeX 或 RIS 文件，每次导入上限 2 MB。';
  return;
 }
 button.disabled = true;
 message.textContent = '正在读取文献引用…';
 try {
  const entries = [];
  for (const file of files) {
   let parsed;
   try { parsed = await readCitationFile(file); }
   catch { throw new Error('无法读取 '+file.name+'，请检查文件格式及文本编码。'); }
   if (!parsed.length) throw new Error(file.name+' 中没有可导入的引用。');
   if (entries.length + parsed.length > MAX_CITATION_ITEMS) throw new Error('一次最多导入 2,000 条引用。');
   entries.push(...parsed);
  }
  if (profile !== appState.activeId) throw new Error('当前用户已切换，请重新导入。');
  const { next, added, enriched, duplicates, invalid } = addCitationRecords(entries);
  if (added || enriched) {
   await commitState(next);
   render();
  }
  message.textContent = ['已新增 '+added+' 条', '补全 '+enriched+' 条', '跳过重复 '+duplicates+' 条',
   invalid ? '无标题或无效 '+invalid+' 条' : ''].filter(Boolean).join('，') + '。';
 } catch (error) { message.textContent = error.message; }
 finally { button.disabled = false; }
};

$('citationExport').onclick = () => {
 const ids = selectedLibraryIds.size ? selectedLibraryIds : new Set(visibleLibraryIds);
 const notes = records.filter(note => ids.has(note.id) && (note.type === 'paper' || note.citation ||
  note.literature?.doi || note.literature?.publication || note.webArticle || note.attachments?.some(fileIsPdf)));
 const message = $('citationImportStatus');
 if (!notes.length) { message.textContent = '当前范围没有可导出的文献。'; return; }
 try {
  citationDownload(notes, $('citationExportFormat').value, 'DoNote-文献引用-' + today());
  message.textContent = '已导出 '+notes.length+' 条引用。';
 } catch { message.textContent = '导出引用失败，请缩小选择范围后重试。'; }
};
