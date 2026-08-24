import * as THREE from 'three';

// Painted edge strokes: geometry ribbons expanded to a pixel width in the
// vertex shader, tapering to points at the ends like brush strokes. Each
// stroke knows two surface normals (the "corner" it sits on) and lights up
// only when that corner faces the key/rim light — the hand-painted
// edge-highlight look from Minecraft promo art. Being children of the cube
// meshes, they follow animation poses for free.
//
// Solid cubes get their 12 box edges. Alpha-cutout faces (drips, antlers,
// foliage panels) instead get strokes traced along the texture's alpha
// silhouette, so the paint follows the visible pixel shape, not the box.

const SEGMENTS = 4; // points per stroke = SEGMENTS + 1

export function createStrokeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidthPx: { value: 3.0 },
      uTaper: { value: 1.2 },
      uInset: { value: 0.06 },
      uThreshold: { value: 0.3 },
      uFalloff: { value: 1.6 },
      uRimDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uRimColor: { value: new THREE.Color(0xffffff) },
      uKeyColor: { value: new THREE.Color(0xffffff) },
      uRimI: { value: 2.2 },
      uKeyI: { value: 1.2 },
      uFogDensity: { value: 0.0 },
      // 0 glow (additive), 1 paint (normal), 2 ink (subtractive),
      // 3 screen, 4 lighten, 5 overlay (2·src·dst approximation)
      uBlendMode: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uResolution;
      uniform float uWidthPx;
      uniform float uTaper;
      uniform float uInset;
      uniform float uThreshold;
      uniform float uFalloff;
      uniform vec3 uRimDir;
      uniform vec3 uKeyDir;
      uniform vec3 uRimColor;
      uniform vec3 uKeyColor;
      uniform float uRimI;
      uniform float uKeyI;
      attribute vec3 aStart;
      attribute vec3 aEnd;
      attribute vec3 aN1;
      attribute vec3 aN2;
      attribute float aT;
      attribute float aSide;
      attribute float aRand;
      attribute float aHide;
      varying vec3 vColor;
      varying float vFogDepth;

      // An edge catches paint when its outward corner direction (the bevel
      // normal between its two faces) points at the light — same logic as a
      // specular catch on a chamfered corner.
      float litBy(vec3 corner, vec3 L) {
        float d = max(dot(corner, L), 0.0);
        d = max(d - uThreshold, 0.0) / (1.0 - uThreshold);
        return pow(d, uFalloff);
      }

      void main() {
        // Inset the stroke ends away from the corners, jittered per edge for a
        // hand-painted feel
        float inset = uInset * (0.6 + 0.8 * aRand);
        float t = mix(inset, 1.0 - inset, aT);
        vec3 pStart = mix(aStart, aEnd, inset);
        vec3 pEnd = mix(aEnd, aStart, inset);
        vec3 p = mix(aStart, aEnd, t);

        // Corner (bevel) direction of the edge, world space
        mat3 nm = mat3(modelMatrix);
        vec3 corner = normalize(nm * normalize(aN1 + aN2));
        float rim = litBy(corner, uRimDir);
        float key = litBy(corner, uKeyDir);

        // Brush profile: full width mid-stroke, tapering to points.
        // uTaper of 0 disables tapering entirely — uniform width, square ends.
        float profile = uTaper < 0.005 ? 1.0 : pow(max(sin(3.14159265 * aT), 0.0), uTaper);
        float widthScale = (0.75 + 0.5 * aRand) * aHide; // aHide 0 = user-erased stroke

        vColor = (uRimColor * rim * uRimI + uKeyColor * key * uKeyI)
               * mix(0.6, 1.0, profile) * aHide;

        vec4 mvP = modelViewMatrix * vec4(p, 1.0);
        vFogDepth = -mvP.z;
        // Nudge a small FIXED distance toward the camera so the stroke wins
        // the depth test against its own face but stays behind anything even
        // slightly nearer — a proportional nudge let strokes from rear panels
        // punch through the panel stacked in front of them.
        float depth = max(-mvP.z, 0.1);
        mvP.xyz *= max(1.0 - 0.008 / depth, 0.0);
        vec4 clipP = projectionMatrix * mvP;
        vec4 clipA = projectionMatrix * modelViewMatrix * vec4(pStart, 1.0);
        vec4 clipB = projectionMatrix * modelViewMatrix * vec4(pEnd, 1.0);

        // Screen-space perpendicular of the edge direction
        vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
        vec2 dir = normalize(clipB.xy / clipB.w * aspect - clipA.xy / clipA.w * aspect);
        vec2 perp = vec2(-dir.y, dir.x) / aspect;

        float halfWidth = uWidthPx * widthScale * profile;
        clipP.xy += perp * aSide * halfWidth * clipP.w * 2.0 / uResolution.y;

        gl_Position = clipP;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFogDensity;
      uniform float uBlendMode;
      varying vec3 vColor;
      varying float vFogDepth;
      void main() {
        float fogFactor = exp(-pow(uFogDensity * vFogDepth, 2.0));
        vec3 c = vColor * fogFactor;
        float m = max(c.r, max(c.g, c.b));
        if (m < 0.004) discard;
        if (uBlendMode < 0.5) {
          gl_FragColor = vec4(c, 1.0); // glow: additive, alpha ignored
        } else if (uBlendMode < 1.5) {
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), clamp(m, 0.0, 1.0)); // paint: lit-ness is opacity
        } else if (uBlendMode < 2.5) {
          gl_FragColor = vec4(c, 1.0); // ink: subtractive darkening
        } else {
          // screen / lighten / overlay run on GPU blend factors — clamp the
          // source so HDR values don't push the factors out of range
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // screen-space extrusion makes winding view-dependent
  });
}

// ---------------------------------------------------------------------------
// Generic ribbon builder: strokes = [{start:[3], end:[3], n1:[3], n2:[3]}]

function buildRibbonGeometry(strokes) {
  const pointsPerEdge = SEGMENTS + 1;
  const vertsPerEdge = pointsPerEdge * 2;
  const vertCount = strokes.length * vertsPerEdge;

  const aStart = new Float32Array(vertCount * 3);
  const aEnd = new Float32Array(vertCount * 3);
  const aN1 = new Float32Array(vertCount * 3);
  const aN2 = new Float32Array(vertCount * 3);
  const aT = new Float32Array(vertCount);
  const aSide = new Float32Array(vertCount);
  const aRand = new Float32Array(vertCount);
  const aHide = new Float32Array(vertCount).fill(1);
  const position = new Float32Array(vertCount * 3); // required attr, unused
  const index = [];

  strokes.forEach((edge, e) => {
    const rand = Math.random();
    const base = e * vertsPerEdge;
    for (let i = 0; i < pointsPerEdge; i++) {
      const t = i / SEGMENTS;
      for (let s = 0; s < 2; s++) {
        const v = base + i * 2 + s;
        aStart.set(edge.start, v * 3);
        aEnd.set(edge.end, v * 3);
        aN1.set(edge.n1, v * 3);
        aN2.set(edge.n2, v * 3);
        aT[v] = t;
        aSide[v] = s === 0 ? -1 : 1;
        aRand[v] = rand;
      }
      if (i < SEGMENTS) {
        const a = base + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(aStart, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 3));
  geo.setAttribute('aN1', new THREE.BufferAttribute(aN1, 3));
  geo.setAttribute('aN2', new THREE.BufferAttribute(aN2, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
  geo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1));
  geo.setAttribute('aHide', new THREE.BufferAttribute(aHide, 1));
  geo.setIndex(index);
  return geo;
}

const VERTS_PER_STROKE = (SEGMENTS + 1) * 2;

// Find the stroke nearest to a screen point (px). Strokes are extruded in the
// vertex shader, so regular raycasting can't see them — instead project every
// stroke's segment endpoints and measure 2D point-to-segment distance.
export function pickStroke(camera, screenX, screenY, width, height, roots, thresholdPx = 8) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let best = null;

  const toScreen = (v) => {
    v.project(camera);
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height, z: v.z };
  };

  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.name.startsWith('edge-strokes') || !obj.visible) return;
      const geo = obj.geometry;
      const aStart = geo.getAttribute('aStart');
      const aEnd = geo.getAttribute('aEnd');
      const aHide = geo.getAttribute('aHide');
      const strokeCount = aStart.count / VERTS_PER_STROKE;
      for (let s = 0; s < strokeCount; s++) {
        const vi = s * VERTS_PER_STROKE;
        if (aHide.getX(vi) < 0.5) continue; // already erased
        a.fromBufferAttribute(aStart, vi).applyMatrix4(obj.matrixWorld);
        b.fromBufferAttribute(aEnd, vi).applyMatrix4(obj.matrixWorld);
        const pa = toScreen(a);
        const pb = toScreen(b);
        if (pa.z > 1 || pb.z > 1 || pa.z < -1 || pb.z < -1) continue; // off-frustum
        // 2D point-to-segment distance
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((screenX - pa.x) * dx + (screenY - pa.y) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const px = pa.x + t * dx;
        const py = pa.y + t * dy;
        const dist = Math.hypot(screenX - px, screenY - py);
        if (dist > thresholdPx) continue;
        const depth = pa.z + t * (pb.z - pa.z);
        if (!best || dist < best.dist - 0.5 || (Math.abs(dist - best.dist) <= 0.5 && depth < best.depth)) {
          best = { mesh: obj, stroke: s, dist, depth };
        }
      }
    });
  }
  return best;
}

export function setStrokeHidden(mesh, strokeIndex, hidden) {
  const aHide = mesh.geometry.getAttribute('aHide');
  const base = strokeIndex * VERTS_PER_STROKE;
  for (let i = 0; i < VERTS_PER_STROKE; i++) aHide.setX(base + i, hidden ? 0 : 1);
  aHide.needsUpdate = true;
}

export function restoreAllStrokes(roots) {
  let restored = 0;
  for (const root of roots) {
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.name.startsWith('edge-strokes')) return;
      const aHide = obj.geometry.getAttribute('aHide');
      for (let i = 0; i < aHide.count; i++) {
        if (aHide.getX(i) < 0.5) restored++;
        aHide.setX(i, 1);
      }
      aHide.needsUpdate = true;
    });
  }
  return restored;
}

function makeStrokeMesh(strokes, material, name) {
  const mesh = new THREE.Mesh(buildRibbonGeometry(strokes), material);
  mesh.name = name;
  mesh.userData.noEdges = true;
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}

// The 12 edges of a box, each tagged with its two adjacent face names so the
// stroke builder can drop edges that touch a cutout face.
function boxEdges(min, max) {
  const edges = [];
  const c = (x, y, z) => [x, y, z];
  const yName = (s) => (s < 0 ? 'down' : 'up');
  const xName = (s) => (s < 0 ? 'west' : 'east');
  const zName = (s) => (s < 0 ? 'north' : 'south');
  // Along X: adjacent faces are ±Y and ±Z
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      edges.push({
        start: c(min[0], sy < 0 ? min[1] : max[1], sz < 0 ? min[2] : max[2]),
        end: c(max[0], sy < 0 ? min[1] : max[1], sz < 0 ? min[2] : max[2]),
        n1: [0, sy, 0],
        n2: [0, 0, sz],
        faces: [yName(sy), zName(sz)],
      });
    }
  }
  // Along Y: adjacent faces ±X and ±Z
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      edges.push({
        start: c(sx < 0 ? min[0] : max[0], min[1], sz < 0 ? min[2] : max[2]),
        end: c(sx < 0 ? min[0] : max[0], max[1], sz < 0 ? min[2] : max[2]),
        n1: [sx, 0, 0],
        n2: [0, 0, sz],
        faces: [xName(sx), zName(sz)],
      });
    }
  }
  // Along Z: adjacent faces ±X and ±Y
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      edges.push({
        start: c(sx < 0 ? min[0] : max[0], sy < 0 ? min[1] : max[1], min[2]),
        end: c(sx < 0 ? min[0] : max[0], sy < 0 ? min[1] : max[1], max[2]),
        n1: [sx, 0, 0],
        n2: [0, sy, 0],
        faces: [xName(sx), yName(sy)],
      });
    }
  }
  return edges;
}

// Attach box-edge stroke meshes to every cube mesh under root.
export function addStrokesToModel(root, material) {
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.userData.boxLocal) return;
    const { min, max } = obj.userData.boxLocal;
    obj.add(makeStrokeMesh(boxEdges(min, max), material, 'edge-strokes'));
  });
}

// ---------------------------------------------------------------------------
// Cutout handling: box corners + UV corners per face, in TL,TR,BL,BR order
// matching three's BoxGeometry plane layout and bbmodel.js applyFaceUVs.

function faceCorners3D(name, min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  switch (name) {
    case 'east':  return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z1], [x1, y0, z0]];
    case 'west':  return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z0], [x0, y0, z1]];
    case 'up':    return [[x0, y1, z0], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1]];
    case 'down':  return [[x0, y0, z1], [x1, y0, z1], [x0, y0, z0], [x1, y0, z0]];
    case 'south': return [[x0, y1, z1], [x1, y1, z1], [x0, y0, z1], [x1, y0, z1]];
    case 'north': return [[x1, y1, z0], [x0, y1, z0], [x1, y0, z0], [x0, y0, z0]];
    default: return null;
  }
}

const FACE_NORMALS = {
  east: [1, 0, 0], west: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1],
};

function faceCornersUV(uv, rotation) {
  const [u1, v1, u2, v2] = uv;
  let corners = [[u1, v1], [u2, v1], [u1, v2], [u2, v2]]; // TL TR BL BR
  for (let r = 0; r < rotation / 90; r++) {
    corners = [corners[1], corners[3], corners[0], corners[2]];
  }
  return corners;
}

// Trace the alpha silhouette of one face's UV rect and return strokes along
// the opaque/transparent boundary, mapped into cube-local 3D space.
function contourStrokes(probe, min, max, img, sx, sy) {
  const uvC = faceCornersUV(probe.uv, probe.rotation);
  const c3 = faceCorners3D(probe.name, min, max);
  const n = FACE_NORMALS[probe.name];
  if (!c3) return [];

  // Sliver faces (the thin sides of flat panels, up to ~1.5 units) map a
  // narrow UV strip onto near-zero geometry — tracing them draws box-like
  // outlines around the panel instead of following the art.
  const extU = Math.hypot(c3[1][0] - c3[0][0], c3[1][1] - c3[0][1], c3[1][2] - c3[0][2]);
  const extV = Math.hypot(c3[2][0] - c3[0][0], c3[2][1] - c3[0][1], c3[2][2] - c3[0][2]);
  if (Math.min(extU, extV) < 1.6) return [];

  // Pixel-space rect (absolute image coords)
  const us = probe.uv.map((v, i) => (i % 2 === 0 ? v * sx : v * sy));
  const px0 = Math.round(Math.min(us[0], us[2]));
  const px1 = Math.round(Math.max(us[0], us[2]));
  const py0 = Math.round(Math.min(us[1], us[3]));
  const py1 = Math.round(Math.max(us[1], us[3]));
  const w = px1 - px0;
  const h = py1 - py0;
  if (w <= 0 || h <= 0) return [];

  const opaque = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const ax = px0 + x;
    const ay = py0 + y;
    if (ax < 0 || ay < 0 || ax >= img.w || ay >= img.h) return false;
    return img.data.data[(ay * img.w + ax) * 4 + 3] > 128;
  };

  // Collect unit boundary edges (internal transitions only, not rect borders)
  // Horizontal runs: boundary between texel rows, keyed by y and outward sign
  const strokes = [];
  const MIN_RUN = 2;

  // Affine map: pixel coords -> 3D, via UV corner frame (also in pixel coords)
  const uvTL = [uvC[0][0] * sx, uvC[0][1] * sy];
  const eU = [uvC[1][0] * sx - uvTL[0], uvC[1][1] * sy - uvTL[1]];
  const eV = [uvC[2][0] * sx - uvTL[0], uvC[2][1] * sy - uvTL[1]];
  const det = eU[0] * eV[1] - eU[1] * eV[0];
  if (Math.abs(det) < 1e-6) return [];
  const E3U = [c3[1][0] - c3[0][0], c3[1][1] - c3[0][1], c3[1][2] - c3[0][2]];
  const E3V = [c3[2][0] - c3[0][0], c3[2][1] - c3[0][1], c3[2][2] - c3[0][2]];

  const map3 = (px, py) => {
    const du = px - uvTL[0];
    const dv = py - uvTL[1];
    const a = (du * eV[1] - dv * eV[0]) / det;
    const b = (eU[0] * dv - eU[1] * du) / det;
    return [
      c3[0][0] + a * E3U[0] + b * E3V[0],
      c3[0][1] + a * E3U[1] + b * E3V[1],
      c3[0][2] + a * E3U[2] + b * E3V[2],
    ];
  };
  const mapDir3 = (du, dv) => {
    const a = (du * eV[1] - dv * eV[0]) / det;
    const b = (eU[0] * dv - eU[1] * du) / det;
    const d = [
      a * E3U[0] + b * E3V[0],
      a * E3U[1] + b * E3V[1],
      a * E3U[2] + b * E3V[2],
    ];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / len, d[1] / len, d[2] / len];
  };

  const emit = (pxA, pyA, pxB, pyB, outU, outV) => {
    strokes.push({
      start: map3(px0 + pxA, py0 + pyA),
      end: map3(px0 + pxB, py0 + pyB),
      n1: n,
      n2: mapDir3(outU, outV),
    });
  };

  // Horizontal boundaries (between rows): outward -1 = up in texture space
  for (let y = 1; y < h; y++) {
    for (const sign of [-1, 1]) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const boundary =
          x < w &&
          (sign < 0 ? opaque(x, y) && !opaque(x, y - 1) : opaque(x, y - 1) && !opaque(x, y));
        if (boundary && runStart < 0) runStart = x;
        if (!boundary && runStart >= 0) {
          if (x - runStart >= MIN_RUN) emit(runStart, y, x, y, 0, sign < 0 ? -1 : 1);
          runStart = -1;
        }
      }
    }
  }
  // Vertical boundaries (between columns)
  for (let x = 1; x < w; x++) {
    for (const sign of [-1, 1]) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const boundary =
          y < h &&
          (sign < 0 ? opaque(x, y) && !opaque(x - 1, y) : opaque(x - 1, y) && !opaque(x, y));
        if (boundary && runStart < 0) runStart = y;
        if (!boundary && runStart >= 0) {
          if (y - runStart >= MIN_RUN) emit(x, runStart, x, y, sign < 0 ? -1 : 1, 0);
          runStart = -1;
        }
      }
    }
  }
  return strokes;
}

// Analyze textures; solid cubes keep box strokes, cutout cubes swap them for
// alpha-silhouette contour strokes.
export async function processStrokes(root, textures, resolution, material) {
  const imageDatas = await Promise.all(
    textures.map(async (t) => {
      try {
        const img = new Image();
        img.src = t.source;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        return { data: cx.getImageData(0, 0, cv.width, cv.height), w: img.width, h: img.height };
      } catch {
        return null;
      }
    })
  );

  const scales = textures.map((t) => ({
    sx: (imageDatas[textures.indexOf(t)]?.w || resolution.width) / (t?.uvWidth || resolution.width),
    sy: (imageDatas[textures.indexOf(t)]?.h || resolution.height) / (t?.uvHeight || resolution.height),
  }));

  const coverage = (probe) => {
    const img = imageDatas[probe.tex];
    if (!img) return 1;
    const { sx, sy } = scales[probe.tex];
    const x0 = Math.floor(Math.min(probe.uv[0], probe.uv[2]) * sx);
    const x1 = Math.ceil(Math.max(probe.uv[0], probe.uv[2]) * sx);
    const y0 = Math.floor(Math.min(probe.uv[1], probe.uv[3]) * sy);
    const y1 = Math.ceil(Math.max(probe.uv[1], probe.uv[3]) * sy);
    let opaque = 0;
    let total = 0;
    for (let y = Math.max(y0, 0); y < Math.min(y1, img.h); y++) {
      for (let x = Math.max(x0, 0); x < Math.min(x1, img.w); x++) {
        total++;
        if (img.data.data[(y * img.w + x) * 4 + 3] > 128) opaque++;
      }
    }
    return total > 0 ? opaque / total : 1;
  };

  // Fraction of opaque texels in the 1-texel strip along one border of a
  // face's UV region. A box edge only deserves a stroke if the art actually
  // reaches that edge — mostly-solid faces can still have transparent rims
  // (antler palms, drippy panels) where a stroke would float in air.
  const borderCoverage = (probe, edge, min, max) => {
    const img = imageDatas[probe.tex];
    if (!img) return 1;
    const { sx, sy } = scales[probe.tex];
    const c3 = faceCorners3D(probe.name, min, max);
    if (!c3) return 1;
    const uvC = faceCornersUV(probe.uv, probe.rotation).map(([u, v]) => [u * sx, v * sy]);
    // Which border of the face quad is this edge? Compare 3D endpoints.
    const near = (a, b) =>
      Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3;
    const borders = [
      [0, 1], // top    (TL-TR)
      [2, 3], // bottom (BL-BR)
      [0, 2], // left   (TL-BL)
      [1, 3], // right  (TR-BR)
    ];
    const border = borders.find(
      ([a, b]) =>
        (near(edge.start, c3[a]) && near(edge.end, c3[b])) ||
        (near(edge.start, c3[b]) && near(edge.end, c3[a]))
    );
    if (!border) return 1; // edge not on this face (shouldn't happen)
    const uvA = uvC[border[0]];
    const uvB = uvC[border[1]];
    const cx = (uvC[0][0] + uvC[1][0] + uvC[2][0] + uvC[3][0]) / 4;
    const cy = (uvC[0][1] + uvC[1][1] + uvC[2][1] + uvC[3][1]) / 4;
    const steps = Math.max(4, Math.round(Math.hypot(uvB[0] - uvA[0], uvB[1] - uvA[1])));
    let opaque = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      let u = uvA[0] + t * (uvB[0] - uvA[0]);
      let v = uvA[1] + t * (uvB[1] - uvA[1]);
      // nudge half a texel toward the face interior so we sample inside the rect
      const dx = cx - u;
      const dy = cy - v;
      const len = Math.hypot(dx, dy) || 1;
      u += (dx / len) * 0.5;
      v += (dy / len) * 0.5;
      const px = Math.min(img.w - 1, Math.max(0, Math.floor(u)));
      const py = Math.min(img.h - 1, Math.max(0, Math.floor(v)));
      if (img.data.data[(py * img.w + px) * 4 + 3] > 128) opaque++;
    }
    return opaque / steps;
  };

  let contoured = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.userData.faceProbes) return;
    const boxStrokes = obj.children.find((c) => c.name === 'edge-strokes');
    if (!boxStrokes) return;
    const probes = obj.userData.faceProbes;
    const probeByName = {};
    for (const p of probes) probeByName[p.name] = p;

    const covByName = {};
    for (const p of probes) covByName[p.name] = coverage(p);
    const solid = (name) => (covByName[name] === undefined ? 1 : covByName[name]) >= 0.75;

    boxStrokes.visible = false;
    const { min, max } = obj.userData.boxLocal;

    // Keep a box edge only when both adjacent faces exist (deleted faces
    // don't render, so their edges are open air) and the art is opaque along
    // that edge's border strip.
    const all = boxEdges(min, max).filter((e) =>
      e.faces.every((name) => {
        const probe = probeByName[name];
        return probe && borderCoverage(probe, e, min, max) >= 0.6;
      })
    );

    // Cutout faces get alpha-silhouette contours instead. Thin-axis dedupe:
    // opposing faces of a flat panel carry mirrored art; trace only one.
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axisOf = { east: 0, west: 0, up: 1, down: 1, south: 2, north: 2 };
    const negative = { west: 'east', down: 'up', north: 'south' };
    const names = new Set(probes.map((p) => p.name));

    for (const probe of probes) {
      if (solid(probe.name)) continue;
      const axis = axisOf[probe.name];
      if (size[axis] < 0.05 && negative[probe.name] && names.has(negative[probe.name])) continue;
      const img = imageDatas[probe.tex];
      if (!img) continue;
      const { sx, sy } = scales[probe.tex];
      all.push(...contourStrokes(probe, min, max, img, sx, sy));
    }
    if (all.length) {
      obj.add(makeStrokeMesh(all, material, 'edge-strokes-contour'));
      contoured++;
    }
  });
  console.log(`[edgestrokes] rebuilt strokes on ${contoured} cubes with cutout faces`);
}
