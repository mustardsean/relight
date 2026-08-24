import * as THREE from 'three';

// Minecraft world diorama: fetch a block grid from the dev server's /__world
// endpoint, pack the block textures into an atlas, and mesh the slab with
// per-face culling. The result is a scene backdrop that receives the same
// lighting, shadows, and fog as the models.

const TINT = '#79c05a'; // grass/foliage tint (plains-ish)

function buildAtlas(textures, tintedNames) {
  const names = Object.keys(textures);
  const slots = new Map();
  const entries = [];
  for (const n of names) entries.push({ name: n, tint: false });
  for (const n of tintedNames) if (textures[n]) entries.push({ name: n, tint: true });

  const cols = Math.ceil(Math.sqrt(entries.length || 1));
  const rows = Math.ceil((entries.length || 1) / cols);
  const cell = 16;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;

  const cutout = new Set();
  return new Promise((resolve) => {
    let loaded = 0;
    if (!entries.length) return resolve({ canvas, slots, cutout, cols, rows });
    entries.forEach((entry, i) => {
      const img = new Image();
      img.onload = img.onerror = () => {
        const cx = (i % cols) * cell;
        const cy = Math.floor(i / cols) * cell;
        if (img.width) {
          // animated textures are vertical strips — take the first frame
          ctx.drawImage(img, 0, 0, img.width, img.width, cx, cy, cell, cell);
          if (entry.tint) {
            const region = ctx.getImageData(cx, cy, cell, cell);
            const d = region.data;
            const tr = parseInt(TINT.slice(1, 3), 16) / 255;
            const tg = parseInt(TINT.slice(3, 5), 16) / 255;
            const tb = parseInt(TINT.slice(5, 7), 16) / 255;
            for (let p = 0; p < d.length; p += 4) {
              d[p] *= tr;
              d[p + 1] *= tg;
              d[p + 2] *= tb;
            }
            ctx.putImageData(region, cx, cy);
          }
          const region = ctx.getImageData(cx, cy, cell, cell).data;
          for (let p = 3; p < region.length; p += 4) {
            if (region[p] < 250) {
              cutout.add(entry.name + (entry.tint ? '@t' : ''));
              break;
            }
          }
        }
        slots.set(entry.name + (entry.tint ? '@t' : ''), i);
        if (++loaded === entries.length) resolve({ canvas, slots, cutout, cols, rows });
      };
      img.src = 'data:image/png;base64,' + textures[entry.name];
    });
  });
}

// face -> quad corners (two CCW triangles: 0,1,2 / 0,2,3) and outward normal
const FACE_QUADS = {
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  south: [[1, 1, 1], [0, 1, 1], [0, 0, 1], [1, 0, 1]],
  north: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]],
  east: [[1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]],
  west: [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]],
};
const FACE_NORMALS = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  south: [0, 0, 1],
  north: [0, 0, -1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

export async function buildWorldMesh(world) {
  const [sx, sy, sz] = world.dims;
  const data = new Uint16Array(
    Uint8Array.from(atob(world.data), (c) => c.charCodeAt(0)).buffer
  );
  const idx = (x, y, z) => (z * sy + y) * sx + x;
  const blockAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null;
    return world.palette[data[idx(x, y, z)]] || null;
  };

  const tinted = new Set();
  for (const [name, b] of Object.entries(world.blocks)) {
    if (b.faces) for (const f of Object.values(b.faces)) if (f.tint && f.t) tinted.add(f.t);
    if (b.shape === 'cross' && b.tint && b.tex) tinted.add(b.tex);
  }
  const atlas = await buildAtlas(world.textures, tinted);
  const texture = new THREE.CanvasTexture(atlas.canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  // A block occludes its neighbours only if it's a plain cube with no cutout
  const occludes = new Map();
  for (const [name, b] of Object.entries(world.blocks)) {
    let solid = b.shape === 'cube' && !b.missing;
    if (solid && b.faces) {
      for (const f of Object.values(b.faces)) {
        const key = f.t + (f.tint ? '@t' : '');
        if (atlas.cutout.has(key)) solid = false;
      }
    }
    occludes.set(name, solid);
  }

  const buckets = {
    solid: { pos: [], nrm: [], uv: [], col: [] },
    cutout: { pos: [], nrm: [], uv: [], col: [] },
    liquid: { pos: [], nrm: [], uv: [], col: [] },
  };

  const slotUV = (key) => {
    const slot = atlas.slots.get(key);
    if (slot === undefined) return null;
    const cx = slot % atlas.cols;
    const cy = Math.floor(slot / atlas.cols);
    const e = 0.02; // bleed inset (texels)
    return {
      u0: (cx * 16 + e) / (atlas.cols * 16),
      v0: 1 - (cy * 16 + 16 - e) / (atlas.rows * 16),
      u1: (cx * 16 + 16 - e) / (atlas.cols * 16),
      v1: 1 - (cy * 16 + e) / (atlas.rows * 16),
    };
  };

  const pushQuad = (bucket, corners, normal, uvRect, shade) => {
    const { pos, nrm, uv, col } = bucket;
    const order = [0, 1, 2, 0, 2, 3];
    const uvs = [
      [uvRect.u0, uvRect.v1],
      [uvRect.u1, uvRect.v1],
      [uvRect.u1, uvRect.v0],
      [uvRect.u0, uvRect.v0],
    ];
    for (const o of order) {
      pos.push(...corners[o]);
      nrm.push(...normal);
      uv.push(...uvs[o]);
      col.push(shade, shade, shade);
    }
  };

  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const name = world.palette[data[idx(x, y, z)]];
        if (!name) continue;
        const b = world.blocks[name];
        if (!b) continue;

        if (b.shape === 'cross') {
          const key = b.tex + (b.tint ? '@t' : '');
          const rect = slotUV(key) || slotUV(b.tex);
          if (!rect) continue;
          for (const [a, c] of [
            [[x + 0.1, z + 0.1], [x + 0.9, z + 0.9]],
            [[x + 0.9, z + 0.1], [x + 0.1, z + 0.9]],
          ]) {
            pushQuad(
              buckets.cutout,
              [
                [a[0], y + 1, a[1]],
                [c[0], y + 1, c[1]],
                [c[0], y, c[1]],
                [a[0], y, a[1]],
              ],
              [0, 1, 0],
              rect,
              1
            );
          }
          continue;
        }

        if (b.shape === 'liquid') {
          const above = blockAt(x, y + 1, z);
          if (above && world.blocks[above]?.shape === 'liquid') continue;
          const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
          const co = [
            [x, y + 0.88, z],
            [x, y + 0.88, z + 1],
            [x + 1, y + 0.88, z + 1],
            [x + 1, y + 0.88, z],
          ];
          buckets.liquid.pos.push(...co[0], ...co[1], ...co[2], ...co[0], ...co[2], ...co[3]);
          for (let i = 0; i < 6; i++) buckets.liquid.nrm.push(0, 1, 0);
          for (let i = 0; i < 6; i++) buckets.liquid.uv.push(0, 0);
          const c = new THREE.Color(b.color || '#3f5fd6');
          for (let i = 0; i < 6; i++) buckets.liquid.col.push(c.r, c.g, c.b);
          continue;
        }

        // cube
        for (const [face, quad] of Object.entries(FACE_QUADS)) {
          const n = FACE_NORMALS[face];
          const neighbour = blockAt(x + n[0], y + n[1], z + n[2]);
          if (neighbour && occludes.get(neighbour)) continue;
          let rect;
          let shade = 1;
          if (b.missing || !b.faces) {
            rect = { u0: 0, v0: 0, u1: 0.0001, v1: 0.0001 };
            shade = 0.5;
          } else {
            const f = b.faces[face];
            rect = slotUV(f.t + (f.tint ? '@t' : '')) || slotUV(f.t);
            if (!rect) continue;
          }
          // simple directional shade like Minecraft: top 1, sides .8/.6, bottom .5
          if (face === 'north' || face === 'south') shade *= 0.82;
          if (face === 'east' || face === 'west') shade *= 0.7;
          if (face === 'down') shade *= 0.55;
          const key = b.faces ? b.faces[face].t + (b.faces[face].tint ? '@t' : '') : '';
          const bucket = atlas.cutout.has(key) ? buckets.cutout : buckets.solid;
          pushQuad(
            bucket,
            quad.map((c) => [x + c[0], y + c[1], z + c[2]]),
            n,
            rect,
            shade
          );
        }
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'minecraft-world';
  const makeMesh = (bucket, opts) => {
    if (!bucket.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(bucket.col, 3));
    const mat = new THREE.MeshStandardMaterial({
      map: opts.map ? texture : null,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      ...opts.material,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.noEdges = true;
    group.add(mesh);
  };
  makeMesh(buckets.solid, { map: true, material: {} });
  makeMesh(buckets.cutout, {
    map: true,
    material: { alphaTest: 0.5, side: THREE.DoubleSide },
  });
  makeMesh(buckets.liquid, {
    map: false,
    material: { transparent: true, opacity: 0.75, depthWrite: false },
  });

  // Place the queried centre at the scene origin with the surface at y=0
  const [x0, yMin, z0] = world.origin;
  const [cx, surfaceY, cz] = world.center;
  group.position.set(x0 - cx, yMin - (surfaceY + 1), z0 - cz);
  return group;
}
