import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('R100 collision subdivides irregular meshes into occupied local cells', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /function GeometryCellBoxes/);
  assert.match(engine, /function TriangleIntersectsCell2D/);
  assert.match(engine, /EngineCompoundR100/);
  assert.match(core, /CollisionGridAxis:\s*4/);
  assert.match(core, /MaximumPieces:\s*96/);
});

test('R100 batches different static geometries in the engine', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /new THREE\.BatchedMesh/);
  assert.match(engine, /Batch\.addGeometry/);
  assert.match(engine, /Batch\.addInstance/);
  assert.match(engine, /perObjectFrustumCulled = true/);
  assert.match(engine, /StaticRenderBatchedR104 = true/);
  assert.match(core, /EngineRender\.OptimizeChunkStaticRender/);
  assert.match(core, /WaitForWorkSlice\(4, 900\)/);
});

test('R100 reduces the live aisle and boot window', () => {
  const stream = read('stream-range.js');
  assert.match(stream, /ActiveBack:\s*1/);
  assert.match(stream, /ActiveAhead:\s*2/);
  assert.match(stream, /PrefetchRadius:\s*1/);
  assert.match(stream, /BootCount:\s*3/);
});

test('R100 gives gameplay background work a larger real idle budget', () => {
  const budget = read('render-work-budget.js');
  assert.match(budget, /Math\.min\(Math\.max\(3\.5, MinimumMs\), 4\.5\)/);
  assert.match(budget, /timeout: GameplayActive\s*\? 1600/);
});

test('R100 performance manager adapts resolution with hysteresis', () => {
  const perf = read('performance-manager.js');
  assert.match(perf, /AdaptiveScale/);
  assert.match(perf, /PressureSamples/);
  assert.match(perf, /RecoverySamples/);
  assert.match(perf, /UpdateAdaptiveResolution/);
  assert.match(perf, /Now - PerfState\.LastAdaptiveAt < 1200/);
});

test('R100 version and cache keys agree', () => {
  assert.equal(read('VERSION').trim(), '0.35.70');
  const bootstrap = read('bootstrap.js');
  const index = read('index.html');
  assert.match(bootstrap, /const Version = "0\.35\.70"/);
  assert.match(bootstrap, /20260913-v03570-r100-render-collision1/);
  assert.match(index, /v03570-r100-engine1/);
  assert.match(index, /v03570-r100-stream1/);
  assert.match(index, /v03570-r100-budget1/);
});
