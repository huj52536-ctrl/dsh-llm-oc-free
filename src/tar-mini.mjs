// 最小 tar 读取器：只做一件事——从 .tgz 里取出指定路径的那一个普通文件。
//
// 为什么不调用系统 tar：那是外部依赖（Windows 10 以下、精简镜像、非 PATH 环境都可能没有），
// 而 npm tarball 的结构非常简单。zlib 是 Node 内置的，所以这条路径零依赖且跨平台。

import { createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;

function readString(buffer, offset, length) {
  const raw = buffer.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function readOctal(buffer, offset, length) {
  const raw = readString(buffer, offset, length).trim();
  if (!raw) return 0;
  const value = parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/** tar 里长文件名/长链接前缀存在 typeflag 'L'/'K' 的伪条目里。 */
function readPaxSize(buffer) {
  const text = buffer.toString('utf8');
  const match = /(\d+) size=(\d+)/.exec(text);
  return match ? { length: Number(match[1]), size: Number(match[2]) } : null;
}

/**
 * 从 gzip 压缩的 tar 里提取 `member` 到 `destination`。
 * @returns {Promise<boolean>} 是否找到了该成员并写出
 */
export async function extractMember(archive, member, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const gunzip = createGunzip();
  const source = createReadStream(archive);
  source.pipe(gunzip);

  let pending = Buffer.alloc(0);
  let longName = null;
  let pendingPax = null;
  let found = false;
  let completed = false;

  const out = createWriteStream(destination, { mode: 0o700 });

  const writeChunk = async (chunk) => {
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
  };

  try {
    for await (const chunk of gunzip) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= BLOCK) {
        const header = pending.subarray(0, BLOCK);
        // 两个连续的空块表示归档结束；一个空块就够我们收手了。
        if (header.every((byte) => byte === 0)) { completed = true; break; }

        const size = readOctal(header, 124, 12);
        const typeflag = String.fromCharCode(header[156] || 0x30);
        let name = longName ?? readString(header, 0, 100);
        const prefix = readString(header, 345, 155);
        if (!longName && prefix) name = `${prefix}/${name}`;
        longName = null;

        const bodyLength = Math.ceil(size / BLOCK) * BLOCK;
        if (pending.length < BLOCK + bodyLength) break; // 数据还没到齐

        const body = pending.subarray(BLOCK, BLOCK + size);
        pending = pending.subarray(BLOCK + bodyLength);

        if (typeflag === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
        if (typeflag === 'x' || typeflag === 'g') { pendingPax = readPaxSize(body); continue; }
        if (pendingPax) { pendingPax = null; }

        const normalized = name.replace(/^\.\//, '');
        if ((typeflag === '0' || typeflag === '\0' || typeflag === '0') && normalized === member) {
          await writeChunk(Buffer.from(body));
          found = true;
          completed = true;
          break;
        }
      }
      if (completed) break;
    }
  } finally {
    gunzip.destroy();
    source.destroy();
    await new Promise((resolve) => out.end(resolve));
  }

  if (!found) await fs.unlink(destination).catch(() => {});
  return found;
}
