import * as THREE from 'three';

// Evaluates Blockbench animations and poses the bone (group) hierarchy.
// Keyframe values in a .bbmodel are stored in Blockbench's internal (three.js)
// convention and are ADDED to the bind pose as-is on every axis — the x/y
// negations seen in bedrock .animation.json files happen only at export time
// (see Blockbench's compileBedrockKeyframe vs displayRotation/displayPosition).

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function sampleChannel(keyframes, time) {
  // keyframes: sorted [{time, values:[x,y,z], interpolation}]
  if (keyframes.length === 0) return null;
  if (time <= keyframes[0].time) return keyframes[0].values;
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return last.values;

  let i = 0;
  while (i < keyframes.length - 1 && keyframes[i + 1].time <= time) i++;
  const a = keyframes[i];
  const b = keyframes[i + 1];
  if (a.interpolation === 'step') return a.values;
  const span = b.time - a.time;
  const t = span > 0 ? (time - a.time) / span : 0;
  return [
    a.values[0] + (b.values[0] - a.values[0]) * t,
    a.values[1] + (b.values[1] - a.values[1]) * t,
    a.values[2] + (b.values[2] - a.values[2]) * t,
  ];
}

// Pre-digest one bbmodel animation into per-bone sorted channels.
export function compileAnimation(anim) {
  const bones = [];
  const animators = anim.animators || {};
  for (const uuid of Object.keys(animators)) {
    const animator = animators[uuid];
    if (animator.type && animator.type !== 'bone') continue;
    const channels = { rotation: [], position: [], scale: [] };
    for (const kf of animator.keyframes || []) {
      const ch = channels[kf.channel];
      if (!ch) continue;
      const dp = kf.data_points?.[0] || {};
      ch.push({
        time: kf.time,
        interpolation: kf.interpolation || 'linear',
        values: [num(dp.x), num(dp.y), num(dp.z)],
      });
    }
    for (const ch of Object.values(channels)) ch.sort((a, b) => a.time - b.time);
    if (channels.rotation.length || channels.position.length || channels.scale.length) {
      bones.push({ uuid, name: animator.name, channels });
    }
  }
  return { name: anim.name, length: anim.length || 0, loop: anim.loop, bones };
}

export function resetPose(groupsByUuid) {
  for (const group of groupsByUuid.values()) {
    group.position.copy(group.userData.bindPos);
    group.rotation.copy(group.userData.bindRot);
    group.scale.set(1, 1, 1);
  }
}

export function applyPose(compiled, time, groupsByUuid) {
  resetPose(groupsByUuid);
  if (!compiled) return;
  const d2r = THREE.MathUtils.degToRad;
  for (const bone of compiled.bones) {
    const group = groupsByUuid.get(bone.uuid);
    if (!group) continue;
    const rot = sampleChannel(bone.channels.rotation, time);
    if (rot) {
      group.rotation.x = group.userData.bindRot.x + d2r(rot[0]);
      group.rotation.y = group.userData.bindRot.y + d2r(rot[1]);
      group.rotation.z = group.userData.bindRot.z + d2r(rot[2]);
    }
    const pos = sampleChannel(bone.channels.position, time);
    if (pos) {
      group.position.x = group.userData.bindPos.x + pos[0];
      group.position.y = group.userData.bindPos.y + pos[1];
      group.position.z = group.userData.bindPos.z + pos[2];
    }
    const scl = sampleChannel(bone.channels.scale, time);
    if (scl) {
      group.scale.set(scl[0] || 1, scl[1] || 1, scl[2] || 1);
    }
  }
}
