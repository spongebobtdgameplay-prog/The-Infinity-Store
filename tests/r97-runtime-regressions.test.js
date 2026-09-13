import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('R97 runtime owns supplemental collision and character physics', () => {
  const index = read('index.html');
  assert.match(index, /runtime-collision-supplement-r97\.js/);
  assert.match(index, /runtime-character-physics-r97\.js/);
  assert.doesNotMatch(index, /runtime-visible-collision-fix-r92\.js/);
  assert.doesNotMatch(index, /runtime-render-budget-r96\.js/);
  assert.doesNotMatch(index, /lower-body-contact-authority-r95\.js/);
});

test('R97 collision supplement does not rebuild triangle meshes', () => {
  const source = read('runtime-collision-supplement-r97.js');
  assert.doesNotMatch(source, /TriangleIndex/);
  assert.doesNotMatch(source, /TriangleCount/);
  assert.doesNotMatch(source, /position\.count\s*\/\s*3/i);
  assert.match(source, /computeBoundingBox/);
  assert.match(source, /CoreFixR87/);
  assert.match(source, /PurgeOldRuntimeCollision/);
});

test('R97 character physics keeps upper-body contact visual-only and restores wheel distance', () => {
  const source = read('runtime-character-physics-r97.js');
  assert.match(source, /GetThirdPersonDistance/);
  assert.match(source, /CAPSULE_FEET_LEGS/);
  assert.match(source, /POSE_ONLY/);
  assert.match(source, /UpperBodyVisualOnlyR97/);
  assert.match(source, /CorrectThirdPersonCamera/);
  assert.match(source, /RestoreBonePose/);
});

test('R97 version and bootstrap cache agree', () => {
  assert.equal(read('VERSION').trim(), '0.35.67');
  const bootstrap = read('bootstrap.js');
  assert.match(bootstrap, /const Version = "0\.35\.67"/);
  assert.match(bootstrap, /20260913-v03567-r97-runtime1/);
  assert.match(read('index.html'), /BUILD V0\.35\.67/);
});
