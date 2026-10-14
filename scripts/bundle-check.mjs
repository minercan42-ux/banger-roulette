import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// NFR-01: the initial JS bundle (the entry plus everything the browser
// preloads) must stay under 250 kB gzip. Lazy chunks never appear in
// `index.html`, so they are excluded by construction.
const BUDGET_BYTES = 250_000;
const LEVEL = 9;
const TAG_PATTERN = /<(script|link)\b[^>]*>/gi;
const ATTRIBUTE_PATTERN = /\b([a-z-]+)\s*=\s*"([^"]*)"/gi;
const JS_PATTERN = /\.m?js$/i;

/** Collect the initial JS files referenced by the built `index.html`. */
function collectEntryScripts(html) {
  const refs = new Set();
  for (const [markup, tag] of html.matchAll(TAG_PATTERN)) {
    const attrs = {};
    for (const [, name, value] of markup.matchAll(ATTRIBUTE_PATTERN))
      attrs[name.toLowerCase()] = value;
    if (tag.toLowerCase() === 'script') {
      if (attrs.type?.toLowerCase() !== 'module') continue;
      if (attrs.src) refs.add(attrs.src);
    } else if (attrs.rel?.toLowerCase() === 'modulepreload') {
      if (attrs.href) refs.add(attrs.href);
    }
  }
  return [...refs];
}

/** Map a reference from `index.html` to a path in the `dist` directory. */
function toLocalPath(distDir, ref) {
  const pathname = ref.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z\d+\-.]*:/i.test(pathname) || pathname.startsWith('//'))
    return null;
  return join(distDir, pathname.replace(/^\/+/, ''));
}

const formatBytes = (value) => new Intl.NumberFormat('en-US').format(value);

const indexPath = process.argv[2] ?? 'dist/index.html';
const distDir = dirname(indexPath);

try {
  const html = await readFile(indexPath, 'utf8');
  const files = new Set();
  const skipped = [];
  for (const ref of collectEntryScripts(html)) {
    const file = toLocalPath(distDir, ref);
    if (file === null) {
      skipped.push(ref);
      continue;
    }
    if (!JS_PATTERN.test(file))
      throw new Error(`Initial resource is not JavaScript: ${ref}`);
    files.add(file);
  }
  if (files.size === 0)
    throw new Error(
      `${indexPath} references no local initial JavaScript${
        skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : ''
      }`,
    );

  const rows = await Promise.all(
    [...files].map(async (file) => {
      const raw = await readFile(file);
      return {
        file,
        raw: raw.byteLength,
        gzip: gzipSync(raw, { level: LEVEL }).byteLength,
      };
    }),
  );

  const fileWidth = Math.max(4, ...rows.map((row) => row.file.length));
  const numberWidth = Math.max(
    ...[...rows.map((row) => row.raw), ...rows.map((row) => row.gzip)].map(
      (value) => formatBytes(value).length,
    ),
  );
  const total = rows.reduce((sum, row) => sum + row.gzip, 0);

  console.log(`initial JS from ${indexPath} (gzip level ${LEVEL}):`);
  console.log(
    `  ${'File'.padEnd(fileWidth)}  ${'Raw bytes'.padStart(numberWidth)}  ${'Gzip bytes'.padStart(numberWidth)}`,
  );
  for (const row of rows)
    console.log(
      `  ${row.file.padEnd(fileWidth)}  ${formatBytes(row.raw).padStart(numberWidth)}  ${formatBytes(row.gzip).padStart(numberWidth)}`,
    );
  console.log(
    `  ${'Total'.padEnd(fileWidth)}  ${''.padStart(numberWidth)}  ${formatBytes(total).padStart(numberWidth)}`,
  );

  if (total > BUDGET_BYTES)
    throw new Error(
      `Initial JS gzip ${formatBytes(total)} bytes exceeds the ${formatBytes(BUDGET_BYTES)} byte budget (NFR-01)`,
    );
  console.log(
    `bundle: ${formatBytes(total)} bytes gzip, ${formatBytes(BUDGET_BYTES - total)} bytes under the NFR-01 budget of ${formatBytes(BUDGET_BYTES)}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
