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

test('engine still owns fallback physical-object collision', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /function BuildCollisionPieces/);
  assert.match(engine, /function BuildCompoundCollisionEntry/);
  assert.match(engine, /function EnsureChunkCollision/);
  assert.match(engine, /GetContactNormal/);
  assert.match(core, /EngineCollision\.EnsureChunkCollision/);
  assert.doesNotMatch(core, /BuildExactFootprint/);
});

test('haze never overrides Renderer.render or forces chunks visible', () => {
  const haze = read('distance-haze-r82.js');
  assert.doesNotMatch(haze, /Renderer\.render\s*=/);
  assert.doesNotMatch(haze, /KeepActiveChunksRenderable/);
  assert.doesNotMatch(haze, /Chunk\.Group\.visible\s*=\s*true/);
});

test('streaming stays asymmetric and bounded', () => {
  const stream = read('stream-range.js');
  assert.match(stream, /ActiveBack:\s*1/);
  assert.match(stream, /PrefetchRadius:\s*1/);
  const Ahead = Number(stream.match(/ActiveAhead:\s*(\d+)/)?.[1]);
  const Boot = Number(stream.match(/BootCount:\s*(\d+)/)?.[1]);
  assert.ok(Ahead >= 2 && Ahead <= 3);
  assert.ok(Boot >= 3 && Boot <= 4);
});

test('background generation waits for real gameplay idle budget', () => {
  const budget = read('render-work-budget.js');
  assert.match(budget, /GameplayActive/);
  assert.match(budget, /Deadline\.timeRemaining\(\) >= RequiredIdleMs/);
  assert.match(budget, /!GameplayActive && Elapsed >= MaximumWaitMs/);
});
