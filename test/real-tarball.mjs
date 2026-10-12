#!/usr/bin/env node
// 用真实的 opencode-ai tarball 端到端验证 tar-mini：这不是"小文件"测试，
// 而是插件真正会下载的那个 180MB 包 —— 之前它产出 0 字节，说明有真实缺陷。
import { extractMember } from '../src/tar-mini.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const TMP = path.join(os.tmpdir(), 'ocfree-real-tar');
const ARCHIVE = path.join(TMP, 'opencode.tgz');
const MEMBER = 'package/bin/opencode.exe';

await fs.mkdir(TMP, { recursive: true });

if (!await fs.stat(ARCHIVE).then(() => true, () => false)) {
  console.log('下载 opencode-ai tarball（约 180MB，只做一次）…');
  const meta = await (await fetch('https://registry.npmjs.org/opencode-windows-x64/latest')).json();
  console.log(`  version=${meta.version} tarball=${meta.dist.tarball}`);
  const response = await fetch(meta.dist.tarball);
  await fs.writeFile(ARCHIVE, Buffer.from(await response.arrayBuffer()));
  console.log(`  已保存 ${(await fs.stat(ARCHIVE)).size} 字节`);
}

const out = path.join(TMP, 'opencode.exe');
await fs.rm(out, { force: true });
const ok = await extractMember(ARCHIVE, MEMBER, out);
const stat = await fs.stat(out).catch(() => null);
console.log(`\nfound=${ok} size=${stat?.size ?? 0}`);

if (!stat?.size) {
  console.error('✗ 提取失败或产出为空 —— 这就是插件里 0 字节 exe 的原因');
  process.exit(1);
}
// 真实的 Windows PE 头是 MZ
const head = (await fs.readFile(out)).subarray(0, 2).toString('ascii');
console.log(`PE 头 = ${JSON.stringify(head)}`);
console.log(`sha256 = ${createHash('sha256').update(await fs.readFile(out)).digest('hex').slice(0, 32)}…`);
if (head !== 'MZ') { console.error('✗ 不是有效的 Windows 可执行文件'); process.exit(1); }
console.log('\n✓ 提取出的确是有效的可执行文件');
