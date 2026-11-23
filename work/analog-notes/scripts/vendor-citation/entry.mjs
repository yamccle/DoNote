import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import { format as serializeBibtex } from '@citation-js/plugin-bibtex/lib/output/bibtex.js';

plugins.config.get('@bibtex').format.asciiOnly = false;

function parseRis(text) {
  return plugins.input.data(text, '@ris/file').map(record => {
    const old = plugins.input.data(record, '@ris/old+record');
    const current = plugins.input.data(record, '@ris/record');
    return { ...old, ...current, 'citation-key': record.ID };
  });
}

function formatBibtex(citation) {
  const records = citation.format('bibtex', { format: 'object' });
  const extended = citation.format('biblatex', { format: 'object' });
  for (const [index, record] of records.entries()) {
    const key = citation.data[index]['citation-key'];
    if (/^[\p{L}\p{N}][\p{L}\p{N}_.:+/-]{0,99}$/u.test(key || '')) record.label = key;
    // The conventional BibTeX fields stay intact. Zotero and other readers also use these fields.
    for (const key of ['abstract', 'isbn', 'issn', 'keywords', 'langid']) {
      if (!record.properties[key] && extended[index].properties[key]) {
        record.properties[key] = extended[index].properties[key];
      }
    }
  }
  return serializeBibtex(records, plugins.dict.get('text'));
}

function formatRis(citation) {
  return citation.format('ris', { format: 'object' }).map((entry, index) => {
    const data = citation.data[index];
    // The modern RIS mapper omits PB for some types and wraps values in text mode.
    if (data.id) entry.ID = data.id;
    if (data.publisher && !entry.PB) entry.PB = data.publisher;
    if (data['publisher-place'] && !entry.CY) entry.CY = data['publisher-place'];
    const pages = data.page?.match(/^([\w]+)\s*[-–]+\s*([\w]+)$/);
    if (pages) [entry.SP, entry.EP] = pages.slice(1);
    const lines = [`TY  - ${entry.TY}`];
    for (const [tag, values] of Object.entries(entry)) {
      if (tag === 'TY') continue;
      for (const value of [].concat(values)) {
        if (value != null) lines.push(`${tag}  - ${String(value).replace(/\s+/g, ' ').trim()}`);
      }
    }
    return [...lines, 'ER  - '].join('\r\n');
  }).join('\r\n\r\n') + '\r\n';
}

globalThis.DoNoteCitationEngine = Object.freeze({
  parse(text, format) {
    if (format === 'ris') return parseRis(text);
    return new Cite(text, { forceType: '@biblatex/text', generateGraph: false }).data;
  },
  format(entries, format) {
    const citation = new Cite(entries, { generateGraph: false });
    return format === 'ris' ? formatRis(citation) : formatBibtex(citation);
  },
});
