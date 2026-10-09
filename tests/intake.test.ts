// "References in" (round R2, look): /add copies files into the project's refs/ folder — never moves them —
// keeps their names (a clash gets -2, -3), tells their kind by name and by their first bytes, and refuses
// private names and folders.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { intakeFiles, kindOf, splitArgs } from '../src/project/intake.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const dirs: string[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('the kind of a file', () => {
  it('reads the first bytes, and the name when the bytes do not say', () => {
    expect(kindOf('a.png', PNG)).toEqual({ kind: 'image', by: 'bytes' });
    expect(kindOf('photo.jpg', JPEG)).toEqual({ kind: 'image', by: 'bytes' });
    expect(kindOf('x.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ kind: 'image', by: 'bytes' });
    expect(kindOf('x.heic', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0'))).toEqual({ kind: 'image', by: 'bytes' });
    expect(kindOf('clip.mov', Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0'))).toEqual({ kind: 'video', by: 'bytes' });
    expect(kindOf('clip.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toEqual({ kind: 'video', by: 'bytes' });
    expect(kindOf('doc.pdf', Buffer.from('%PDF-1.7'))).toEqual({ kind: 'document', by: 'bytes' });
    expect(kindOf('m.glb', Buffer.from('glTF\x02\0\0\0'))).toEqual({ kind: '3d', by: 'bytes' });
    expect(kindOf('notes.md', Buffer.from('# hi'))).toEqual({ kind: 'document', by: 'name' });
    expect(kindOf('scene.usdz', Buffer.from('PK\x03\x04'))).toEqual({ kind: '3d', by: 'name' });
    expect(kindOf('part.stl', Buffer.from('solid x'))).toEqual({ kind: '3d', by: 'name' });
    expect(kindOf('data.bin', Buffer.from('????'))).toEqual({ kind: 'other', by: 'name' });
    // The bytes win, and the mismatch is said.
    const odd = kindOf('fake.png', Buffer.from('%PDF-1.4'));
    expect(odd.kind).toBe('document');
    expect(odd.note).toContain('png');
  });

  it('splits a typed line into paths: quotes and backslash-escaped spaces', () => {
    expect(splitArgs('a.png "my file.jpg" b\\ c.pdf \'d e.md\'')).toEqual(['a.png', 'my file.jpg', 'b c.pdf', 'd e.md']);
  });
});

describe('copying files in', () => {
  it('copies (never moves) into refs/, keeps the name, and numbers a clash', () => {
    const root = temp('proj-');
    const out = temp('src-');
    writeFileSync(join(out, 'board.png'), PNG);
    const first = intakeFiles(root, [join(out, 'board.png')]);
    expect(first.refused).toEqual([]);
    expect(first.added).toEqual([{ path: 'refs/board.png', sha256: sha(PNG), bytes: PNG.length, kind: 'image', by: 'bytes', source_name: 'board.png' }]);
    expect(existsSync(join(out, 'board.png'))).toBe(true);
    expect(readFileSync(join(root, 'refs/board.png'))).toEqual(PNG);
    const second = intakeFiles(root, [join(out, 'board.png')]);
    expect(second.added[0].path).toBe('refs/board-2.png');
    expect(intakeFiles(root, [join(out, 'board.png')]).added[0].path).toBe('refs/board-3.png');
  });

  it('resolves a relative path against the folder given, and expands ~ only at the start', () => {
    const root = temp('proj-');
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'a.md'), '# a\n');
    const r = intakeFiles(root, ['in/a.md'], { cwd: root });
    expect(r.added.map((f) => [f.path, f.kind])).toEqual([['refs/a.md', 'document']]);
  });

  it('refuses private names, folders, missing files and a link to a private file', () => {
    const root = temp('proj-');
    const out = temp('src-');
    writeFileSync(join(out, '.env'), 'KEY=1');
    writeFileSync(join(out, 'id_ed25519'), 'key');
    writeFileSync(join(out, 'server.pem'), 'key');
    mkdirSync(join(out, 'folder'));
    symlinkSync(join(out, 'id_ed25519'), join(out, 'innocent.txt'));
    const r = intakeFiles(root, ['.env', 'id_ed25519', 'server.pem', 'folder', 'nothing.png', 'innocent.txt'].map((n) => join(out, n)));
    expect(r.added).toEqual([]);
    expect(r.refused.map((x) => x.name)).toEqual(['.env', 'id_ed25519', 'server.pem', 'folder', 'nothing.png', 'innocent.txt']);
    expect(r.refused.find((x) => x.name === 'folder')?.reason).toContain('folder');
    expect(r.refused.find((x) => x.name === 'innocent.txt')?.reason).toContain('private');
    for (const x of r.refused) expect(x.reason).not.toContain(out);
    expect(existsSync(join(root, 'refs'))).toBe(false);
  });

  it('refuses a refs folder that leads out of the project', () => {
    const root = temp('proj-');
    const elsewhere = temp('elsewhere-');
    symlinkSync(elsewhere, join(root, 'refs'));
    const out = temp('src-');
    writeFileSync(join(out, 'a.png'), PNG);
    const r = intakeFiles(root, [join(out, 'a.png')]);
    expect(r.added).toEqual([]);
    expect(r.refused[0].reason).toContain('outside the project');
    expect(existsSync(join(elsewhere, 'a.png'))).toBe(false);
  });
});
