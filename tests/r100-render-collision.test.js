import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('R101 keeps R100 occupied-cell collision', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /function GeometryCellBoxes/);
  assert.match(engine, /function TriangleIntersectsCell2D/);
  assert.match(engine, /EngineCompoundR100/);
  assert.match(core, /CollisionGridAxis:\s*4/);
  assert.match(core, /MaximumPieces:\s*96/);
});

test('R101 prevents runtime batch/cull spikes', () => {
  const engine = read('store-engine-core-r95.js');
  const core = read('core-fix-authority-r86.js');
  assert.match(engine, /new THREE\.BatchedMesh/);
  assert.match(engine, /Batch\.addGeometry/);
  assert.match(engine, /Batch\.addInstance/);
  assert.match(core, /StabilizeBatchCulling/);
  assert.match(core, /perObjectFrustumCulled = false/);
  assert.match(core, /__STORE_GAMEPLAY_STARTED__ === true\) return null/);
});

test('R101 restores the finished forward horizon', () => {
  const stream = read('stream-range.js');
  assert.match(stream, /ActiveBack:\s*1/);
  assert.match(stream, /ActiveAhead:\s*3/);
  assert.match(stream, /PrefetchRadius:\s*1/);
  assert.match(stream, /BootCount:\s*4/);
});

test('R101 no longer over-throttles gameplay background work', () => {
  const budget = read('render-work-budget.js');
  assert.match(budget, /Math\.min\(Math\.max\(2\.25, MinimumMs\), 3\.25\)/);
  assert.match(budget, /timeout: GameplayActive\s*\? 900/);
});

test('R101 performance manager uses fixed render ratio, not adaptive downshift', () => {
  const perf = read('performance-manager.js');
  assert.doesNotMatch(perf, /AdaptiveScale/);
  assert.doesNotMatch(perf, /UpdateAdaptiveResolution/);
  assert.match(perf, /const Ratio = Math\.min\(DeviceRatio, Profile\.PixelRatio\)/);
});

test('R101 version and cache keys agree', () => {
  assert.equal(read('VERSION').trim(), '0.35.71');
  const bootstrap = read('bootstrap.js');
  const index = read('index.html');
  assert.match(bootstrap, /const Version = "0\.35\.71"/);
  assert.match(bootstrap, /20260913-v03571-r101-no-render-throttle1/);
  assert.match(index, /v03571-r101-engine1/);
  assert.match(index, /v03571-r101-stream1/);
  assert.match(index, /v03571-r101-budget1/);
});
