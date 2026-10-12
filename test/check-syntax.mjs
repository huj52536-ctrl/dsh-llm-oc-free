// 对 src/ 与 test/ 下所有 .mjs 做语法检查。
// 用脚本而不是把文件清单写死在 package.json 里：清单会漏（加文件时最容易忘）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.join(import.meta.dirname, '..');

async function collect(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [
  ...await collect(path.join(root, 'src')),
  ...await collect(path.join(root, 'test')),
].sort();

let failed = 0;
for (const file of files) {
  try {
    await run(process.execPath, ['--check', file]);
    console.log(`✓ ${path.relative(root, file)}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${path.relative(root, file)}\n${error.stderr ?? error.message}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} 个文件语法正确`);
process.exit(failed ? 1 : 0);
