import { readFile } from 'node:fs/promises';

function flatten(value, prefix = '', entries = {}) {
  if (typeof value === 'string') {
    entries[prefix] = [
      ...value.matchAll(/{{\s*-?\s*([\w.]+)(?:\s*,[^}]*)?\s*}}/g),
    ]
      .map((match) => match[1])
      .sort();
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix ? `${prefix}.${key}` : key, entries);
  } else {
    throw new Error(`Translation ${prefix} must be a string or nested object`);
  }
  return entries;
}

try {
  const paths = process.argv.slice(2);
  if (paths.length !== 0 && paths.length !== 2)
    throw new Error('Usage: i18n-check.mjs [de.json en.json]');
  const [de, en] = await Promise.all(
    (paths.length
      ? paths
      : ['src/content/locales/de.json', 'src/content/locales/en.json']
    ).map(async (path) => flatten(JSON.parse(await readFile(path, 'utf8')))),
  );
  const failures = [];
  for (const key of new Set([...Object.keys(de), ...Object.keys(en)])) {
    if (!Object.hasOwn(de, key)) failures.push(`DE missing ${key}`);
    else if (!Object.hasOwn(en, key)) failures.push(`EN missing ${key}`);
    else if (JSON.stringify(de[key]) !== JSON.stringify(en[key]))
      failures.push(
        `Interpolation mismatch ${key}: DE=${de[key]} EN=${en[key]}`,
      );
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(
    `i18n: ${Object.keys(de).length} keys and interpolation variables match`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
