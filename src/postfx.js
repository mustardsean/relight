import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Screen-space edge highlight: detect geometric edges from a normal+depth
// prepass, then brighten the edges that face the rim/key lights. This is what
// produces the "hard edges catching the light" look from Minecraft promo art.

const EdgeHighlightShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    edgeWidth: { value: 1.0 },
    normalThreshold: { value: 0.4 },
    depthThreshold: { value: 0.03 },
    rimDir: { value: new THREE.Vector3(0, 0, 1) }, // view space
    keyDir: { value: new THREE.Vector3(0, 0, 1) }, // view space
    rimEdgeColor: { value: new THREE.Color(0xffffff) },
    keyEdgeColor: { value: new THREE.Color(0xffffff) },
    rimEdgeIntensity: { value: 1.5 },
    keyEdgeIntensity: { value: 0.4 },
    edgeFalloff: { value: 1.5 },
    edgeFloor: { value: 0.25 },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 100 },
    vignette: { value: 0.25 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float edgeWidth;
    uniform float normalThreshold;
    uniform float depthThreshold;
    uniform vec3 rimDir;
    uniform vec3 keyDir;
    uniform vec3 rimEdgeColor;
    uniform vec3 keyEdgeColor;
    uniform float rimEdgeIntensity;
    uniform float keyEdgeIntensity;
    uniform float edgeFalloff;
    uniform float edgeFloor;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float vignette;
    varying vec2 vUv;

    float linearizeDepth(float d) {
      float z = d * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
    }

    vec3 sampleNormal(vec2 uv) {
      return texture2D(tNormal, uv).xyz * 2.0 - 1.0;
    }

    void main() {
      vec4 beauty = texture2D(tDiffuse, vUv);
      vec2 texel = edgeWidth / resolution;

      vec3 n = sampleNormal(vUv);
      float d = linearizeDepth(texture2D(tDepth, vUv).x);
      float hasGeo = texture2D(tNormal, vUv).a;

      // Neighbor samples (cross pattern)
      vec3 nR = sampleNormal(vUv + vec2(texel.x, 0.0));
      vec3 nL = sampleNormal(vUv - vec2(texel.x, 0.0));
      vec3 nU = sampleNormal(vUv + vec2(0.0, texel.y));
      vec3 nD = sampleNormal(vUv - vec2(0.0, texel.y));

      float dR = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x);
      float dL = linearizeDepth(texture2D(tDepth, vUv - vec2(texel.x, 0.0)).x);
      float dU = linearizeDepth(texture2D(tDepth, vUv + vec2(0.0, texel.y)).x);
      float dD = linearizeDepth(texture2D(tDepth, vUv - vec2(0.0, texel.y)).x);

      // Normal discontinuity
      float nEdge = 0.0;
      nEdge = max(nEdge, distance(n, nR));
      nEdge = max(nEdge, distance(n, nL));
      nEdge = max(nEdge, distance(n, nU));
      nEdge = max(nEdge, distance(n, nD));
      nEdge = smoothstep(normalThreshold, normalThreshold + 0.3, nEdge);

      // Depth discontinuity (silhouettes), scaled by distance
      float dEdge = 0.0;
      float dScale = depthThreshold * max(d, 1.0);
      dEdge = max(dEdge, abs(d - dR));
      dEdge = max(dEdge, abs(d - dL));
      dEdge = max(dEdge, abs(d - dU));
      dEdge = max(dEdge, abs(d - dD));
      dEdge = smoothstep(dScale, dScale * 2.0, dEdge);

      float edge = max(nEdge, dEdge) * hasGeo;

      // Edge pixels use the "most lit" normal among neighbors so the bright
      // side of a hard corner catches the light, not the average.
      vec3 litNormal = n;
      float best = dot(n, rimDir);
      if (dot(nR, rimDir) > best) { best = dot(nR, rimDir); litNormal = nR; }
      if (dot(nL, rimDir) > best) { best = dot(nL, rimDir); litNormal = nL; }
      if (dot(nU, rimDir) > best) { best = dot(nU, rimDir); litNormal = nU; }
      if (dot(nD, rimDir) > best) { best = dot(nD, rimDir); litNormal = nD; }

      float rimFace = pow(max(dot(litNormal, rimDir), 0.0), edgeFalloff);
      float keyFace = pow(max(dot(litNormal, keyDir), 0.0), edgeFalloff);
      // Edges that barely face a light get nothing at all — kills the
      // uniform "wireframe glow" look on shadowed sides.
      rimFace = max(rimFace - edgeFloor, 0.0) / (1.0 - edgeFloor);
      keyFace = max(keyFace - edgeFloor, 0.0) / (1.0 - edgeFloor);

      vec3 highlight =
        rimEdgeColor * (rimFace * rimEdgeIntensity) +
        keyEdgeColor * (keyFace * keyEdgeIntensity);

      vec3 color = beauty.rgb + highlight * edge;

      // Vignette
      vec2 vuv = vUv - 0.5;
      float vig = 1.0 - smoothstep(0.4, 0.95, length(vuv) * (1.0 + vignette)) * vignette * 1.6;
      color *= vig;

      gl_FragColor = vec4(color, beauty.a);
    }
  `,
};

// Normal+alpha prepass material, cloned per source material so alpha-tested
// (cutout) faces punch through correctly.
function makeNormalMaterial(srcMaterial) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: srcMaterial.map || null },
      alphaTest: { value: srcMaterial.alphaTest || 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float alphaTest;
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        if (alphaTest > 0.0) {
          float a = texture2D(map, vUv).a;
          if (a < alphaTest) discard;
        }
        gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
      }
    `,
  });
  return mat;
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
    });
    this.normalTarget.depthTexture = new THREE.DepthTexture(1, 1);

    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.edgePass = new ShaderPass(EdgeHighlightShader);
    this.edgePass.uniforms.tNormal.value = this.normalTarget.texture;
    this.edgePass.uniforms.tDepth.value = this.normalTarget.depthTexture;
    this.composer.addPass(this.edgePass);

    // Depth of field — the cinematic separator for world backdrops. Sits
    // after the edge pass so painted strokes defocus with their surfaces.
    this.bokehPass = new BokehPass(scene, camera, {
      focus: 5,
      aperture: 0.002,
      maxblur: 0.01,
    });
    this.bokehPass.enabled = false;
    this.composer.addPass(this.bokehPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.82);
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this._normalMatCache = new Map();
    this._swapped = [];
  }

  clearMaterialCache() {
    for (const mat of this._normalMatCache.values()) mat.dispose();
    this._normalMatCache.clear();
  }

  setSize(width, height) {
    this.composer.setSize(width, height);
    this.normalTarget.setSize(width, height);
    this.edgePass.uniforms.resolution.value.set(width, height);
  }

  // Swap materials to normal-prepass variants for everything except
  // objects flagged userData.noEdges, render the prepass, restore.
  renderNormalPass() {
    const { scene, camera, renderer } = this;
    this._swapped.length = 0;
    scene.traverse((obj) => {
      // noEdges applies to any renderable (meshes, gizmo lines, helpers)
      if (obj.userData.noEdges) {
        if (!obj.visible) return;
        this._swapped.push({ obj, visible: true, material: null });
        obj.visible = false;
        return;
      }
      if (!obj.isMesh) return;
      const src = Array.isArray(obj.material) ? obj.material : [obj.material];
      const variants = src.map((m) => {
        let v = this._normalMatCache.get(m);
        if (!v) {
          v = makeNormalMaterial(m);
          this._normalMatCache.set(m, v);
        }
        return v;
      });
      this._swapped.push({ obj, visible: obj.visible, material: obj.material });
      obj.material = Array.isArray(obj.material) ? variants : variants[0];
    });

    const oldBg = scene.background;
    const oldFog = scene.fog;
    scene.background = null;
    scene.fog = null;
    renderer.setRenderTarget(this.normalTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.background = oldBg;
    scene.fog = oldFog;

    for (const s of this._swapped) {
      s.obj.visible = s.visible;
      if (s.material) s.obj.material = s.material;
    }
    this._swapped.length = 0;
  }

  // Light directions must be given in world space; converted to view space here.
  updateLightDirs(rimDirWorld, keyDirWorld) {
    const toView = (v, target) => {
      target.copy(v).transformDirection(this.camera.matrixWorldInverse);
      return target;
    };
    toView(rimDirWorld, this.edgePass.uniforms.rimDir.value);
    toView(keyDirWorld, this.edgePass.uniforms.keyDir.value);
  }

  render() {
    this.edgePass.uniforms.cameraNear.value = this.camera.near;
    this.edgePass.uniforms.cameraFar.value = this.camera.far;
    this.renderNormalPass();
    this.composer.render();
  }
}
