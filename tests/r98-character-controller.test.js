import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const exists = name => existsSync(fileURLToPath(new URL(name, root)));

test('R98 removes stacked movement, contact, and renderer wrappers', () => {
  const index = read('index.html');
  const bootstrap = read('bootstrap.js');

  for (const pattern of [
    /movement-hard-stop\.js/,
    /runtime-collision-supplement-r97\.js/,
    /runtime-character-physics-r97\.js/
  ]) assert.doesNotMatch(index, pattern);

  for (const pattern of [
    /movement-contact-compat-r25\.js/,
    /final-contact-r19\.js/
  ]) assert.doesNotMatch(bootstrap, pattern);

  for (const file of [
    'movement-hard-stop.js',
    'runtime-collision-supplement-r97.js',
    'runtime-character-physics-r97.js',
    'movement-contact-compat-r25.js',
    'final-contact-r19.js'
  ]) assert.equal(exists(file), false, `${file} should be removed`);
});

test('R98 movement keeps one iterative move-and-slide controller', () => {
  const source = read('procedural-physics-utility.js');
  assert.match(source, /const MaxSlides = 6/);
  assert.match(source, /function ResolveCharacterMove/);
  assert.match(source, /SweepCircleFraction/);
  assert.match(source, /BuildContactManifold/);
  assert.match(source, /ProjectAgainstContacts/);
  assert.match(source, /for \(let Iteration = 0; Iteration < MaxSlides/);
  assert.doesNotMatch(source, /HardStop/);
  assert.doesNotMatch(source, /ResolveRaycastHorizontalMove/);
});

test('R98 controller still uses a local broad phase and bounded sweep work', () => {
  const source = read('procedural-physics-utility.js');
  assert.match(source, /function CollectNearbyEntries/);
  assert.match(source, /const MaxSweepSteps = 18/);
  assert.match(source, /const BinarySteps = 8/);
  assert.doesNotMatch(source, /StepCount = Clamp\(Math\.ceil\(MotionLength \/ 0\.02\)/);
  assert.doesNotMatch(source, /DirectionCount = 20/);
});

test('removed full-body triangle and per-render contact passes stay removed', () => {
  const bootstrap = read('bootstrap.js');
  const index = read('index.html');
  assert.doesNotMatch(bootstrap, /ForceTriangleConstraint/);
  assert.doesNotMatch(bootstrap, /Final limb contact/);
  assert.doesNotMatch(index, /runtime-character-physics/);
});

test('current version and bootstrap cache agree', () => {
  assert.equal(read('VERSION').trim(), '0.35.69');
  const bootstrap = read('bootstrap.js');
  assert.match(bootstrap, /const Version = "0\.35\.69"/);
  assert.match(bootstrap, /20260913-v03569-r99-engine-stream1/);
  assert.match(read('index.html'), /BUILD V0\.35\.69/);
});
