import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('R99 preserves the real player body radius instead of shrinking it', () => {
  const player = read('player-controller.js');
  const physics = read('procedural-physics-utility.js');
  assert.match(player, /const PLAYER_RADIUS = 0\.48/);
  assert.match(physics, /const DefaultRadius = 0\.48/);
  assert.match(physics, /0\.34, 0\.52/);
  assert.doesNotMatch(physics, /0\.20, 0\.32/);
  assert.match(physics, /Entry\.GetContactNormal/);
});

test('R99 engine owns fallback physical-object collision', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /function BuildCollisionPieces/);
  assert.match(engine, /function BuildCompoundCollisionEntry/);
  assert.match(engine, /function EnsureChunkCollision/);
  assert.match(engine, /EngineCompoundR99/);
  assert.match(engine, /GetContactNormal/);
  assert.match(core, /EngineCollision\.EnsureChunkCollision/);
  assert.doesNotMatch(core, /BuildExactFootprint/);
  assert.doesNotMatch(core, /TriangleCount/);
});

test('R99 haze never overrides Renderer.render or forces chunks visible', () => {
  const haze = read('distance-haze-r82.js');
  assert.doesNotMatch(haze, /Renderer\.render\s*=/);
  assert.doesNotMatch(haze, /KeepActiveChunksRenderable/);
  assert.doesNotMatch(haze, /Chunk\.Group\.visible\s*=\s*true/);
  assert.match(haze, /game\.js frustum\/object streaming/i);
});

test('R99 keeps a small asymmetric live aisle window', () => {
  const stream = read('stream-range.js');
  assert.match(stream, /ActiveBack:\s*1/);
  assert.match(stream, /ActiveAhead:\s*3/);
  assert.match(stream, /PrefetchRadius:\s*1/);
  assert.match(stream, /BootCount:\s*4/);
});

test('R99 background generation waits for real gameplay idle budget', () => {
  const budget = read('render-work-budget.js');
  assert.match(budget, /GameplayActive/);
  assert.match(budget, /Deadline\.timeRemaining\(\) >= RequiredIdleMs/);
  assert.match(budget, /!GameplayActive && Elapsed >= MaximumWaitMs/);
});

test('R99 cache-busts engine, bootstrap, stream range, and work budget', () => {
  const index = read('index.html');
  assert.match(index, /store-engine-core-r95\.js\?v=20260913-v03569-r99-engine1/);
  assert.match(index, /bootstrap\.js\?v=20260913-v03569-r99-engine-stream1/);
  assert.match(index, /stream-range\.js\?v=20260913-v03569-r99-stream1/);
  assert.match(index, /render-work-budget\.js\?v=20260913-v03569-r99-budget1/);
});
