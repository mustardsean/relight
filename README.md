# Relight

Drop a Blockbench `.bbmodel` in, get a promo-art style render out: three-point
lighting rig, soft shadows, fog, fresnel rim light, screen-space **edge
highlights** (hard cube edges catching the light, like Minecraft promo art),
and bloom. Export high-res PNGs.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```
npm install
npm run dev
```

Then open http://localhost:5173 and drag any `.bbmodel` onto the window.

Everything core works out of the box: model loading, presets, painted edges,
posing, PNG export, video export. Two features have optional extras:

| Feature | Needs | Without it |
|---|---|---|
| Daylight preset sky | A 4K `.exr` at `public/kloofendal_sky.exr` (see below) | Falls back to a plain sky-blue background |
| Minecraft world backdrops | A Minecraft install (vanilla launcher or CurseForge) for block textures | World folder shows an error; the rest unaffected |

**Assets are not committed** (model files are mod IP; the HDRI is 75 MB).
After cloning, drop any `.bbmodel` files you want bundled into `public/` — a
file named `public/moose.bbmodel` auto-loads on start. For the Daylight
preset's sky, download a 4K EXR (e.g. "Kloofendal 48d Partly Cloudy" from
Poly Haven) into `public/kloofendal_sky.exr`, or just load any .exr/.hdr via
the Environment panel.

## Use it

1. Drag any `.bbmodel` anywhere onto the window (or **Models → Add .bbmodel…**).
   Drop more models to build a scene — each new one lands beside the others.
   The **Models** folder picks the active model (clicking a model also
   activates it), and has Duplicate / Remove for horde shots. Pose, animation
   and transform controls always drive the active model.
2. Pick a **Preset**: Studio, Daylight, Sunset, Underwater, Swamp, Cave,
   Moonlit, Bloodmoon, Blizzard, The End.
3. Orbit with the mouse, tweak lights in the panel.
4. **Export → Save PNG** (1x/2x/4x, optional transparent background).

## What the controls mean

- **Key light** — main sun/lamp, casts the shadows.
- **Fill light** — soft opposite-side bounce, no shadows.
- **Rim light + edges** — the backlight. `Rim space: Camera` (default) aims it
  relative to your current view — azimuth 0 is directly behind the model, so
  the highlight always lands where you can see it and stays put while you
  orbit. `World` pins it in the scene instead. `Surface rim` is the fresnel
  glow on faces; `Edge highlight` is the bright line on hard edges facing the
  rim light; `Edge threshold` kills lines on edges that barely face the light.
- **Light handles** — the two glowing dots around the model are the key and
  rim lights. Drag them to aim the light directly. Hidden in exports.
- **Painted edges** — geometry brush strokes along cube edges that catch the
  light, tapering at the ends like hand-painted highlights (the Minecraft
  promo-art / thumbnail-artist look). An edge lights up when its corner
  direction faces the rim or key light. On alpha-cutout cubes (antlers,
  drips, foliage panels) the box edges are replaced with strokes traced along
  the texture's alpha silhouette, so the paint follows the visible pixel
  shape — flat geo gets highlighted per strand. **Blend mode** picks how
  strokes composite: Glow (additive light), Paint (opaque brush strokes),
  Ink (subtractive — dark sketch lines), Screen (soft brighten that never
  clips), Lighten (only shows where brighter than the surface), or Overlay
  (contrast pop — brightens midtones, leaves shadows alone).
  **Alt+click any stroke to erase it**
  for hand-finishing; the Restore button brings them all back. Erasures are
  per-session.
- **Emissive accents** (Effects) — bright saturated texels self-glow so accent
  colors read in dark scenes, sculk-style. Tune with the threshold slider.
- **Pose / Animation** — pick any animation embedded in the .bbmodel, scrub
  `Time` to freeze a pose for the render, or hit `Play` to preview it.
- **Manual bone posing** — click any cube to select its bone: a rotate gizmo
  appears at the bone's pivot (`R` rotate, `G` move, `Esc` deselect, hold
  `Shift` to snap 15°). Pose on top of an animation frame or from scratch.
  `Save pose…` / `Load pose…` in the Pose folder store poses as JSON — they
  match bones by uuid, then by name, so poses transfer between model
  variants. `Reset pose` returns to the bind pose.
- **Model transform** — move/rotate/scale the whole model relative to the
  ground for floating, lunging, or tilted compositions.
- **Environment** — ambient hemisphere, background, exponential fog, contact shadow.
- **Effects** — exposure (ACES tonemapping), bloom, vignette.

## Render camera

**Camera → Set render camera here** drops a camera at your current view (shown
as a small frustum in the viewport). From then on, exports always render from
that camera at the chosen **Export aspect** (16:9 / 9:16 / 1:1 / 4:3) — orbit
the viewport freely, the render doesn't care. **Look through camera** snaps
the viewport back to it; **Clear** returns exports to the live view. Export
sizes are aspect-locked: 2x = 1920 on the long edge, 4x = 3840.

## Minecraft world backdrops

**World (Minecraft map)** loads a slab of a real world save as terrain behind
your models. Point it at a save folder (the one containing `level.dat`), give
it X/Z coordinates and a radius, and Load — the dev server parses the region
files, resolves block textures from your installed Minecraft jar
(`.minecraft` or CurseForge installs are found automatically), and the slab
appears with the queried point at the origin, surface at ground level.
Models stand on it, cast shadows onto it, and share its fog and lighting.
Full cubes, plants, and water render; exotic shapes (stairs, fences) render
as simple cubes — it's a backdrop, not a world editor. Mod-added blocks
render as plain gray until modded-asset support lands.

## Video export

The **Video** folder renders animation clips to `exports/` (encoded by a
bundled ffmpeg — no install needed). **Background** picks the composite:
Scene (as seen), Greenscreen (pure green, fog/vignette/bloom/shadow-disc
suppressed for clean keying), or Transparent — which encodes ProRes 4444
`.mov` with a real alpha channel, ready to drop over any footage in an
editor. Scene clips encode H.264 `.mp4`. Set a duration and FPS,
frame a view and press **Add camera key** at each point of the move (keys are
evenly spaced in time and smoothed into an eased path — two or three keys
make a nice push-in or orbit; zero keys hold the render camera still). Every
model plays its currently selected animation on loop during the clip; models
on "None" hold their pose. Then **Render video** — frames are stepped
offline at exact timing, so nothing drops and 4K works.

Via the API: `setShot({duration, fps, cameraKeys, models})` +
`renderVideo(name)` render clips headlessly (set Export aspect to 9:16 for
Shorts).

## Control API (dev server)

External tools and scripts can drive the whole app over HTTP while it runs:

```
POST /__cmd     {"fn":"poseBone","args":["head",[-20,30,0]]}   -> {"id":42}
GET  /__result?id=42                                           -> {"ok":true,"data":...}
```

`fn` is any function on `window.__relight`. The useful set: `getState` (one
call returns models, bones, animations, camera — everything a driver needs),
`setPreset`, `setAnim`, `poseBone`, `applyPoseData`, `currentPoseData`,
`setXform`, `setActiveModel`, `duplicateModel`, `setCamera({position,target,fov})`,
`setRenderCamera`, `setExportAspect`, and `render(name, scale)` which saves a
full-quality export to `shots/<name>.png`. The browser tab must be open (it
polls for commands).

## Notes / limits

- Loads Blockbench **free-format** models with embedded textures (cubes only;
  `mesh` elements are skipped). Vanilla Java block-model JSONs reference
  external texture files and won't show textures.
- Animation keyframes: linear and step interpolation; smooth (catmullrom)
  falls back to linear. Molang expressions in keyframes evaluate as 0.
- Element/group rotation uses `ZYX` Euler order (Blockbench/GeckoLib bone
  convention). Animation keyframe values are added to the bind pose as-is —
  .bbmodel files store Blockbench's internal convention, not the bedrock
  export convention.
- `shots/` and the `/__shot` dev endpoint are a dev-only screenshot helper.
