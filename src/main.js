import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import GUI from 'lil-gui';
import { parseBBModel } from './bbmodel.js';
import { PostFX } from './postfx.js';
import { LightRig, PRESETS } from './rig.js';
import { compileAnimation, applyPose, resetPose } from './animation.js';
import {
  createStrokeMaterial,
  addStrokesToModel,
  processStrokes,
  pickStroke,
  setStrokeHidden,
  restoreAllStrokes,
} from './edgestrokes.js';
import { buildWorldMesh } from './world.js';

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1d24');

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
camera.position.set(4, 2.5, 5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const rig = new LightRig(scene);
const postfx = new PostFX(renderer, scene, camera);
const strokeMaterial = createStrokeMaterial();

// ---------------------------------------------------------------------------
// Render camera: place it once, orbit freely, exports always fire from it at
// a fixed aspect — the viewport shape never leaks into renders.
let renderCam = null;
let camHelper = null;
const camState = { aspect: '16:9' };
const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, Viewport: null };

function setRenderCameraFromView() {
  if (!renderCam) renderCam = new THREE.PerspectiveCamera();
  renderCam.fov = camera.fov;
  renderCam.near = camera.near;
  renderCam.far = camera.far;
  renderCam.position.copy(camera.position);
  renderCam.quaternion.copy(camera.quaternion);
  renderCam.userData.target = controls.target.clone();
  renderCam.updateProjectionMatrix();
  renderCam.updateMatrixWorld(true);
  // Helper uses a short-frustum clone so the viewport shows a small pyramid,
  // not a scene-sized one
  if (camHelper) {
    scene.remove(camHelper);
    camHelper.dispose();
  }
  const displayCam = renderCam.clone();
  displayCam.far = Math.max(sceneRadius * 0.5, 1);
  displayCam.updateProjectionMatrix();
  displayCam.updateMatrixWorld(true);
  camHelper = new THREE.CameraHelper(displayCam);
  camHelper.userData.noEdges = true;
  scene.add(camHelper);
}

function lookThroughCamera() {
  if (!renderCam) return;
  camera.position.copy(renderCam.position);
  if (renderCam.userData.target) controls.target.copy(renderCam.userData.target);
  camera.fov = renderCam.fov;
  camera.updateProjectionMatrix();
}

function clearRenderCamera() {
  if (camHelper) {
    scene.remove(camHelper);
    camHelper.dispose();
    camHelper = null;
  }
  renderCam = null;
}

// ---------------------------------------------------------------------------
// Minecraft world diorama
let worldGroup = null;
const worldOpts = { path: '', x: 0, z: 0, radius: 32 };

async function loadWorld(opts = {}) {
  const body = { ...worldOpts, ...opts };
  if (!body.path) throw new Error('world path required (folder containing level.dat)');
  const statusEl = document.getElementById('jobstatus');
  if (statusEl) statusEl.textContent = '⛏ loading world…';
  try {
    const res = await fetch('/__world', { method: 'POST', body: JSON.stringify(body) }).then((r) =>
      r.json()
    );
    if (res.error) throw new Error(res.error);
    clearWorld();
    worldGroup = await buildWorldMesh(res);
    scene.add(worldGroup);
    rig.ground.visible = false; // terrain replaces the shadow-catcher disc
    Object.assign(worldOpts, { path: body.path, x: body.x, z: body.z, radius: body.radius });
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    return { filled: res.filled, palette: res.palette.length - 1, dims: res.dims };
  } finally {
    if (statusEl) statusEl.textContent = '';
  }
}

function clearWorld() {
  if (!worldGroup) return;
  scene.remove(worldGroup);
  worldGroup.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
  worldGroup = null;
  rig.ground.visible = true;
}

// ---------------------------------------------------------------------------
// Video shots: a duration, fps, and camera keyframes (evenly spaced in time,
// smoothed with Catmull-Rom + global ease). Each model that has an animation
// selected plays it during the clip; static poses stay frozen.
const shot = { duration: 6, fps: 30, cameraKeys: [], background: 'scene' };
const videoCam = new THREE.PerspectiveCamera();
let videoBusy = false;

function addShotKey() {
  shot.cameraKeys.push({
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    fov: camera.fov,
  });
  updateShotLabel();
}

function clearShotKeys() {
  shot.cameraKeys = [];
  updateShotLabel();
}

function updateShotLabel() {
  const el = document.getElementById('bonename');
  if (el) el.textContent = shot.cameraKeys.length ? ` · ${shot.cameraKeys.length} camera keys` : '';
}

// t in [0,1] across the clip -> camera pose along the keyframe path
function evalShotCamera(t) {
  const keys = shot.cameraKeys;
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];
  const e = t * t * (3 - 2 * t); // ease the whole move in and out
  const posCurve = new THREE.CatmullRomCurve3(
    keys.map((k) => new THREE.Vector3(...k.position)),
    false,
    'centripetal'
  );
  const tgtCurve = new THREE.CatmullRomCurve3(
    keys.map((k) => new THREE.Vector3(...k.target)),
    false,
    'centripetal'
  );
  const seg = Math.min(Math.floor(e * (keys.length - 1)), keys.length - 2);
  const u = e * (keys.length - 1) - seg;
  return {
    position: posCurve.getPoint(e).toArray(),
    target: tgtCurve.getPoint(e).toArray(),
    fov: keys[seg].fov + (keys[seg + 1].fov - keys[seg].fov) * u,
  };
}

async function renderVideo(name = 'clip', scale = null) {
  if (videoBusy) throw new Error('a video render is already running');
  if (!models.length) throw new Error('no models loaded');
  videoBusy = true;
  const statusEl = document.getElementById('jobstatus');
  try {
    const sc = Number(scale || params.exportScale);
    let { w, h } = exportDims(sc);
    w -= w % 2; // h264 requires even dimensions
    h -= h % 2;
    const totalFrames = Math.max(1, Math.round(shot.duration * shot.fps));

    const alpha = shot.background === 'transparent';
    const begin = await fetch('/__video/begin', {
      method: 'POST',
      body: JSON.stringify({ name, fps: shot.fps, alpha }),
    }).then((r) => r.json());
    if (begin.error) throw new Error(begin.error);

    // Freeze scene chrome, size the renderer once for all frames
    const oldRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    postfx.setSize(w, h);
    const oldHandles = params.showHandles;
    params.showHandles = false;
    boneControls.visible = false;
    selBox.visible = false;
    if (camHelper) camHelper.visible = false;
    // Keying/compositing backgrounds: kill everything that would contaminate
    // the matte — fog tint, corner vignette, bloom spill, the ground shadow
    if (shot.background === 'green') {
      scene.background = new THREE.Color(0x00ff00);
      scene.fog = null;
      postfx.edgePass.uniforms.vignette.value = 0;
      postfx.bloomPass.enabled = false;
      postfx.bokehPass.enabled = false; // blur would pull green into the key edge
      rig.ground.visible = false;
    } else if (shot.background === 'transparent') {
      scene.background = null;
      scene.fog = null;
      postfx.edgePass.uniforms.vignette.value = 0;
      postfx.bloomPass.enabled = false;
      postfx.bokehPass.enabled = false; // bokeh pass does not preserve alpha
      rig.ground.visible = false;
    } else if (params.exportTransparent) {
      scene.background = new THREE.Color(params.background);
    }

    // Remember animation cursors so the viewport resumes where it was
    const animState = models.map((m) => ({ ...m.poseState }));

    const baseCam = renderCam || camera;
    try {
      for (let f = 0; f < totalFrames; f++) {
        const t = f / shot.fps;
        for (const m of models) {
          const anim = m.anims.get(m.poseState.anim);
          if (anim && anim.length > 0) {
            applyPose(anim, (m.poseState.time + t * m.poseState.speed) % anim.length, m.groups);
          }
        }
        const key = evalShotCamera(totalFrames > 1 ? f / (totalFrames - 1) : 0);
        const cam = key ? videoCam : baseCam;
        if (key) {
          videoCam.fov = key.fov;
          videoCam.near = baseCam.near;
          videoCam.far = baseCam.far;
          videoCam.position.set(...key.position);
          videoCam.lookAt(new THREE.Vector3(...key.target));
        }
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        renderFrame(cam);
        const frame = await fetch(`/__video/frame?id=${begin.id}&index=${f}`, {
          method: 'POST',
          body: canvas.toDataURL('image/png'),
        }).then((r) => r.json());
        if (frame.error) throw new Error(frame.error);
        if (statusEl && f % 5 === 0)
          statusEl.textContent = `🎞 frame ${f + 1}/${totalFrames}`;
      }
    } finally {
      params.showHandles = oldHandles;
      rig.ground.visible = true;
      renderer.setPixelRatio(oldRatio);
      resize();
      applyParams();
      models.forEach((m, i) => Object.assign(m.poseState, animState[i]));
      models.forEach((m) => {
        const anim = m.anims.get(m.poseState.anim);
        if (anim) applyPose(anim, m.poseState.time, m.groups);
      });
    }

    if (statusEl) statusEl.textContent = '🎞 encoding…';
    const end = await fetch(`/__video/end?id=${begin.id}`, { method: 'POST' }).then((r) =>
      r.json()
    );
    if (end.error) throw new Error(end.error);
    if (statusEl) statusEl.textContent = '';
    return end.file;
  } finally {
    videoBusy = false;
    const statusEl2 = document.getElementById('jobstatus');
    if (statusEl2 && statusEl2.textContent.startsWith('🎞')) statusEl2.textContent = '';
  }
}

// Export size: fixed-aspect long edge of 960px at 1x (so 2x = 1920)
function exportDims(scale) {
  const a = ASPECTS[camState.aspect];
  if (!a) return { w: Math.round(canvas.clientWidth * scale), h: Math.round(canvas.clientHeight * scale) };
  const long = 960 * scale;
  return a >= 1
    ? { w: Math.round(long), h: Math.round(long / a) }
    : { w: Math.round(long * a), h: Math.round(long) };
}

// ---------------------------------------------------------------------------
// HDRI environment (IBL + optional visible sky background)
const pmremGen = new THREE.PMREMGenerator(renderer);
const hdri = { equirect: null, pmremRT: null, name: null, loading: null };

function applyHdriTexture(texture, name) {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  if (hdri.pmremRT) hdri.pmremRT.dispose();
  if (hdri.equirect) hdri.equirect.dispose();
  hdri.pmremRT = pmremGen.fromEquirectangular(texture);
  hdri.equirect = texture;
  hdri.name = name;
  applyParams();
}

function loadHdriUrl(url, name) {
  const loader = /\.hdr$/i.test(name) ? new RGBELoader() : new EXRLoader();
  hdri.loading = name;
  document.getElementById('modelname').textContent = `loading ${name}…`;
  loader.load(
    url,
    (tex) => {
      hdri.loading = null;
      updateHud();
      applyHdriTexture(tex, name);
    },
    undefined,
    () => {
      hdri.loading = null;
      updateHud();
    }
  );
}

function ensureBundledSky() {
  if (hdri.name === 'kloofendal_sky.exr' || hdri.loading) return;
  loadHdriUrl('/kloofendal_sky.exr', 'kloofendal_sky.exr');
}

// ---------------------------------------------------------------------------
// Multi-model scene: each entry owns its scene graph, animations, pose state
// and whole-model transform. One model is "active" — the Pose and Transform
// folders (and animation playback) drive the active model.
const models = [];
let active = null;
let sceneRadius = 2;
let modelCounter = 0;

function newXform() {
  return { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1 };
}

function updateHud() {
  const el = document.getElementById('modelname');
  if (!active) {
    el.textContent = 'no model';
    return;
  }
  el.textContent =
    models.length > 1 ? `${active.name} (+${models.length - 1} more)` : active.name;
}

function recomputeScene() {
  if (!models.length) return;
  const box = new THREE.Box3();
  for (const m of models) {
    m.root.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(m.root));
  }
  sceneRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
  rig.setCenter(box.getCenter(new THREE.Vector3()));
  rig.ground.scale.setScalar(Math.max(sceneRadius, 1));
}

function applyModelXform(m = active) {
  if (!m) return;
  m.root.position.set(m.xform.posX, m.xform.posY, m.xform.posZ);
  m.root.rotation.order = 'YXZ'; // yaw, then pitch, then roll
  m.root.rotation.set(
    THREE.MathUtils.degToRad(m.xform.rotX),
    THREE.MathUtils.degToRad(m.xform.rotY),
    THREE.MathUtils.degToRad(m.xform.rotZ)
  );
  m.root.scale.setScalar(m.xform.scale / 16);
  recomputeScene();
}

function loadModelFromJSON(json, name) {
  const { root, materials, textures, groupsByUuid, animations } = parseBBModel(json);
  materials.forEach(applyRimToMaterial);
  addStrokesToModel(root, strokeMaterial);
  processStrokes(root, textures, json.resolution || { width: 16, height: 16 }, strokeMaterial);

  const anims = new Map();
  for (const anim of animations) {
    const compiled = compileAnimation(anim);
    if (compiled.bones.length) anims.set(compiled.name, compiled);
  }

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);

  const entry = {
    id: modelCounter++,
    name: name || json.name || 'model',
    json,
    root,
    groups: groupsByUuid,
    anims,
    poseState: { anim: 'None', time: 0, play: false, speed: 1 },
    xform: newXform(),
    radius,
  };

  // Place additional models beside the existing scene instead of inside it
  if (models.length) {
    const sceneBox = new THREE.Box3();
    for (const m of models) sceneBox.union(new THREE.Box3().setFromObject(m.root));
    entry.xform.posX = sceneBox.max.x - box.min.x + 0.3;
  }

  scene.add(root);
  models.push(entry);
  active = entry;
  applyModelXform(entry);

  if (models.length === 1) {
    // First model: frame camera, ground and lights around it
    rig.frameModel(box);
    controls.target.copy(box.getCenter(new THREE.Vector3()));
    const dist = radius * 2.4;
    const c = controls.target;
    camera.position.set(c.x + dist * 0.7, c.y + dist * 0.35, c.z + dist * 0.75);
    camera.near = Math.max(radius / 100, 0.01);
    camera.far = Math.max(radius * 60, 150);
    camera.updateProjectionMatrix();
  }

  deselectBone();
  rebuildModelsFolder();
  rebuildPoseFolder();
  rebuildXformFolder();
  applyParams();
  updateHud();
  return entry;
}

function removeModel(m = active) {
  if (!m) return;
  deselectBone();
  scene.remove(m.root);
  m.root.traverse((o) => {
    if (o.isMesh) o.geometry.dispose();
  });
  postfx.clearMaterialCache();
  models.splice(models.indexOf(m), 1);
  active = models[models.length - 1] || null;
  recomputeScene();
  rebuildModelsFolder();
  rebuildPoseFolder();
  rebuildXformFolder();
  updateHud();
}

function duplicateModel(m = active) {
  if (!m) return;
  loadModelFromJSON(m.json, m.name.replace(/( copy( \d+)?)?$/, ' copy'));
}

function setActiveModel(m) {
  if (!m || m === active) return;
  active = m;
  rebuildModelsFolder();
  rebuildPoseFolder();
  rebuildXformFolder();
  updateHud();
}

// ---------------------------------------------------------------------------
// Surface rim light (fresnel) + emissive accents shared across all materials
const rimUniforms = {
  uRimColor: { value: new THREE.Color('#dff2ff') },
  uRimIntensity: { value: 0.55 },
  uRimPower: { value: 2.5 },
  uRimTaper: { value: 2.0 },
  uRimDirVS: { value: new THREE.Vector3(0, 0, 1) },
  uEmissive: { value: 0.0 },
  uEmissiveThresh: { value: 0.55 },
};

function applyRimToMaterial(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rimUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform vec3 uRimColor;
         uniform float uRimIntensity;
         uniform float uRimPower;
         uniform float uRimTaper;
         uniform vec3 uRimDirVS;
         uniform float uEmissive;
         uniform float uEmissiveThresh;
         void main() {`
      )
      .replace(
        '#include <opaque_fragment>',
        `{
           vec3 rimViewDir = normalize(vViewPosition);
           float fresnel = pow(1.0 - saturate(dot(normalize(normal), rimViewDir)), uRimPower);
           // Taper: full strength facing the rim light, fading to nothing at
           // 90 degrees away — no more uniform halo around the whole model
           float mask = pow(saturate(dot(normalize(normal), uRimDirVS)), uRimTaper);
           outgoingLight += uRimColor * fresnel * mask * uRimIntensity;
           // Emissive accents: bright, saturated texels self-glow (sculk-style)
           float emMax = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
           float emMin = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
           float emSat = emMax > 0.001 ? (emMax - emMin) / emMax : 0.0;
           float emGlow = smoothstep(uEmissiveThresh, uEmissiveThresh + 0.2, emMax * mix(0.35, 1.0, emSat));
           outgoingLight += diffuseColor.rgb * emGlow * uEmissive;
         }
         #include <opaque_fragment>`
      );
  };
  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Parameters + GUI
const params = {
  ...PRESETS.Studio,
  preset: 'Studio',
  exportScale: 2,
  exportTransparent: false,
  showHandles: true,
  paintBlend: 'additive', // not in presets — survives preset switches
  // Depth of field — also preset-independent
  dofEnabled: false,
  dofAutoFocus: true,
  dofFocus: 5,
  dofAperture: 2.5,
  dofMaxBlur: 0.012,
};

function applyPreset(name) {
  Object.assign(params, PRESETS[name]);
  params.preset = name;
  if (params.hdriBackground) ensureBundledSky();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  applyParams();
}

const gui = new GUI({ title: 'Relight' });
gui
  .add(params, 'preset', Object.keys(PRESETS))
  .name('Preset')
  .onChange(applyPreset);

const fModels = gui.addFolder('Models');
function rebuildModelsFolder() {
  [...fModels.controllers].forEach((c) => c.destroy());
  fModels.add({ add: () => fileInput.click() }, 'add').name('➕ Add .bbmodel…');
  if (!models.length) return;
  const options = {};
  models.forEach((m, i) => (options[`${i + 1}: ${m.name}`] = m.id));
  const state = { active: active ? active.id : models[0].id };
  fModels
    .add(state, 'active', options)
    .name('Active model')
    .onChange((id) => setActiveModel(models.find((m) => m.id === id)));
  fModels.add({ dup: () => duplicateModel() }, 'dup').name('⧉ Duplicate');
  fModels.add({ rm: () => removeModel() }, 'rm').name('🗑 Remove');
}
rebuildModelsFolder();

const fCam = gui.addFolder('Camera');
fCam.add({ set: setRenderCameraFromView }, 'set').name('📷 Set render camera here');
fCam.add({ look: lookThroughCamera }, 'look').name('👁 Look through camera');
fCam.add({ clear: clearRenderCamera }, 'clear').name('✖ Clear render camera');
fCam.add(camState, 'aspect', Object.keys(ASPECTS)).name('Export aspect');

const fKey = gui.addFolder('Key light');
fKey.add(params, 'keyAz', -180, 180, 1).name('Azimuth').onChange(applyParams);
fKey.add(params, 'keyEl', -10, 89, 1).name('Elevation').onChange(applyParams);
fKey.addColor(params, 'keyColor').name('Color').onChange(applyParams);
fKey.add(params, 'keyIntensity', 0, 6, 0.05).name('Intensity').onChange(applyParams);

const fFill = gui.addFolder('Fill light');
fFill.add(params, 'fillAz', -180, 180, 1).name('Azimuth').onChange(applyParams);
fFill.add(params, 'fillEl', -10, 89, 1).name('Elevation').onChange(applyParams);
fFill.addColor(params, 'fillColor').name('Color').onChange(applyParams);
fFill.add(params, 'fillIntensity', 0, 3, 0.05).name('Intensity').onChange(applyParams);
fFill.close();

const fRim = gui.addFolder('Rim light + edges');
fRim
  .add(params, 'rimSpace', { 'Camera (follows view)': 'camera', 'World (fixed)': 'world' })
  .name('Rim space')
  .onChange(applyParams);
fRim.add(params, 'rimAz', -180, 180, 1).name('Azimuth').onChange(applyParams);
fRim.add(params, 'rimEl', -89, 89, 1).name('Elevation').onChange(applyParams);
fRim.add(params, 'showHandles').name('Show light handles').onChange(applyParams);
fRim.addColor(params, 'rimColor').name('Color').onChange(applyParams);
fRim.add(params, 'rimIntensity', 0, 6, 0.05).name('Light intensity').onChange(applyParams);
fRim.add(params, 'surfaceRim', 0, 2, 0.01).name('Surface rim').onChange(applyParams);
fRim.add(params, 'surfaceRimPower', 0.5, 8, 0.1).name('Rim tightness').onChange(applyParams);
fRim.add(params, 'rimTaper', 0.2, 8, 0.1).name('Rim taper').onChange(applyParams);

const fPaint = gui.addFolder('Painted edges');
fPaint
  .add(params, 'paintBlend', {
    'Glow (additive)': 'additive',
    'Paint (normal)': 'normal',
    'Ink (darken)': 'ink',
    Screen: 'screen',
    Lighten: 'lighten',
    Overlay: 'overlay',
  })
  .name('Blend mode')
  .onChange(applyParams);
fPaint.add(params, 'paintRim', 0, 8, 0.05).name('Rim-lit strokes').onChange(applyParams);
fPaint.add(params, 'paintKey', 0, 8, 0.05).name('Key-lit strokes').onChange(applyParams);
fPaint.add(params, 'paintWidth', 0.5, 10, 0.1).name('Width px').onChange(applyParams);
fPaint.add(params, 'paintTaper', 0, 4, 0.05).name('Taper (0 = off)').onChange(applyParams);
fPaint.add(params, 'paintInset', 0, 0.35, 0.005).name('End inset').onChange(applyParams);
fPaint.add(params, 'paintThreshold', 0, 0.9, 0.01).name('Threshold').onChange(applyParams);
fPaint.add(params, 'paintFalloff', 0.3, 5, 0.1).name('Falloff').onChange(applyParams);
fPaint
  .add(
    {
      restore: () => {
        const n = restoreAllStrokes(models.map((m) => m.root));
        boneLabel.textContent = n ? ` · restored ${n / 10} strokes` : '';
      },
    },
    'restore'
  )
  .name('↺ Restore erased strokes (Alt+click erases)');

const fGlow = gui.addFolder('Edge glow (screen)');
fGlow.add(params, 'rimEdgeIntensity', 0, 6, 0.05).name('Rim glow').onChange(applyParams);
fGlow.add(params, 'keyEdgeIntensity', 0, 6, 0.05).name('Key glow').onChange(applyParams);
fGlow.add(params, 'edgeWidth', 0.5, 3, 0.1).name('Width px').onChange(applyParams);
fGlow.add(params, 'edgeFalloff', 0.3, 5, 0.1).name('Falloff').onChange(applyParams);
fGlow.add(params, 'edgeFloor', 0, 0.9, 0.01).name('Threshold').onChange(applyParams);
fGlow.close();

const fPose = gui.addFolder('Pose / Animation');
let timeCtrl = null;

function rebuildPoseFolder() {
  [...fPose.controllers].forEach((c) => c.destroy());
  timeCtrl = null;
  if (!active) return;
  const ps = active.poseState;
  const names = ['None', ...active.anims.keys()];
  fPose.add(ps, 'anim', names).name('Animation').onChange(onPoseChange);
  timeCtrl = fPose.add(ps, 'time', 0, 1, 0.001).name('Time (s)').onChange(onPoseTime);
  fPose.add(ps, 'play').name('Play');
  fPose.add(ps, 'speed', 0.1, 2, 0.05).name('Speed');
  fPose.add({ save: () => savePoseFile() }, 'save').name('💾 Save pose…');
  fPose.add({ load: () => poseInput.click() }, 'load').name('📂 Load pose…');
  fPose
    .add(
      {
        reset: () => {
          ps.anim = 'None';
          onPoseChange();
        },
      },
      'reset'
    )
    .name('↺ Reset pose');
  onPoseChange();
}

function currentAnim() {
  return active ? active.anims.get(active.poseState.anim) || null : null;
}

function onPoseChange() {
  if (!active) return;
  const anim = currentAnim();
  if (!anim) {
    active.poseState.play = false;
    resetPose(active.groups);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    return;
  }
  timeCtrl.max(Math.max(anim.length, 0.001));
  active.poseState.time = Math.min(active.poseState.time, anim.length);
  applyPose(anim, active.poseState.time, active.groups);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

function onPoseTime() {
  const anim = currentAnim();
  if (anim) applyPose(anim, active.poseState.time, active.groups);
}

const fXform = gui.addFolder('Model transform');
function rebuildXformFolder() {
  [...fXform.controllers].forEach((c) => c.destroy());
  if (!active) return;
  const xf = active.xform;
  const onXf = () => applyModelXform(active);
  fXform.add(xf, 'posX', -8, 8, 0.01).name('Position X').onChange(onXf);
  fXform.add(xf, 'posY', -8, 8, 0.01).name('Position Y').onChange(onXf);
  fXform.add(xf, 'posZ', -8, 8, 0.01).name('Position Z').onChange(onXf);
  fXform.add(xf, 'rotX', -180, 180, 1).name('Pitch').onChange(onXf);
  fXform.add(xf, 'rotY', -180, 180, 1).name('Yaw').onChange(onXf);
  fXform.add(xf, 'rotZ', -180, 180, 1).name('Roll').onChange(onXf);
  fXform.add(xf, 'scale', 0.2, 3, 0.01).name('Scale').onChange(onXf);
  fXform
    .add(
      {
        reset: () => {
          Object.assign(xf, newXform());
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          applyModelXform(active);
        },
      },
      'reset'
    )
    .name('↺ Reset transform');
}
fXform.close();

const fEnv = gui.addFolder('Environment');
fEnv.add({ load: () => hdriInput.click() }, 'load').name('🌅 Load HDRI (.exr/.hdr)…');
fEnv.add(params, 'hdriBackground').name('HDRI as background').onChange(applyParams);
fEnv.add(params, 'hdriIntensity', 0, 3, 0.01).name('HDRI light').onChange(applyParams);
fEnv.add(params, 'hdriBlur', 0, 1, 0.01).name('HDRI blur').onChange(applyParams);
fEnv.add(params, 'ambientIntensity', 0, 2, 0.01).name('Ambient').onChange(applyParams);
fEnv.addColor(params, 'skyColor').name('Sky tint').onChange(applyParams);
fEnv.addColor(params, 'groundColor').name('Bounce tint').onChange(applyParams);
fEnv.addColor(params, 'background').name('Background').onChange(applyParams);
fEnv.add(params, 'fogDensity', 0, 0.2, 0.001).name('Fog').onChange(applyParams);
fEnv.add(params, 'shadowOpacity', 0, 1, 0.01).name('Shadow opacity').onChange(applyParams);
fEnv.close();

const fFX = gui.addFolder('Effects');
fFX.add(params, 'dofEnabled').name('Depth of field').onChange(applyParams);
fFX.add(params, 'dofAutoFocus').name('DoF: auto-focus model').onChange(applyParams);
fFX.add(params, 'dofFocus', 0.5, 40, 0.1).name('DoF: focus dist').onChange(applyParams);
fFX.add(params, 'dofAperture', 0.2, 10, 0.1).name('DoF: aperture').onChange(applyParams);
fFX.add(params, 'dofMaxBlur', 0.001, 0.03, 0.001).name('DoF: max blur').onChange(applyParams);
fFX.add(params, 'exposure', 0.2, 2.5, 0.01).name('Exposure').onChange(applyParams);
fFX.add(params, 'emissive', 0, 4, 0.05).name('Emissive accents').onChange(applyParams);
fFX.add(params, 'emissiveThresh', 0.2, 0.95, 0.01).name('Emissive threshold').onChange(applyParams);
fFX.add(params, 'bloomStrength', 0, 2, 0.01).name('Bloom').onChange(applyParams);
fFX.add(params, 'bloomThreshold', 0, 1.5, 0.01).name('Bloom threshold').onChange(applyParams);
fFX.add(params, 'bloomRadius', 0, 1.5, 0.01).name('Bloom radius').onChange(applyParams);
fFX.add(params, 'vignette', 0, 1, 0.01).name('Vignette').onChange(applyParams);
fFX.close();

const fWorld = gui.addFolder('World (Minecraft map)');
fWorld.add(worldOpts, 'path').name('World folder');
fWorld.add(worldOpts, 'x').name('Center X');
fWorld.add(worldOpts, 'z').name('Center Z');
fWorld.add(worldOpts, 'radius', 8, 96, 4).name('Radius (blocks)');
fWorld
  .add(
    {
      load: async () => {
        try {
          const r = await loadWorld();
          document.getElementById('bonename').textContent = ` · world: ${r.filled} blocks`;
        } catch (e) {
          document.getElementById('bonename').textContent = ` · ⚠ ${String(e.message).slice(0, 90)}`;
        }
      },
    },
    'load'
  )
  .name('⛏ Load world slab');
fWorld.add({ clear: clearWorld }, 'clear').name('✖ Clear world');
fWorld.close();

const fVideo = gui.addFolder('Video');
fVideo.add(shot, 'duration', 1, 30, 0.5).name('Duration (s)');
fVideo.add(shot, 'fps', { '24': 24, '30': 30, '60': 60 }).name('FPS');
fVideo
  .add(shot, 'background', {
    'Scene (as seen)': 'scene',
    'Greenscreen': 'green',
    'Transparent (ProRes 4444)': 'transparent',
  })
  .name('Background');
fVideo.add({ key: addShotKey }, 'key').name('◉ Add camera key (current view)');
fVideo.add({ clear: clearShotKeys }, 'clear').name('✖ Clear camera keys');
fVideo
  .add(
    {
      render: async () => {
        try {
          const file = await renderVideo('clip');
          document.getElementById('bonename').textContent = ` · saved ${file.split(/[\\/]/).pop()}`;
        } catch (e) {
          document.getElementById('bonename').textContent = ` · ⚠ ${String(e.message).slice(0, 80)}`;
        }
      },
    },
    'render'
  )
  .name('🎬 Render video (exports/)');
fVideo.close();

const fExport = gui.addFolder('Export');
fExport.add(params, 'exportScale', { '1x': 1, '2x': 2, '4x': 4 }).name('Resolution');
fExport.add(params, 'exportTransparent').name('Transparent BG');
fExport.add({ save: exportPNG }, 'save').name('💾 Save PNG');

function applyParams() {
  rig.key.color.set(params.keyColor);
  rig.key.intensity = params.keyIntensity;
  rig.fill.color.set(params.fillColor);
  rig.fill.intensity = params.fillIntensity;
  rig.rim.color.set(params.rimColor);
  rig.rim.intensity = params.rimIntensity;
  rig.hemi.intensity = params.ambientIntensity;
  rig.hemi.color.set(params.skyColor);
  rig.hemi.groundColor.set(params.groundColor);
  rig.ground.material.opacity = params.shadowOpacity;
  rig.update(params, sceneRadius, camera);

  if (params.exportTransparent) {
    scene.background = null;
  } else if (hdri.equirect && params.hdriBackground) {
    scene.background = hdri.equirect;
    scene.backgroundIntensity = params.hdriIntensity;
    scene.backgroundBlurriness = params.hdriBlur;
  } else {
    scene.background = new THREE.Color(params.background);
  }
  scene.environment = hdri.pmremRT && params.hdriIntensity > 0 ? hdri.pmremRT.texture : null;
  scene.environmentIntensity = params.hdriIntensity;
  scene.fog = params.fogDensity > 0 ? new THREE.FogExp2(new THREE.Color(params.background), params.fogDensity) : null;

  renderer.toneMappingExposure = params.exposure;

  const u = postfx.edgePass.uniforms;
  u.rimEdgeColor.value.set(params.rimColor);
  u.keyEdgeColor.value.set(params.keyColor);
  u.rimEdgeIntensity.value = params.rimEdgeIntensity;
  u.keyEdgeIntensity.value = params.keyEdgeIntensity;
  u.edgeWidth.value = params.edgeWidth;
  u.edgeFalloff.value = params.edgeFalloff;
  u.edgeFloor.value = params.edgeFloor;
  u.vignette.value = params.vignette;

  postfx.bloomPass.strength = params.bloomStrength;
  postfx.bloomPass.threshold = params.bloomThreshold;
  postfx.bloomPass.radius = params.bloomRadius;
  postfx.bloomPass.enabled = params.bloomStrength > 0;

  postfx.bokehPass.enabled = params.dofEnabled;
  const bk = postfx.bokehPass.uniforms;
  bk.focus.value = params.dofFocus;
  bk.aperture.value = params.dofAperture * 0.001;
  bk.maxblur.value = params.dofMaxBlur;

  rimUniforms.uRimColor.value.set(params.rimColor);
  rimUniforms.uRimIntensity.value = params.surfaceRim;
  rimUniforms.uRimPower.value = params.surfaceRimPower;
  rimUniforms.uRimTaper.value = params.rimTaper;
  rimUniforms.uEmissive.value = params.emissive;
  rimUniforms.uEmissiveThresh.value = params.emissiveThresh;

  const s = strokeMaterial.uniforms;
  const blendModes = { additive: 0, normal: 1, ink: 2, screen: 3, lighten: 4, overlay: 5 };
  s.uBlendMode.value = blendModes[params.paintBlend] ?? 0;
  const sm = strokeMaterial;
  sm.blendEquation = THREE.AddEquation;
  sm.blendSrc = THREE.OneFactor;
  sm.blendDst = THREE.OneFactor;
  switch (params.paintBlend) {
    case 'normal':
      sm.blending = THREE.NormalBlending;
      break;
    case 'ink':
      sm.blending = THREE.SubtractiveBlending;
      break;
    case 'screen': // 1 - (1-src)(1-dst) = src·(1-dst) + dst
      sm.blending = THREE.CustomBlending;
      sm.blendSrc = THREE.OneMinusDstColorFactor;
      break;
    case 'lighten': // max(src, dst)
      sm.blending = THREE.CustomBlending;
      sm.blendEquation = THREE.MaxEquation;
      break;
    case 'overlay': // 2·src·dst — brightens midtones, leaves shadows alone
      sm.blending = THREE.CustomBlending;
      sm.blendSrc = THREE.DstColorFactor;
      sm.blendDst = THREE.SrcColorFactor;
      break;
    default:
      sm.blending = THREE.AdditiveBlending;
  }
  s.uWidthPx.value = params.paintWidth;
  s.uTaper.value = params.paintTaper;
  s.uInset.value = params.paintInset;
  s.uThreshold.value = params.paintThreshold;
  s.uFalloff.value = params.paintFalloff;
  s.uRimColor.value.set(params.rimColor);
  s.uKeyColor.value.set(params.keyColor);
  s.uRimI.value = params.paintRim;
  s.uKeyI.value = params.paintKey;
  s.uFogDensity.value = params.fogDensity;
}

// ---------------------------------------------------------------------------
// File loading
const fileInput = document.getElementById('file');
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadModelFromJSON(JSON.parse(await file.text()), file.name);
  fileInput.value = '';
});

const hdriInput = document.getElementById('hdrifile');
hdriInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    params.hdriBackground = true;
    if (params.hdriIntensity === 0) params.hdriIntensity = 1;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    loadHdriUrl(URL.createObjectURL(file), file.name);
  }
  hdriInput.value = '';
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.name.match(/\.(bbmodel|json)$/i)) {
    loadModelFromJSON(JSON.parse(await file.text()), file.name);
  } else if (file.name.match(/\.(exr|hdr)$/i)) {
    params.hdriBackground = true;
    if (params.hdriIntensity === 0) params.hdriIntensity = 1;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    loadHdriUrl(URL.createObjectURL(file), file.name);
  }
});

// Load bundled sample on start
fetch('/moose.bbmodel')
  .then((r) => (r.ok ? r.json() : null))
  .then((json) => {
    if (json && !models.length) loadModelFromJSON(json, 'moose.bbmodel');
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Export
// Render one frame at export size from the render camera (or viewport camera
// if none is set), with all helpers hidden; `capture` grabs the canvas
// synchronously, then everything is restored.
function withExportFrame(scale, capture) {
  const { w, h } = exportDims(scale);
  const oldRatio = renderer.getPixelRatio();
  const cam = renderCam || camera;
  const oldAspect = cam.aspect;

  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  postfx.setSize(w, h);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  const oldHandles = params.showHandles;
  params.showHandles = false;
  const gizmoWasVisible = boneControls.visible;
  boneControls.visible = false;
  const selBoxWasVisible = selBox.visible;
  selBox.visible = false;
  const helperWasVisible = camHelper ? camHelper.visible : false;
  if (camHelper) camHelper.visible = false;
  if (params.exportTransparent) {
    scene.background = null;
    rig.ground.visible = false;
  }

  renderFrame(cam);
  const result = capture();

  params.showHandles = oldHandles;
  boneControls.visible = gizmoWasVisible;
  selBox.visible = selBoxWasVisible;
  if (camHelper) camHelper.visible = helperWasVisible;
  cam.aspect = oldAspect;
  cam.updateProjectionMatrix();
  renderer.setPixelRatio(oldRatio);
  resize();
  if (params.exportTransparent) rig.ground.visible = true;
  applyParams();
  return result;
}

function exportPNG() {
  withExportFrame(Number(params.exportScale), () =>
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const modelName = (active ? active.name : 'relight').replace(/\.\w+$/, '');
      a.download = `${modelName}-${params.preset.toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    })
  );
}

// ---------------------------------------------------------------------------
// Manual bone posing: click a cube to select its bone, drag the gizmo to
// rotate/move it (R / G to switch modes, Esc to deselect, Shift snaps).
const boneControls = new TransformControls(camera, canvas);
boneControls.setSpace('local');
boneControls.setMode('rotate');
boneControls.setSize(0.7);
scene.add(boneControls);
boneControls.traverse((o) => (o.userData.noEdges = true));

let selectedBone = null;
const selBox = new THREE.BoxHelper(undefined, 0x4da3ff);
selBox.material.depthTest = false;
selBox.userData.noEdges = true;
selBox.visible = false;
scene.add(selBox);
const boneLabel = document.getElementById('bonename');

boneControls.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value && active) {
    active.poseState.play = false;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
});
boneControls.addEventListener('objectChange', () => {
  if (selectedBone) selBox.setFromObject(selectedBone);
});

function selectBone(bone) {
  selectedBone = bone;
  boneControls.attach(bone);
  selBox.setFromObject(bone);
  selBox.visible = true;
  boneLabel.textContent = ` · bone: ${bone.name} (R rotate / G move / Esc)`;
}

function deselectBone() {
  selectedBone = null;
  boneControls.detach();
  selBox.visible = false;
  boneLabel.textContent = '';
}

// Returns {bone, model} for a clicked object, walking up the parent chain
function findBoneForObject(obj) {
  let bone = null;
  let n = obj;
  while (n) {
    if (!bone && n.isGroup && n.userData.uuid) {
      const owner = models.find((m) => m.groups.get(n.userData.uuid) === n);
      if (owner) return { bone: n, model: owner };
    }
    n = n.parent;
  }
  return null;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') deselectBone();
  if (e.key === 'r' || e.key === 'R') boneControls.setMode('rotate');
  if (e.key === 'g' || e.key === 'G') boneControls.setMode('translate');
  if (e.key === 'Shift') {
    boneControls.setRotationSnap(THREE.MathUtils.degToRad(15));
    boneControls.setTranslationSnap(0.0625);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') {
    boneControls.setRotationSnap(null);
    boneControls.setTranslationSnap(null);
  }
});

// Pose save / load / reset (active model)
function currentPoseData() {
  if (!active) return { format: 'relight-pose', bones: {} };
  const bones = {};
  for (const [uuid, g] of active.groups) {
    const r = [
      THREE.MathUtils.radToDeg(g.rotation.x - g.userData.bindRot.x),
      THREE.MathUtils.radToDeg(g.rotation.y - g.userData.bindRot.y),
      THREE.MathUtils.radToDeg(g.rotation.z - g.userData.bindRot.z),
    ];
    const p = [
      g.position.x - g.userData.bindPos.x,
      g.position.y - g.userData.bindPos.y,
      g.position.z - g.userData.bindPos.z,
    ];
    const s = [g.scale.x, g.scale.y, g.scale.z];
    const changed =
      r.some((v) => Math.abs(v) > 0.01) ||
      p.some((v) => Math.abs(v) > 0.001) ||
      s.some((v) => Math.abs(v - 1) > 0.001);
    if (changed) bones[uuid] = { name: g.name, rot: r, pos: p, scale: s };
  }
  return { format: 'relight-pose', bones };
}

function applyPoseData(data) {
  if (!active) return;
  resetPose(active.groups);
  const byName = new Map();
  for (const g of active.groups.values()) byName.set(g.name, g);
  for (const [uuid, b] of Object.entries(data.bones || {})) {
    // Match by uuid, falling back to bone name so poses transfer between
    // model variants
    const g = active.groups.get(uuid) || byName.get(b.name);
    if (!g) continue;
    if (b.rot) {
      g.rotation.x = g.userData.bindRot.x + THREE.MathUtils.degToRad(b.rot[0]);
      g.rotation.y = g.userData.bindRot.y + THREE.MathUtils.degToRad(b.rot[1]);
      g.rotation.z = g.userData.bindRot.z + THREE.MathUtils.degToRad(b.rot[2]);
    }
    if (b.pos) {
      g.position.x = g.userData.bindPos.x + b.pos[0];
      g.position.y = g.userData.bindPos.y + b.pos[1];
      g.position.z = g.userData.bindPos.z + b.pos[2];
    }
    if (b.scale) g.scale.set(b.scale[0], b.scale[1], b.scale[2]);
  }
  if (selectedBone) selBox.setFromObject(selectedBone);
}

function savePoseFile() {
  const blob = new Blob([JSON.stringify(currentPoseData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const modelName = (active ? active.name : 'model').replace(/\.\w+$/, '');
  a.download = `${modelName}-pose.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const poseInput = document.getElementById('posefile');
poseInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format === 'relight-pose') applyPoseData(data);
  } catch {}
  poseInput.value = '';
});

// ---------------------------------------------------------------------------
// Pointer interaction: drag light handles, click to select bones
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let draggingHandle = null;
const pointerDownAt = { x: 0, y: 0, t: 0 };

function setNDC(e) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}

// Intersect the pointer ray with the sphere the handles live on; fall back to
// the closest point on that sphere when the ray misses it.
function dragDirection(target) {
  const r = rig.handleDist(sceneRadius);
  const ray = raycaster.ray;
  const oc = new THREE.Vector3().subVectors(ray.origin, rig.center);
  const b = oc.dot(ray.direction);
  const c = oc.lengthSq() - r * r;
  const disc = b * b - c;
  if (disc >= 0) {
    const t = -b - Math.sqrt(disc);
    if (t > 0) {
      return target.copy(ray.origin).addScaledVector(ray.direction, t).sub(rig.center).normalize();
    }
  }
  const closest = ray.closestPointToPoint(rig.center, new THREE.Vector3());
  return target.copy(closest).sub(rig.center).normalize();
}

canvas.addEventListener('pointerdown', (e) => {
  pointerDownAt.x = e.clientX;
  pointerDownAt.y = e.clientY;
  pointerDownAt.t = performance.now();
  if (boneControls.dragging || boneControls.axis) return; // gizmo owns this drag
  if (!params.showHandles) return;
  setNDC(e);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects([rig.handles.key, rig.handles.rim], false);
  if (hits.length) {
    draggingHandle = hits[0].object.userData.handle;
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!draggingHandle) return;
  setNDC(e);
  raycaster.setFromCamera(ndc, camera);
  const dir = dragDirection(new THREE.Vector3());
  const rad2deg = THREE.MathUtils.radToDeg;
  const y = THREE.MathUtils.clamp(dir.y, -1, 1);
  if (draggingHandle === 'rim' && params.rimSpace === 'camera') {
    const local = dir.applyQuaternion(camera.quaternion.clone().invert());
    params.rimAz = rad2deg(Math.atan2(local.x, -local.z));
    params.rimEl = rad2deg(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)));
  } else if (draggingHandle === 'rim') {
    params.rimAz = rad2deg(Math.atan2(dir.x, dir.z));
    params.rimEl = rad2deg(Math.asin(y));
  } else {
    params.keyAz = rad2deg(Math.atan2(dir.x, dir.z));
    params.keyEl = THREE.MathUtils.clamp(rad2deg(Math.asin(y)), -10, 89);
  }
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  applyParams();
});

canvas.addEventListener('pointerup', (e) => {
  if (draggingHandle) {
    draggingHandle = null;
    controls.enabled = true;
    return;
  }
  // A short, still pointerup is a click: select the bone under the cursor
  const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
  const elapsed = performance.now() - pointerDownAt.t;
  if (moved > 5 || elapsed > 400) return;
  if (boneControls.dragging || boneControls.axis) return;
  if (!models.length) return;

  // Alt+click: erase the painted stroke under the cursor
  if (e.altKey) {
    const rect = canvas.getBoundingClientRect();
    const hit = pickStroke(
      camera,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      models.map((m) => m.root),
      Math.max(8, params.paintWidth + 5)
    );
    if (hit) setStrokeHidden(hit.mesh, hit.stroke, true);
    return;
  }

  setNDC(e);
  raycaster.setFromCamera(ndc, camera);
  const roots = models.map((m) => m.root);
  const hits = raycaster.intersectObjects(roots, true).filter((h) => !h.object.userData.noEdges);
  if (!hits.length) {
    deselectBone();
    return;
  }
  const found = findBoneForObject(hits[0].object);
  if (found) {
    setActiveModel(found.model);
    selectBone(found.bone);
  } else {
    deselectBone();
  }
});

// ---------------------------------------------------------------------------
// Render loop
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  postfx.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function renderFrame(cam = camera) {
  cam.updateMatrixWorld();
  rig.update(params, sceneRadius, cam); // camera-relative rim tracks the render view
  rimUniforms.uRimDirVS.value
    .copy(rig.rimDirWorld)
    .transformDirection(cam.matrixWorldInverse);
  const oldCam = postfx.camera;
  postfx.camera = cam;
  postfx.renderPass.camera = cam;
  postfx.bokehPass.camera = cam;
  if (params.dofEnabled && params.dofAutoFocus && active) {
    const center = new THREE.Box3().setFromObject(active.root).getCenter(new THREE.Vector3());
    postfx.bokehPass.uniforms.focus.value = cam.position.distanceTo(center);
  }
  postfx.updateLightDirs(rig.rimDirWorld, rig.keyDirWorld);
  strokeMaterial.uniforms.uRimDir.value.copy(rig.rimDirWorld);
  strokeMaterial.uniforms.uKeyDir.value.copy(rig.keyDirWorld);
  renderer.getDrawingBufferSize(strokeMaterial.uniforms.uResolution.value);
  postfx.render();
  postfx.camera = oldCam;
  postfx.renderPass.camera = oldCam;
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (active) {
    const anim = currentAnim();
    if (active.poseState.play && anim && anim.length > 0) {
      active.poseState.time = (active.poseState.time + dt * active.poseState.speed) % anim.length;
      applyPose(anim, active.poseState.time, active.groups);
      if (timeCtrl) timeCtrl.updateDisplay();
    }
  }
  controls.update();
  renderFrame();
}

resize();
applyParams();
animate();

// ---------------------------------------------------------------------------
// Command API: poll /__cmd (vite dev middleware) for commands POSTed by
// external tools and scripts driving the app over HTTP — run them against
// __relight and post results back.
const clientToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
let claimed = false;

async function pollCommands() {
  try {
    if (!claimed) {
      await fetch('/__claim', { method: 'POST', body: JSON.stringify({ token: clientToken }) });
      claimed = true;
    }
    const res = await fetch(`/__cmd?token=${clientToken}`);
    const cmds = await res.json();
    for (const cmd of cmds) {
      let out = { id: cmd.id, ok: false };
      try {
        const fn = window.__relight[cmd.fn];
        if (typeof fn !== 'function') throw new Error('unknown fn: ' + cmd.fn);
        const data = await fn.apply(window.__relight, cmd.args || []);
        out = { id: cmd.id, ok: true, data: data === undefined ? null : data };
      } catch (e) {
        out.error = String(e);
      }
      await fetch('/__result', { method: 'POST', body: JSON.stringify(out) });
    }
  } catch {}
  setTimeout(pollCommands, 400);
}
pollCommands();

// ---------------------------------------------------------------------------
// Dev helpers: capture frames via the vite /__shot endpoint, drive the app
window.__relight = {
  params,
  applyParams,
  camera,
  controls,
  gui,
  scene,
  renderer,
  strokeMaterial,
  setPreset: applyPreset,
  setParams(partial) {
    Object.assign(params, partial);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    applyParams();
  },
  async loadModel(url, name) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const json = await res.json();
    loadModelFromJSON(json, name || url.split('/').pop());
    return models.length;
  },
  listModels: () => models.map((m) => m.name),
  setActiveModel: (i) => setActiveModel(models[i]),
  removeModel: () => removeModel(),
  duplicateModel: () => duplicateModel(),
  activeModel: () => active,
  setAnim(name, time = 0) {
    if (!active) return;
    active.poseState.anim = name;
    onPoseChange();
    active.poseState.time = time;
    onPoseTime();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  },
  listAnims: () => (active ? [...active.anims.keys()] : []),
  listBones: () => (active ? [...active.groups.values()].map((g) => g.name) : []),
  selectBone(name) {
    if (!active) return false;
    const g = [...active.groups.values()].find((b) => b.name === name);
    if (g) selectBone(g);
    return !!g;
  },
  deselectBone,
  poseBone(name, rotDeg = [0, 0, 0], pos = [0, 0, 0]) {
    if (!active) return false;
    const g = [...active.groups.values()].find((b) => b.name === name);
    if (!g) return false;
    g.rotation.x = g.userData.bindRot.x + THREE.MathUtils.degToRad(rotDeg[0]);
    g.rotation.y = g.userData.bindRot.y + THREE.MathUtils.degToRad(rotDeg[1]);
    g.rotation.z = g.userData.bindRot.z + THREE.MathUtils.degToRad(rotDeg[2]);
    g.position.x = g.userData.bindPos.x + pos[0];
    g.position.y = g.userData.bindPos.y + pos[1];
    g.position.z = g.userData.bindPos.z + pos[2];
    if (selectedBone) selBox.setFromObject(selectedBone);
    return true;
  },
  setXform(partial) {
    if (!active) return;
    Object.assign(active.xform, partial);
    applyModelXform(active);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  },
  currentPoseData,
  applyPoseData,
  eraseStrokeAt(x, y) {
    const hit = pickStroke(
      camera, x, y, canvas.clientWidth, canvas.clientHeight,
      models.map((m) => m.root), Math.max(10, params.paintWidth + 5)
    );
    if (hit) setStrokeHidden(hit.mesh, hit.stroke, true);
    return !!hit;
  },
  restoreStrokes: () => restoreAllStrokes(models.map((m) => m.root)),
  setCamera({ position, target, fov } = {}) {
    if (position) camera.position.set(position[0], position[1], position[2]);
    if (target) controls.target.set(target[0], target[1], target[2]);
    if (fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // Aim immediately — headless callers can't wait for the next rAF tick
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
  },
  setRenderCamera: setRenderCameraFromView,
  lookThroughCamera,
  clearRenderCamera,
  // Video: configure the shot, then renderVideo. cameraKeys: [{position:[3],
  // target:[3], fov?}] evenly spaced across the duration. models: per-model
  // animation assignments [{index, anim, time?, speed?}].
  setShot({ duration, fps, cameraKeys, background, models: modelAnims } = {}) {
    if (duration) shot.duration = duration;
    if (fps) shot.fps = fps;
    if (background) shot.background = background; // 'scene' | 'green' | 'transparent'
    if (cameraKeys) {
      shot.cameraKeys = cameraKeys.map((k) => ({
        position: k.position,
        target: k.target,
        fov: k.fov || camera.fov,
      }));
    }
    for (const ma of modelAnims || []) {
      const m = models[ma.index];
      if (!m) continue;
      m.poseState.anim = ma.anim || 'None';
      m.poseState.time = ma.time || 0;
      m.poseState.speed = ma.speed || 1;
      const anim = m.anims.get(m.poseState.anim);
      if (anim) applyPose(anim, m.poseState.time, m.groups);
      else resetPose(m.groups);
    }
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    updateShotLabel();
    return { duration: shot.duration, fps: shot.fps, keys: shot.cameraKeys.length };
  },
  getShot: () => ({ duration: shot.duration, fps: shot.fps, cameraKeys: shot.cameraKeys }),
  addShotKey,
  clearShotKeys,
  renderVideo,
  loadWorld,
  clearWorld,
  setExportAspect: (a) => {
    if (a in ASPECTS) camState.aspect = a;
  },
  renderNow: () => renderFrame(),
  // One call that returns everything an external driver needs
  getState: () => ({
    preset: params.preset,
    exportAspect: camState.aspect,
    renderCameraSet: !!renderCam,
    camera: {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
    },
    models: models.map((m, i) => ({
      index: i,
      name: m.name,
      active: m === active,
      xform: { ...m.xform },
      pose: { ...m.poseState },
      anims: [...m.anims.keys()],
      bones: [...m.groups.values()].map((g) => g.name),
    })),
  }),
  async shot(name = 'shot') {
    renderFrame();
    const dataUrl = canvas.toDataURL('image/png');
    const res = await fetch('/__shot', {
      method: 'POST',
      headers: { 'x-shot-name': name },
      body: dataUrl,
    });
    return res.text();
  },
  // Full-quality export (render camera + aspect, helpers hidden) saved to
  // shots/<name>.png — the API way to pull finished renders
  async render(name = 'render', scale = null) {
    const dataUrl = withExportFrame(Number(scale || params.exportScale), () =>
      canvas.toDataURL('image/png')
    );
    const res = await fetch('/__shot', {
      method: 'POST',
      headers: { 'x-shot-name': name },
      body: dataUrl,
    });
    return res.text();
  },
};

// Optional local extensions: if a local.extensions.js exists next to
// package.json (untracked), load it and let it hook in. Absent on fresh
// clones — the app runs identically without it.
const localExt = '/local.extensions.js';
import(/* @vite-ignore */ localExt)
  .then((m) => m.init?.())
  .catch(() => {});
