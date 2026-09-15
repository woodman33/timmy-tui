import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseStrictJson, StrictJsonError } from './strict-json.js';

/** Read a bounded regular-file snapshot; refuse pipes, links, mutation and ambiguous JSON. */
export async function readStrictJsonFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 65536n) {
      throw new StrictJsonError('json_file_size', 'Request must be a regular file of 1–65536 bytes.');
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new StrictJsonError('json_file_changed', 'Request changed during inspection.');
    }
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await file.close(); }
}
