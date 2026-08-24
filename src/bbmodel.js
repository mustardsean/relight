import * as THREE from 'three';

// Blockbench .bbmodel loader.
// Coordinates: Y-up, 1 unit = 1/16 block, same axes as three.js.
// Element from/to/origin are absolute model-space; group origins are absolute too,
// so each node's local position is (own origin - parent origin).

export function parseBBModel(json) {
  const resolution = json.resolution || { width: 16, height: 16 };
  const textures = (json.textures || []).map((t) => loadTexture(t));
  const materials = textures.map((tex) =>
    new THREE.MeshStandardMaterial({
      map: tex.texture,
      roughness: 1.0,
      metalness: 0.0,
      alphaTest: 0.5, // Minecraft-style hard cutout — no glassy low-alpha texels
      side: THREE.FrontSide,
    })
  );
  const fallbackMaterial = new THREE.MeshStandardMaterial({ color: 0x8866aa, roughness: 1 });

  const elementsById = new Map();
  for (const el of json.elements || []) elementsById.set(el.uuid, el);

  const root = new THREE.Group();
  root.name = json.name || 'bbmodel';

  // Newer Blockbench formats keep outliner nodes skeletal ({uuid, children})
  // with the real group data (name, origin, rotation) in a top-level groups
  // array; older files carry that data inline on the outliner nodes.
  const groupDataByUuid = new Map();
  for (const g of json.groups || []) {
    if (g && g.uuid) groupDataByUuid.set(g.uuid, g);
  }

  const groupsByUuid = new Map();
  const ctx = {
    resolution,
    textures,
    materials,
    fallbackMaterial,
    elementsById,
    groupsByUuid,
    groupDataByUuid,
  };
  const outliner = json.outliner || [];
  buildChildren(root, [0, 0, 0], outliner, ctx);

  // Scale: 16 units = 1 block = 1 world unit
  root.scale.setScalar(1 / 16);
  return { root, textures, materials, groupsByUuid, animations: json.animations || [] };
}

function buildChildren(parent, parentOrigin, nodes, ctx) {
  for (const node of nodes) {
    if (typeof node === 'string') {
      const el = ctx.elementsById.get(node);
      if (el) addElement(parent, parentOrigin, el, ctx);
    } else if (node && node.children) {
      const data = ctx.groupDataByUuid.get(node.uuid) || node;
      if (data.visibility === false || data.export === false) continue;
      if (node.visibility === false || node.export === false) continue;
      const group = new THREE.Group();
      group.name = node.name || data.name || 'group';
      const origin = node.origin || data.origin || [0, 0, 0];
      group.position.set(
        origin[0] - parentOrigin[0],
        origin[1] - parentOrigin[1],
        origin[2] - parentOrigin[2]
      );
      group.rotation.order = 'ZYX';
      const rotation = node.rotation || data.rotation;
      if (rotation) {
        group.rotation.set(
          THREE.MathUtils.degToRad(rotation[0]),
          THREE.MathUtils.degToRad(rotation[1]),
          THREE.MathUtils.degToRad(rotation[2])
        );
      }
      // Bind pose, restored before applying any animation frame
      group.userData.uuid = node.uuid;
      group.userData.bindPos = group.position.clone();
      group.userData.bindRot = group.rotation.clone();
      if (node.uuid) ctx.groupsByUuid.set(node.uuid, group);
      parent.add(group);
      buildChildren(group, origin, node.children, ctx);
    }
  }
}

function addElement(parent, parentOrigin, el, ctx) {
  if (el.visibility === false || el.export === false) return;
  if (el.type && el.type !== 'cube') return; // meshes/locators not supported yet

  const inflate = el.inflate || 0;
  const from = [el.from[0] - inflate, el.from[1] - inflate, el.from[2] - inflate];
  const to = [el.to[0] + inflate, el.to[1] + inflate, el.to[2] + inflate];
  const size = [
    Math.max(to[0] - from[0], 0.001),
    Math.max(to[1] - from[1], 0.001),
    Math.max(to[2] - from[2], 0.001),
  ];
  const center = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
  const origin = el.origin || [0, 0, 0];

  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  applyFaceUVs(geo, el, ctx);
  // Pivot the geometry around the element origin so element rotation works
  geo.translate(center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]);

  const usedMaterials = assignMaterialGroups(geo, el, ctx);
  const mesh = new THREE.Mesh(geo, usedMaterials);
  mesh.name = el.name || 'cube';
  // Local-space bounds (after the pivot translate) for the edge-stroke builder
  mesh.userData.boxLocal = {
    min: [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]],
    max: [to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]],
  };
  // Face UV data so the stroke builder can handle alpha-cutout cubes
  mesh.userData.faceProbes = FACE_ORDER.map((name) => {
    const face = el.faces?.[name];
    if (!face || face.texture === null || face.texture === undefined) return null;
    return { name, tex: face.texture, uv: face.uv, rotation: face.rotation || 0 };
  }).filter(Boolean);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  mesh.position.set(
    origin[0] - parentOrigin[0],
    origin[1] - parentOrigin[1],
    origin[2] - parentOrigin[2]
  );
  if (el.rotation) {
    mesh.rotation.order = 'ZYX';
    mesh.rotation.set(
      THREE.MathUtils.degToRad(el.rotation[0]),
      THREE.MathUtils.degToRad(el.rotation[1]),
      THREE.MathUtils.degToRad(el.rotation[2])
    );
  }
  parent.add(mesh);
}

// BoxGeometry face (group) order: px, nx, py, ny, pz, nz
// Blockbench face names in the same order:
const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];

function applyFaceUVs(geo, el, ctx) {
  const uvAttr = geo.getAttribute('uv');
  const resW = ctx.resolution.width;
  const resH = ctx.resolution.height;

  FACE_ORDER.forEach((faceName, faceIndex) => {
    const face = el.faces?.[faceName];
    const vertStart = faceIndex * 4; // 4 verts per box face, order TL TR BL BR
    if (!face || face.texture === null || face.texture === undefined) {
      return;
    }
    const tex = ctx.textures[face.texture];
    const w = tex?.uvWidth || resW;
    const h = tex?.uvHeight || resH;
    const [u1, v1, u2, v2] = face.uv;
    // Corners in TL TR BL BR order matching BoxGeometry plane vertex layout
    let corners = [
      [u1 / w, 1 - v1 / h],
      [u2 / w, 1 - v1 / h],
      [u1 / w, 1 - v2 / h],
      [u2 / w, 1 - v2 / h],
    ];
    const rot = face.rotation || 0;
    // Rotate mapping counter-clockwise in steps of 90deg: TL<-TR<-BR<-BL
    for (let r = 0; r < rot / 90; r++) {
      corners = [corners[1], corners[3], corners[0], corners[2]];
    }
    for (let i = 0; i < 4; i++) {
      uvAttr.setXY(vertStart + i, corners[i][0], corners[i][1]);
    }
  });
  uvAttr.needsUpdate = true;
}

function assignMaterialGroups(geo, el, ctx) {
  // BoxGeometry has 6 groups (one per face). Faces without a texture were
  // deleted in Blockbench — drop their groups so they don't render at all.
  const groups = geo.groups.map((g) => ({ start: g.start, count: g.count }));
  geo.clearGroups();
  const mats = [];
  groups.forEach((group, faceIndex) => {
    const face = el.faces?.[FACE_ORDER[faceIndex]];
    if (!face || face.texture === null || face.texture === undefined) return;
    const mat = ctx.materials[face.texture] || ctx.fallbackMaterial;
    let idx = mats.indexOf(mat);
    if (idx === -1) {
      mats.push(mat);
      idx = mats.length - 1;
    }
    geo.addGroup(group.start, group.count, idx);
  });
  if (!mats.length) mats.push(ctx.fallbackMaterial); // fully faceless cube
  return mats;
}

function loadTexture(t) {
  const texture = new THREE.Texture();
  const img = new Image();
  img.onload = () => {
    texture.image = img;
    texture.needsUpdate = true;
  };
  img.src = t.source; // data: URI embedded in the bbmodel
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  return {
    texture,
    name: t.name,
    source: t.source,
    uvWidth: t.uv_width || null,
    uvHeight: t.uv_height || null,
  };
}
