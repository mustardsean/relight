import * as THREE from 'three';

// Three-point light rig: key (shadows), fill, rim. Directions are set by
// azimuth/elevation in degrees so they're easy to drive from sliders.

export function dirFromAngles(azimuthDeg, elevationDeg, target = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  // Direction pointing FROM the light TOWARD the origin is -this; we store the
  // light position direction (from origin toward the light).
  target.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  return target;
}

export class LightRig {
  constructor(scene) {
    this.scene = scene;

    this.hemi = new THREE.HemisphereLight(0x8899bb, 0x223311, 0.5);
    scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key);
    scene.add(this.key.target);

    this.fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    scene.add(this.fill);
    scene.add(this.fill.target);

    this.rim = new THREE.DirectionalLight(0xbfe8ff, 1.6);
    scene.add(this.rim);
    scene.add(this.rim.target);

    this.keyDirWorld = new THREE.Vector3();
    this.rimDirWorld = new THREE.Vector3();
    this.center = new THREE.Vector3();

    // Shadow-catcher ground
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.userData.noEdges = true;
    scene.add(this.ground);

    // Draggable handles marking the key and rim light directions
    this.handles = {};
    for (const name of ['key', 'rim']) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
      );
      sphere.userData.noEdges = true;
      sphere.userData.handle = name;
      scene.add(sphere);
      this.handles[name] = sphere;
    }
  }

  // Rim angles are interpreted in camera space when params.rimSpace === 'camera'
  // (azimuth 0 = directly behind the model as seen from the camera).
  update(params, modelRadius = 2, camera = null) {
    const dist = Math.max(modelRadius * 3, 4);
    const v = new THREE.Vector3();
    const c = this.center;

    dirFromAngles(params.keyAz, params.keyEl, v);
    this.keyDirWorld.copy(v);
    this.key.position.copy(c).addScaledVector(v, dist);

    dirFromAngles(params.fillAz, params.fillEl, v);
    this.fill.position.copy(c).addScaledVector(v, dist);

    if (params.rimSpace === 'camera' && camera) {
      const az = THREE.MathUtils.degToRad(params.rimAz);
      const el = THREE.MathUtils.degToRad(params.rimEl);
      v.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      v.applyQuaternion(camera.quaternion);
    } else {
      dirFromAngles(params.rimAz, params.rimEl, v);
    }
    this.rimDirWorld.copy(v);
    this.rim.position.copy(c).addScaledVector(v, dist);

    // Handle positions + sizes track the model scale
    const handleDist = this.handleDist(modelRadius);
    const handleSize = modelRadius * 0.05;
    this.handles.key.position.copy(c).addScaledVector(this.keyDirWorld, handleDist);
    this.handles.rim.position.copy(c).addScaledVector(this.rimDirWorld, handleDist);
    this.handles.key.scale.setScalar(handleSize);
    this.handles.rim.scale.setScalar(handleSize);
    this.handles.key.material.color.set(params.keyColor).multiplyScalar(2);
    this.handles.rim.material.color.set(params.rimColor).multiplyScalar(2);
    this.handles.key.visible = params.showHandles;
    this.handles.rim.visible = params.showHandles;

    const s = Math.max(modelRadius * 1.6, 2);
    const cam = this.key.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    cam.near = 0.1;
    cam.far = dist * 3;
    cam.updateProjectionMatrix();
  }

  handleDist(modelRadius) {
    return Math.max(modelRadius * 1.35, 1.5);
  }

  // Re-aim lights at a new center without touching the ground plane — used
  // when the whole model is repositioned so it can lift off or tilt while the
  // ground (and its shadow) stays put.
  setCenter(center) {
    this.center.copy(center);
    this.key.target.position.copy(center);
    this.fill.target.position.copy(center);
    this.rim.target.position.copy(center);
  }

  frameModel(box) {
    this.setCenter(box.getCenter(new THREE.Vector3()));
    this.ground.position.y = box.min.y + 0.001;
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    this.ground.scale.setScalar(Math.max(radius, 1));
  }
}

// Look presets. Every value here maps 1:1 onto a GUI control.
export const PRESETS = {
  Studio: {
    keyAz: 35, keyEl: 45, keyColor: '#fff4e0', keyIntensity: 2.4,
    fillAz: -70, fillEl: 20, fillColor: '#8faacc', fillIntensity: 0.5,
    rimSpace: 'camera', rimAz: 25, rimEl: 40, rimColor: '#dff2ff', rimIntensity: 1.8,
    ambientIntensity: 0.45, skyColor: '#8899bb', groundColor: '#403830',
    background: '#1a1d24', fogDensity: 0.0,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.2, edgeFloor: 0.3,
    surfaceRim: 0.55, surfaceRimPower: 2.5, rimTaper: 2.0,
    paintRim: 1.8, paintKey: 0.8, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.35, paintFalloff: 2.4,
    emissive: 0.0, emissiveThresh: 0.55,
    bloomStrength: 0, bloomThreshold: 0.85, bloomRadius: 0.4,
    exposure: 1.0, vignette: 0.25, shadowOpacity: 0.35,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Daylight: {
    keyAz: -35, keyEl: 50, keyColor: '#fff2d8', keyIntensity: 3.0,
    fillAz: 80, fillEl: 15, fillColor: '#bcd4ff', fillIntensity: 0.5,
    rimSpace: 'camera', rimAz: 20, rimEl: 45, rimColor: '#ffffff', rimIntensity: 1.3,
    ambientIntensity: 0.3, skyColor: '#bfd9ff', groundColor: '#8a7a5c',
    background: '#87b5e0', fogDensity: 0.0,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.0, edgeFloor: 0.3,
    surfaceRim: 0.3, surfaceRimPower: 2.5, rimTaper: 2.0,
    paintRim: 1.4, paintKey: 1.5, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.35, paintFalloff: 2.4,
    emissive: 0.0, emissiveThresh: 0.6,
    bloomStrength: 0, bloomThreshold: 0.85, bloomRadius: 0.4,
    exposure: 1.05, vignette: 0.12, shadowOpacity: 0.45,
    hdriBackground: true, hdriIntensity: 1.0, hdriBlur: 0,
  },
  Sunset: {
    keyAz: -70, keyEl: 12, keyColor: '#ffb36b', keyIntensity: 2.8,
    fillAz: 100, fillEl: 25, fillColor: '#7f86c9', fillIntensity: 0.55,
    rimSpace: 'camera', rimAz: -15, rimEl: 30, rimColor: '#ffd9a0', rimIntensity: 1.8,
    ambientIntensity: 0.4, skyColor: '#ffb08a', groundColor: '#4a3a55',
    background: '#2e2440', fogDensity: 0.02,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.0, edgeFloor: 0.3,
    surfaceRim: 0.5, surfaceRimPower: 2.4, rimTaper: 2.0,
    paintRim: 1.8, paintKey: 1.4, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.33, paintFalloff: 2.3,
    emissive: 0.4, emissiveThresh: 0.6,
    bloomStrength: 0, bloomThreshold: 0.8, bloomRadius: 0.45,
    exposure: 1.05, vignette: 0.28, shadowOpacity: 0.5,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Underwater: {
    keyAz: -20, keyEl: 65, keyColor: '#9fd8c8', keyIntensity: 2.0,
    fillAz: 120, fillEl: 10, fillColor: '#2e6e66', fillIntensity: 0.7,
    rimSpace: 'camera', rimAz: -15, rimEl: 50, rimColor: '#c8fff2', rimIntensity: 2.2,
    ambientIntensity: 0.55, skyColor: '#3d8a80', groundColor: '#0c2622',
    background: '#265c58', fogDensity: 0.055,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.0, edgeFloor: 0.25,
    surfaceRim: 0.75, surfaceRimPower: 2.2, rimTaper: 1.8,
    paintRim: 2.2, paintKey: 0.5, paintWidth: 2.5, paintTaper: 1.6,
    paintInset: 0.05, paintThreshold: 0.3, paintFalloff: 2.2,
    emissive: 1.4, emissiveThresh: 0.55,
    bloomStrength: 0, bloomThreshold: 0.75, bloomRadius: 0.55,
    exposure: 1.05, vignette: 0.35, shadowOpacity: 0.3,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Swamp: {
    keyAz: -35, keyEl: 40, keyColor: '#b8d67a', keyIntensity: 1.9,
    fillAz: 120, fillEl: 10, fillColor: '#35502e', fillIntensity: 0.6,
    rimSpace: 'camera', rimAz: -10, rimEl: 45, rimColor: '#d6ffb0', rimIntensity: 2.0,
    ambientIntensity: 0.45, skyColor: '#6a8a4a', groundColor: '#1c2412',
    background: '#22301c', fogDensity: 0.06,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.0, edgeFloor: 0.3,
    surfaceRim: 0.65, surfaceRimPower: 2.3, rimTaper: 1.9,
    paintRim: 2.2, paintKey: 0.7, paintWidth: 2.4, paintTaper: 1.5,
    paintInset: 0.05, paintThreshold: 0.3, paintFalloff: 2.2,
    emissive: 1.2, emissiveThresh: 0.55,
    bloomStrength: 0, bloomThreshold: 0.78, bloomRadius: 0.5,
    exposure: 1.0, vignette: 0.34, shadowOpacity: 0.35,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Cave: {
    keyAz: 25, keyEl: 30, keyColor: '#ffb85c', keyIntensity: 1.8,
    fillAz: -90, fillEl: 15, fillColor: '#3a4e80', fillIntensity: 0.45,
    rimSpace: 'camera', rimAz: 30, rimEl: 45, rimColor: '#7fd4ff', rimIntensity: 2.0,
    ambientIntensity: 0.25, skyColor: '#26314d', groundColor: '#17110c',
    background: '#0d1017', fogDensity: 0.045,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.1, edgeFloor: 0.3,
    surfaceRim: 0.7, surfaceRimPower: 2.6, rimTaper: 2.4,
    paintRim: 2.2, paintKey: 1.0, paintWidth: 2.2, paintTaper: 1.7,
    paintInset: 0.08, paintThreshold: 0.35, paintFalloff: 2.5,
    emissive: 1.6, emissiveThresh: 0.6,
    bloomStrength: 0, bloomThreshold: 0.72, bloomRadius: 0.5,
    exposure: 1.1, vignette: 0.42, shadowOpacity: 0.5,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Moonlit: {
    keyAz: -40, keyEl: 55, keyColor: '#bcd2ff', keyIntensity: 1.6,
    fillAz: 100, fillEl: 12, fillColor: '#2c3c58', fillIntensity: 0.5,
    rimSpace: 'camera', rimAz: -20, rimEl: 35, rimColor: '#e8f4ff', rimIntensity: 2.0,
    ambientIntensity: 0.3, skyColor: '#4a5c85', groundColor: '#101a14',
    background: '#141a26', fogDensity: 0.03,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.0, edgeFloor: 0.28,
    surfaceRim: 0.65, surfaceRimPower: 2.4, rimTaper: 2.2,
    paintRim: 2.0, paintKey: 0.7, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.32, paintFalloff: 2.3,
    emissive: 1.1, emissiveThresh: 0.6,
    bloomStrength: 0, bloomThreshold: 0.8, bloomRadius: 0.45,
    exposure: 1.0, vignette: 0.35, shadowOpacity: 0.4,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Bloodmoon: {
    keyAz: 30, keyEl: 40, keyColor: '#ff4d3d', keyIntensity: 2.0,
    fillAz: -100, fillEl: 15, fillColor: '#4d1030', fillIntensity: 0.5,
    rimSpace: 'camera', rimAz: 15, rimEl: 40, rimColor: '#ff8a70', rimIntensity: 2.2,
    ambientIntensity: 0.25, skyColor: '#55182a', groundColor: '#180808',
    background: '#12060a', fogDensity: 0.035,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.1, edgeFloor: 0.3,
    surfaceRim: 0.7, surfaceRimPower: 2.5, rimTaper: 2.2,
    paintRim: 2.4, paintKey: 0.9, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.32, paintFalloff: 2.4,
    emissive: 1.8, emissiveThresh: 0.55,
    bloomStrength: 0, bloomThreshold: 0.75, bloomRadius: 0.5,
    exposure: 1.05, vignette: 0.4, shadowOpacity: 0.5,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  Blizzard: {
    keyAz: -20, keyEl: 35, keyColor: '#e8f2ff', keyIntensity: 1.7,
    fillAz: 90, fillEl: 20, fillColor: '#9fb6d6', fillIntensity: 0.8,
    rimSpace: 'camera', rimAz: 0, rimEl: 40, rimColor: '#ffffff', rimIntensity: 1.6,
    ambientIntensity: 0.8, skyColor: '#cfe0f2', groundColor: '#8a97a8',
    background: '#aebfd4', fogDensity: 0.085,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.2, edgeFloor: 0.35,
    surfaceRim: 0.4, surfaceRimPower: 2.6, rimTaper: 2.2,
    paintRim: 1.2, paintKey: 0.9, paintWidth: 2.0, paintTaper: 1.6,
    paintInset: 0.06, paintThreshold: 0.38, paintFalloff: 2.6,
    emissive: 0.0, emissiveThresh: 0.6,
    bloomStrength: 0, bloomThreshold: 0.85, bloomRadius: 0.4,
    exposure: 1.02, vignette: 0.22, shadowOpacity: 0.2,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
  'The End': {
    keyAz: 25, keyEl: 55, keyColor: '#d9c8ff', keyIntensity: 1.8,
    fillAz: -110, fillEl: 12, fillColor: '#3a2a5e', fillIntensity: 0.5,
    rimSpace: 'camera', rimAz: 20, rimEl: 40, rimColor: '#c07fff', rimIntensity: 2.2,
    ambientIntensity: 0.3, skyColor: '#4a3a6e', groundColor: '#14101f',
    background: '#0b0713', fogDensity: 0.03,
    rimEdgeIntensity: 0, keyEdgeIntensity: 0, edgeWidth: 1.0, edgeFalloff: 2.1, edgeFloor: 0.3,
    surfaceRim: 0.7, surfaceRimPower: 2.4, rimTaper: 2.3,
    paintRim: 2.3, paintKey: 0.8, paintWidth: 2.2, paintTaper: 1.6,
    paintInset: 0.07, paintThreshold: 0.32, paintFalloff: 2.4,
    emissive: 1.5, emissiveThresh: 0.5,
    bloomStrength: 0, bloomThreshold: 0.78, bloomRadius: 0.5,
    exposure: 1.05, vignette: 0.38, shadowOpacity: 0.45,
    hdriBackground: false, hdriIntensity: 0, hdriBlur: 0,
  },
};
