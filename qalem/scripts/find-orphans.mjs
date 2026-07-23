import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.resolve(ROOT, 'src');
const EXTS = ['.ts', '.tsx'];

// Matches vite.config.ts: resolve.alias -> { "@": path.resolve(__dirname, "./src") }
const ALIASES = [{ prefix: '@/', target: SRC }];

function resolveImport(fromFile, importPath) {
  let base = null;

  const alias = ALIASES.find((a) => importPath.startsWith(a.prefix));
  if (alias) {
    base = path.join(alias.target, importPath.slice(alias.prefix.length));
  } else if (importPath.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), importPath);
  } else {
    return null; // real package import, skip
  }

  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => path.join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function extractImports(content) {
  const importRe = /(?:import|export)(?:[^'"]*?)\sfrom\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const results = [];
  let m;
  while ((m = importRe.exec(content))) results.push(m[1]);
  while ((m = dynamicRe.exec(content))) results.push(m[1]);
  return results;
}

const visited = new Set();
const queue = [path.join(SRC, 'main.tsx')];

while (queue.length) {
  const file = queue.pop();
  if (!file || visited.has(file) || !fs.existsSync(file)) continue;
  visited.add(file);
  const content = fs.readFileSync(file, 'utf8');
  for (const imp of extractImports(content)) {
    const resolved = resolveImport(file, imp);
    if (resolved && !visited.has(resolved)) queue.push(resolved);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.includes(path.extname(entry.name)) && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const all = walk(SRC);
const orphans = all.filter((f) => !visited.has(f)).sort();

console.log(`Reachable from main.tsx: ${visited.size}`);
console.log(`Total .ts/.tsx files (excluding tests): ${all.length}`);
console.log(`Orphans (not reachable): ${orphans.length}\n`);
orphans.forEach((f) => console.log(path.relative(process.cwd(), f)));
