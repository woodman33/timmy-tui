#!/usr/bin/env node
// Defold engine-shelf fixture (engine-shelf/v0, shelf-w6d3 step 4).
//
// Writes lanes/engines/defold/fixtures/minimal/ — the smallest Defold project
// that exercises a sprite + atlas + script + input binding with NO native
// extensions (so bob builds locally, no build server) — and zips it as
// lanes/engines/defold/fixtures/minimal.defold.zip, the drop input every
// defold template's rules match (*.defold.zip).
//
//   node lanes/engines/defold/fixtures/make-minimal.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'minimal');
const zip = join(here, 'minimal.defold.zip');

// --- a 16x16 RGBA PNG: a 2x2 checker of orange/teal with a 1px dark border
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png16() {
  const w = 16, h = 16;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      const a = ((x >> 3) + (y >> 3)) & 1;
      const rgb = border ? [24, 24, 32] : a ? [255, 140, 40] : [40, 180, 170];
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const files = {
  'game.project': `[project]
title = minimal
version = 0.1.0
developer = timmy engine shelf

[bootstrap]
main_collection = /main/main.collectionc

[input]
game_binding = /input/game.input_bindingc

[display]
width = 640
height = 480

[script]
shared_state = 1

[html5]
archive_location_prefix = archive
`,
  'main/main.collection': `name: "main"
instances {
  id: "hero"
  prototype: "/main/hero.go"
  position {
    x: 320.0
    y: 240.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
  scale3 {
    x: 1.0
    y: 1.0
    z: 1.0
  }
}
scale_along_z: 0
`,
  'main/hero.go': `components {
  id: "main"
  component: "/main/main.script"
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
components {
  id: "sprite"
  component: "/main/hero.sprite"
  position {
    x: 0.0
    y: 0.0
    z: 0.0
  }
  rotation {
    x: 0.0
    y: 0.0
    z: 0.0
    w: 1.0
  }
}
`,
  'main/hero.sprite': `default_animation: "tile"
material: "/builtins/materials/sprite.material"
blend_mode: BLEND_MODE_ALPHA
textures {
  sampler: "texture_sampler"
  texture: "/main/main.atlas"
}
`,
  'main/main.atlas': `images {
  image: "/main/tile.png"
  sprite_trim_mode: SPRITE_TRIM_MODE_OFF
}
margin: 0
extrude_borders: 2
inner_padding: 0
`,
  'main/main.script': `-- minimal: spin the sprite, print on touch/space. No native extensions.
function init(self)
    msg.post(".", "acquire_input_focus")
    self.t = 0
end

function update(self, dt)
    self.t = self.t + dt
    go.set_rotation(vmath.quat_rotation_z(self.t))
end

function on_input(self, action_id, action)
    if action.pressed and (action_id == hash("touch") or action_id == hash("jump")) then
        print("minimal: input", action_id)
    end
end
`,
  'input/game.input_binding': `key_trigger {
  input: KEY_SPACE
  action: "jump"
}
mouse_trigger {
  input: MOUSE_BUTTON_1
  action: "touch"
}
`
};

rmSync(dir, { recursive: true, force: true });
for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
writeFileSync(join(dir, 'main', 'tile.png'), png16());

if (existsSync(zip)) rmSync(zip);
// zip from inside the folder so game.project sits at the archive root
const z = spawnSync('zip', ['-r', '-X', '-q', zip, '.', '-x', '.DS_Store', '-x', 'build/*', '-x', '.internal/*'], { cwd: dir, encoding: 'utf8' });
if (z.status !== 0) { process.stderr.write(z.stderr ?? ''); process.exit(1); }
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
console.log(JSON.stringify({ dir, zip, zip_sha256: sha(zip), png_sha256: sha(join(dir, 'main', 'tile.png')), files: Object.keys(files).concat('main/tile.png') }, null, 1));
