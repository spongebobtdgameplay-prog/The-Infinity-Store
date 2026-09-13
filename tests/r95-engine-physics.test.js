import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function Source(Path) {
  return readFile(new URL(`../${Path}`, import.meta.url), "utf8");
}

test("R95 engine loads before game bootstrap and pins Three.js", async () => {
  const Index = await Source("index.html");
  const EngineIndex = Index.indexOf("store-engine-core-r95.js");
  const BootstrapIndex = Index.indexOf("bootstrap.js");

  assert.ok(EngineIndex >= 0, "engine core script missing");
  assert.ok(BootstrapIndex > EngineIndex, "engine core must load before bootstrap");
  assert.match(Index, /three@0\.180\.0\/build\/three\.module\.js/);
  assert.match(Index, /BUILD V0\.35\.66/);
});

test("grouped spring deformer keeps recovered Gaussian, ring bulge and welded-group math", async () => {
  const Engine = await Source("store-engine-core-r95.js");

  assert.match(Engine, /Math\.exp\(-Math\.max\(0, DistanceSquared\) \/ \(2 \* SafeRadius \* SafeRadius\)\)/);
  assert.match(Engine, /2 \* \(Number\(Depth\) \|\| 0\) \* \(Number\(BulgeAmount\) \|\| 0\) \* T \* \(1 - T\)/);
  assert.match(Engine, /this\.VertexGroup = new Int32Array/);
  assert.match(Engine, /this\.RestVertices\[VertexOffset\] \+ this\.GroupDisplacement\[GroupOffset\]/);
  assert.match(Engine, /1 \/ \(1 \+ Dt \* Damping\)/);
});

test("visible physical collision covers chunk meshes and instanced meshes", async () => {
  const Collision = await Source("runtime-visible-collision-fix-r92.js");

  assert.match(Collision, /VisiblePhysicalWorldR95/);
  assert.match(Collision, /Root\.traverse/);
  assert.match(Collision, /Object\.isInstancedMesh/);
  assert.match(Collision, /Object\.getMatrixAt/);
  assert.match(Collision, /IsPhysicalMesh\(Object\)/);
  assert.match(Collision, /ShapeHitsPlayer/);
});

test("upper-body contacts are pose-only while lower body remains root authoritative", async () => {
  const Contact = await Source("lower-body-contact-authority-r95.js");

  assert.match(Contact, /Mode: "LOWER_BODY_ONLY"/);
  assert.match(Contact, /UpperBodyContact: "POSE_ONLY"/);
  assert.match(Contact, /RootBlocking: "CAPSULE_FEET_LEGS"/);
  assert.match(Contact, /Position\.y - Math\.max\(0, Number\(Radius\) \|\| 0\) > LowerBodyCeiling/);
  assert.match(Contact, /OriginalResolveBodyPartCurbForce\(Position, Radius, Target, Clearance\)/);
});
