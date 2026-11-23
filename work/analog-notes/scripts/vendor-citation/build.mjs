import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = fileURLToPath(new URL('.', import.meta.url));

await build({
  absWorkingDir: directory,
  entryPoints: ['entry.mjs'],
  outfile: path.join(directory, '../../public/citation-engine.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  banner: { js: '/*! Citation.js 0.9.0 and bundled dependencies. See CitationJS-LICENSES.txt. */' },
  plugins: [{
    name: 'offline-citation-import',
    setup(builder) {
      // Local BibTeX and RIS parsing never requires the core Node HTTP client.
      builder.onResolve({ filter: /^sync-fetch-undici$/ }, () => ({
        path: 'sync-fetch-undici', namespace: 'offline-citation-import',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'offline-citation-import' }, () => ({
        contents: 'module.exports = () => { throw new Error("Citation HTTP is unavailable in DoNote"); };',
      }));
    },
  }],
});
