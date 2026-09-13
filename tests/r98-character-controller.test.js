import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const exists = name => existsSync(fileURLToPath(new URL(name, root)));

test('R98 removes stacked movement and renderer wrappers', () => {
  const index = read('index.html');
  assert.doesNotMatch(index, /movement-hard-stop\.js/);
  assert.doesNotMatch(index, /runtime-collision-supplement-r97\.js/);
  assert.doesNotMatch(index, /runtime-character-physics-r97\.js/);
  assert.equal(exists('movement-hard-stop.js'), false);
  assert.equal(exists('runtime-collision-supplement-r97.js'), false);
  assert.equal(exists('runtime-character-physics-r97.js'), false);
});

test('R98 movement has one iterative move-and-slide controller', () => {
  const source = read('procedural-physics-utility.js');
  assert.match(source, /const MaxSlides = 6/);
  assert.match(source, /function ResolveCharacterMove/);
  assert.match(source, /SweepCircleFraction/);
  assert.match(source, /BuildContactManifold/);
  assert.match(source, /ProjectAgainstContacts/);
  assert.match(source, /for \(let Iteration = 0; Iteration < MaxSlides/);
  assert.doesNotMatch(source, /HardStop/);
  assert.doesNotMatch(source, /ResolveRaycastHorizontalMove/);
  assert.doesNotMatch(source, /!IsStructure\(LastEntry\)/);
});

test('R98 controller uses a local broad phase and bounded sweep work', () => {
  const source = read('procedural-physics-utility.js');
  assert.match(source, /function CollectNearbyEntries/);
  assert.match(source, /const MaxSweepSteps = 18/);
  assert.match(source, /const BinarySteps = 8/);
  assert.doesNotMatch(source, /StepCount = Clamp\(Math\.ceil\(MotionLength \/ 0\.02\)/);
  assert.doesNotMatch(source, /DirectionCount = 20/);
});

test('R98 version and bootstrap cache agree', () => {
  assert.equal(read('VERSION').trim(), '0.35.68');
  const bootstrap = read('bootstrap.js');
  assert.match(bootstrap, /const Version = "0\.35\.68"/);
  assert.match(bootstrap, /20260913-v03568-r98-controller1/);
  assert.match(read('index.html'), /BUILD V0\.35\.68/);
});
