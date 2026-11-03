// Lists the English strings passed to t() / tn() in the app that have no translation yet.
//
//   node scripts/i18n-check.mjs                      every source file, every fragment merged
//   node scripts/i18n-check.mjs <fragment> <files…>  only these files against one fragment
//
// Exits 1 when something is missing. Needs Node 22.6+ (the .ts fragments are loaded with type
// stripping).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LANGS = ['uz', 'ru', 'es', 'tr', 'kk'];
const root = resolve(import.meta.dirname, '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'dict') out.push(...walk(p));
    } else if (/\.(tsx?)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const STR = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const T_CALL = new RegExp(String.raw`\bt\(\s*(?:${STR})`, 'g');
const TN_CALL = new RegExp(String.raw`\btn\(\s*[^,]+,\s*(?:${STR})\s*,\s*(?:${STR})`, 'g');
const unescape = (s) => s.replace(/\\(.)/g, '$1');

export function keysIn(file) {
  const src = readFileSync(file, 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(T_CALL)) keys.add(unescape(m[1] ?? m[2]));
  for (const m of src.matchAll(TN_CALL)) {
    keys.add(unescape(m[1] ?? m[2]));
    keys.add(unescape(m[3] ?? m[4]));
  }
  return keys;
}

async function loadFragment(p) {
  return (await import(pathToFileURL(resolve(p)).href)).default;
}

const [fragmentArg, ...fileArgs] = process.argv.slice(2);
let dict;
let files;
if (fragmentArg) {
  dict = await loadFragment(fragmentArg);
  files = fileArgs.map((f) => resolve(f));
} else {
  dict = Object.fromEntries(LANGS.map((l) => [l, {}]));
  const dictDir = join(root, 'src/i18n/dict');
  for (const name of readdirSync(dictDir)) {
    const f = await loadFragment(join(dictDir, name));
    for (const l of LANGS) Object.assign(dict[l], f[l]);
  }
  files = walk(join(root, 'src'));
}

let missing = 0;
for (const file of files) {
  for (const key of keysIn(file)) {
    const absent = LANGS.filter((l) => !(key in (dict[l] ?? {})));
    if (absent.length) {
      missing++;
      console.log(`${file.replace(root, '').replace(/\\/g, '/')}: [${absent.join(',')}] ${JSON.stringify(key)}`);
    }
  }
}
// Placeholders must survive translation.
for (const l of LANGS) {
  for (const [en, tr] of Object.entries(dict[l] ?? {})) {
    const want = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const got = [...tr.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    if (want !== got) {
      missing++;
      console.log(`placeholder mismatch [${l}] ${JSON.stringify(en)} -> ${JSON.stringify(tr)}`);
    }
  }
}
console.log(missing ? `${missing} missing` : 'all translated');
process.exit(missing ? 1 : 0);
