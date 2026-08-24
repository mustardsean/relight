// Dev-only Minecraft world loader. POST /__world with a world save path and
// coordinates; responds with a block grid (palette + indices), per-block face
// texture assignments resolved from the vanilla jar's blockstate/model chain,
// and the texture PNGs themselves. The browser meshes it as a diorama.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);

const VERSION_CANDIDATES = ['1.21.4', '1.21.1', '1.21', '1.20.4'];
const AIR = new Set(['air', 'cave_air', 'void_air']);
const TINTED_BLOCKS = /^(short_grass|tall_grass|grass|fern|large_fern|vine|lily_pad|sugar_cane)$/;
const TINTED_LEAVES = /_leaves$/;

let jarCache = null; // { blockstates, models, texturePngs } from the vanilla jar
const resolveCache = new Map();

async function loadJar(jarPath) {
  if (jarCache && jarCache.path === jarPath) return jarCache;
  const zip = await JSZip.loadAsync(fs.readFileSync(jarPath));
  const blockstates = new Map();
  const models = new Map();
  const textures = new Map();
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith('assets/minecraft/blockstates/') && name.endsWith('.json')) {
      blockstates.set(path.basename(name, '.json'), JSON.parse(await zip.files[name].async('string')));
    } else if (name.startsWith('assets/minecraft/models/block/') && name.endsWith('.json')) {
      models.set('block/' + path.basename(name, '.json'), JSON.parse(await zip.files[name].async('string')));
    } else if (name.startsWith('assets/minecraft/textures/block/') && name.endsWith('.png')) {
      textures.set('block/' + path.basename(name, '.png'), await zip.files[name].async('base64'));
    }
  }
  jarCache = { path: jarPath, blockstates, models, textures };
  resolveCache.clear();
  return jarCache;
}

function stripNs(ref) {
  return ref ? ref.replace(/^minecraft:/, '') : ref;
}

// Walk the model parent chain, merging texture maps, and note the root parent
function resolveModel(jar, modelRef) {
  let textures = {};
  let chain = [];
  let ref = stripNs(modelRef);
  for (let depth = 0; ref && depth < 8; depth++) {
    const model = jar.models.get(ref);
    if (!model) break;
    chain.push(ref);
    textures = { ...model.textures, ...textures }; // child wins
    ref = stripNs(model.parent);
    if (ref && !ref.startsWith('block/')) ref = null; // builtin/generated
  }
  const deref = (key) => {
    let t = textures[key];
    for (let i = 0; t && t.startsWith('#') && i < 6; i++) t = textures[t.slice(1)];
    return t ? stripNs(t) : null;
  };
  return { chain, textures, deref };
}

function resolveBlock(jar, name) {
  if (resolveCache.has(name)) return resolveCache.get(name);
  let out;
  if (name === 'water') out = { shape: 'liquid', color: '#3f5fd6' };
  else if (name === 'lava') out = { shape: 'liquid', color: '#e06611' };
  else {
    const state = jar.blockstates.get(name);
    let modelRef = null;
    if (state?.variants) {
      const first = Object.values(state.variants)[0];
      modelRef = (Array.isArray(first) ? first[0] : first)?.model;
    } else if (state?.multipart?.length) {
      const apply = state.multipart[0].apply;
      modelRef = (Array.isArray(apply) ? apply[0] : apply)?.model;
    }
    if (!modelRef) out = { shape: 'cube', missing: true };
    else {
      const { chain, deref } = resolveModel(jar, modelRef);
      const isCross = chain.some((c) => c.includes('cross'));
      const tintAll = TINTED_BLOCKS.test(name) || TINTED_LEAVES.test(name);
      if (isCross) {
        out = { shape: 'cross', tex: deref('cross') || deref('particle'), tint: tintAll };
      } else {
        const all = deref('all');
        const side = deref('side');
        const end = deref('end');
        const top = deref('top') || end || all;
        const bottom = deref('bottom') || end || all;
        const fallback = all || side || top || deref('texture') || deref('particle');
        const faces = {
          up: { t: deref('up') || top || fallback, tint: tintAll || name === 'grass_block' },
          down: { t: deref('down') || bottom || fallback, tint: tintAll },
          north: { t: deref('north') || side || fallback, tint: tintAll },
          south: { t: deref('south') || side || fallback, tint: tintAll },
          east: { t: deref('east') || side || fallback, tint: tintAll },
          west: { t: deref('west') || side || fallback, tint: tintAll },
        };
        out = faces.up.t ? { shape: 'cube', faces } : { shape: 'cube', missing: true };
      }
    }
  }
  resolveCache.set(name, out);
  return out;
}

function defaultJarPath() {
  const roots = [
    path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'versions'),
    path.join(os.homedir(), 'curseforge', 'minecraft', 'Install', 'versions'),
  ];
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  let best = null;
  let bestKey = [];
  for (const versions of roots) {
    if (!fs.existsSync(versions)) continue;
    for (const d of fs.readdirSync(versions)) {
      if (!/^\d+(\.\d+)*$/.test(d)) continue; // releases only, no snapshots/pre
      const jar = path.join(versions, d, `${d}.jar`);
      if (!fs.existsSync(jar)) continue;
      const key = d.split('.').map(Number);
      if (!best || cmp(key, bestKey) > 0) {
        best = jar;
        bestKey = key;
      }
    }
  }
  return best;
}

async function loadWorldGrid(body) {
  const { path: worldPath, x, z } = body;
  const radius = Math.min(body.radius || 32, 96);
  const regionDir = path.join(worldPath, 'region');
  if (!fs.existsSync(regionDir)) throw new Error(`no region folder at ${regionDir}`);

  let anvil = null;
  let mcData = null;
  let lastErr = null;
  for (const v of body.version ? [body.version, ...VERSION_CANDIDATES] : VERSION_CANDIDATES) {
    try {
      const Anvil = require('prismarine-provider-anvil').Anvil(v);
      anvil = new Anvil(regionDir);
      mcData = require('minecraft-data')(v);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!anvil) throw new Error(`no usable minecraft-data version: ${lastErr}`);

  const stateToName = [];
  for (const b of mcData.blocksArray) {
    for (let s = b.minStateId; s <= b.maxStateId; s++) stateToName[s] = b.name;
  }

  const Vec3 = require('vec3');
  const x0 = Math.floor(x - radius);
  const z0 = Math.floor(z - radius);
  const sx = radius * 2;
  const sz = radius * 2;

  // Load all covered chunks once
  const chunks = new Map();
  for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + sx - 1) / 16); cx++) {
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + sz - 1) / 16); cz++) {
      try {
        chunks.set(`${cx},${cz}`, await anvil.load(cx, cz));
      } catch {
        chunks.set(`${cx},${cz}`, null);
      }
    }
  }
  const blockName = (wx, wy, wz) => {
    const col = chunks.get(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`);
    if (!col) return null;
    try {
      const id = col.getBlockStateId(new Vec3(((wx % 16) + 16) % 16, wy, ((wz % 16) + 16) % 16));
      return stateToName[id] || null;
    } catch {
      return null;
    }
  };

  // Find the surface at the center — skip vegetation and thin cover so a
  // model placed at origin stands on actual ground, not a treetop
  const NOT_GROUND = /_leaves$|_log$|_wood$|^snow$|powder_snow|_sapling$|grass$|fern$|bush|flower|vine|_plant$|sugar_cane|bamboo|mushroom|pumpkin|melon/;
  let surfaceY = 64;
  for (let yy = 200; yy > -60; yy--) {
    const n = blockName(Math.floor(x), yy, Math.floor(z));
    if (n && !AIR.has(n) && !NOT_GROUND.test(n)) {
      surfaceY = yy;
      break;
    }
  }
  const yMin = body.yMin ?? surfaceY - (body.depth ?? 6);
  const yMax = body.yMax ?? surfaceY + (body.height ?? 42);
  const sy = yMax - yMin + 1;

  const palette = [null]; // 0 = air
  const paletteIndex = new Map();
  const data = new Uint16Array(sx * sy * sz);
  let filled = 0;
  for (let dz = 0; dz < sz; dz++) {
    for (let dxx = 0; dxx < sx; dxx++) {
      for (let dy = 0; dy < sy; dy++) {
        const n = blockName(x0 + dxx, yMin + dy, z0 + dz);
        if (!n || AIR.has(n)) continue;
        let pi = paletteIndex.get(n);
        if (pi === undefined) {
          pi = palette.length;
          palette.push(n);
          paletteIndex.set(n, pi);
        }
        data[(dz * sy + dy) * sx + dxx] = pi;
        filled++;
      }
    }
  }

  // Resolve textures for every block in the palette
  const jarPath = body.jarPath || defaultJarPath();
  if (!jarPath) throw new Error('no Minecraft jar found for textures — pass jarPath');
  const jar = await loadJar(jarPath);
  const blocks = {};
  const texNames = new Set();
  for (const name of palette) {
    if (!name) continue;
    const r = resolveBlock(jar, name);
    blocks[name] = r;
    if (r.faces) for (const f of Object.values(r.faces)) texNames.add(f.t);
    if (r.tex) texNames.add(r.tex);
  }
  const textures = {};
  for (const t of texNames) {
    if (t && jar.textures.has(t)) textures[t] = jar.textures.get(t);
  }

  return {
    dims: [sx, sy, sz],
    origin: [x0, yMin, z0],
    center: [x, surfaceY, z],
    palette,
    data: Buffer.from(data.buffer).toString('base64'),
    blocks,
    textures,
    filled,
  };
}

export function worldEndpoint() {
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });
  return {
    name: 'world-endpoint',
    configureServer(server) {
      server.middlewares.use('/__world', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('{"error":"POST only"}');
        }
        try {
          const body = JSON.parse(await readBody(req));
          const result = await loadWorldGrid(body);
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
        }
      });
    },
  };
}
