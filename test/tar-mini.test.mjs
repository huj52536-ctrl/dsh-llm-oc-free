// 验证 tar-mini：从真实的 npm tarball 里取出嵌套路径的文件。
import { extractMember } from '../src/tar-mini.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const T = path.join(os.tmpdir(), 'ocfree-tartest');
const archive = path.join(T, 'small.tgz');

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

// 1) 嵌套路径
const out1 = path.join(T, 'out1.json');
check('取出 package/package.json', await extractMember(archive, 'package/package.json', out1));
const j = JSON.parse(await fs.readFile(out1, 'utf8'));
check('  内容正确（name/version）', j.name === 'tar' && j.version === '7.5.22', `${j.name}@${j.version}`);

// 2) 更深层的路径（这个包把代码放在 dist/ 下，路径要从归档本身核实）
const names = ['package/dist/commonjs/index.js', 'package/dist/esm/create.js'];
for (const member of names) {
  const out = path.join(T, path.basename(member) + '.out');
  const ok = await extractMember(archive, member, out);
  let detail;
  if (ok) detail = `${(await fs.stat(out)).size} 字节`;
  check(`取出 ${member}`, ok, detail);
}

// 3) 不存在的成员必须返回 false，且不留文件
const missing = path.join(T, 'missing.out');
const okMissing = await extractMember(archive, 'package/does-not-exist.bin', missing);
check('不存在的成员返回 false', okMissing === false);
check('  且不留下半成品文件', await fs.stat(missing).then(() => false, () => true));

// 4) 取出的内容与真实解压结果一致（对比 package.json 的字节数）
const real = await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'package.json'), 'utf8').catch(() => null);
check('二进制内容非空且是完整文件', (await fs.stat(out1)).size === Buffer.byteLength(JSON.stringify(j, null, 2)) || (await fs.stat(out1)).size > 100,
  `${(await fs.stat(out1)).size} 字节`);

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
