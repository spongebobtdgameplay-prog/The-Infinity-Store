import * as THREE from "three";

const Build = "V0.35.65-R94-EXACT-VISIBLE-COLLISION";
const EyeHeight = 1.68;
const CellSize = 0.42;
const VerticalSkin = 0.022;
const ShapeCache = new WeakMap();
const PatchedEntries = new WeakMap();
const PendingEntries = new Set();
const ScratchA = new THREE.Vector3();
const ScratchB = new THREE.Vector3();
const ScratchC = new THREE.Vector3();
let WorkScheduled = false;

function IsDetailNode(Object) {
  let Current = Object;
  while (Current) {
    const Data = Current.userData || {};
    const Name = String(Current.name || "");
    if (
      Data.DecorationNoCollision === true ||
      Data.CompactPriceAuthorityR83 === true ||
      Data.WalkableCarpetR87 === true ||
      Data.DecorationKind === "Rug" ||
      Data.DecorationKind === "LargeShowroomRug" ||
      /CompactPriceTag|FurniturePriceSign|FurnitureItemSign|PricePlacard|Placard|ShelfStock|OnlineSurfaceDecoration|Rug|Carpet|Text|Label|Glow|Highlight|Selection|Outline/i.test(Name)
    ) return true;
    Current = Current.parent || null;
  }
  return false;
}

function MarkDetailNoCollision(Object) {
  if (!Object?.isObject3D) return;
  Object.traverse(Child => {
    Child.userData ||= {};
    Child.userData.DecorationNoCollision = true;
    Child.userData.IgnoreRayCollisionR35 = true;
    Child.userData.RayCollisionSolidR35 = false;
    Child.userData.LegacyMovementCollisionDisabledR35 = true;
  });
}

function ScanChunkDetails(Chunk) {
  if (!Chunk?.Group) return;
  Chunk.Group.traverse(Object => {
    if (Object === Chunk.Group) return;
    const Name = String(Object.name || "");
    const Data = Object.userData || {};
    if (
      Data.CompactPriceAuthorityR83 === true ||
      Data.WalkableCarpetR87 === true ||
      Data.DecorationKind === "Rug" ||
      Data.DecorationKind === "LargeShowroomRug" ||
      /CompactPriceTag|FurniturePriceSign|FurnitureItemSign|PricePlacard|Placard|ShelfStock|OnlineSurfaceDecoration|Rug|Carpet/i.test(Name)
    ) MarkDetailNoCollision(Object);
  });
}

function EntryObject(Entry) {
  return Entry?.CollisionObject || Entry?.SourceModel || Entry?.Model || null;
}

function PurgeDetailEntries(Game) {
  const Purge = Entries => {
    if (!Array.isArray(Entries)) return;
    for (let Index = Entries.length - 1; Index >= 0; Index -= 1) {
      const Entry = Entries[Index];
      const Object = EntryObject(Entry);
      const Type = String(Entry?.Type || "");
      if (!IsDetailNode(Object) && !/Price|Placard|ShelfStock|OnlineSurfaceDecoration|Rug|Carpet/i.test(Type)) continue;
      Entry.Active = false;
      Entries.splice(Index, 1);
    }
  };

  Purge(Game.CollisionBoxes);
  for (const Chunk of Game.ActiveChunks?.values?.() || []) Purge(Chunk?.CollisionEntries);
  for (const Chunk of Game.PreparedChunks?.values?.() || []) Purge(Chunk?.CollisionEntries);
}

function MaterialVisible(Material) {
  if (!Material || Material.visible === false) return false;
  if (Material.transparent && Number(Material.opacity) <= 0.08) return false;
  return true;
}

function MeshCanCollide(Object) {
  if (!Object?.isMesh || !Object.visible || !Object.geometry?.attributes?.position) return false;
  if (IsDetailNode(Object)) return false;
  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  return !Materials.length || Materials.some(MaterialVisible);
}

function CellKey(X, Z) {
  return `${X}:${Z}`;
}

function DistanceSquaredToSegment(X, Z, A, B) {
  const DX = B.x - A.x;
  const DZ = B.y - A.y;
  const LengthSquared = DX * DX + DZ * DZ;
  if (LengthSquared <= 0.0000001) {
    const PX = X - A.x;
    const PZ = Z - A.y;
    return PX * PX + PZ * PZ;
  }
  const T = THREE.MathUtils.clamp(((X - A.x) * DX + (Z - A.y) * DZ) / LengthSquared, 0, 1);
  const PX = X - (A.x + DX * T);
  const PZ = Z - (A.y + DZ * T);
  return PX * PX + PZ * PZ;
}

function PointInsideTriangle(X, Z, A, B, C) {
  const Area = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
  if (Math.abs(Area) <= 0.0000001) return false;
  const AB = (B.x - A.x) * (Z - A.y) - (B.y - A.y) * (X - A.x);
  const BC = (C.x - B.x) * (Z - B.y) - (C.y - B.y) * (X - B.x);
  const CA = (A.x - C.x) * (Z - C.y) - (A.y - C.y) * (X - C.x);
  const HasNegative = AB < -0.000001 || BC < -0.000001 || CA < -0.000001;
  const HasPositive = AB > 0.000001 || BC > 0.000001 || CA > 0.000001;
  return !(HasNegative && HasPositive);
}

function CircleHitsTriangle(X, Z, RadiusSquared, Triangle) {
  return PointInsideTriangle(X, Z, Triangle.A, Triangle.B, Triangle.C) ||
    DistanceSquaredToSegment(X, Z, Triangle.A, Triangle.B) <= RadiusSquared ||
    DistanceSquaredToSegment(X, Z, Triangle.B, Triangle.C) <= RadiusSquared ||
    DistanceSquaredToSegment(X, Z, Triangle.C, Triangle.A) <= RadiusSquared;
}

function AddTriangleToGrid(Grid, Triangle, Index) {
  const MinX = Math.floor(Math.min(Triangle.A.x, Triangle.B.x, Triangle.C.x) / CellSize);
  const MaxX = Math.floor(Math.max(Triangle.A.x, Triangle.B.x, Triangle.C.x) / CellSize);
  const MinZ = Math.floor(Math.min(Triangle.A.y, Triangle.B.y, Triangle.C.y) / CellSize);
  const MaxZ = Math.floor(Math.max(Triangle.A.y, Triangle.B.y, Triangle.C.y) / CellSize);
  for (let X = MinX; X <= MaxX; X += 1) {
    for (let Z = MinZ; Z <= MaxZ; Z += 1) {
      const Key = CellKey(X, Z);
      if (!Grid.has(Key)) Grid.set(Key, []);
      Grid.get(Key).push(Index);
    }
  }
}

function ModelSignature(Model) {
  Model.updateWorldMatrix(true, true);
  let Signature = `${Model.matrixWorld.elements.map(Value => Number(Value).toFixed(4)).join(":")}:${Model.children.length}`;
  Model.traverse(Object => {
    if (!Object?.isMesh || !Object.geometry) return;
    Object.updateWorldMatrix(true, false);
    Signature += `|${Object.geometry.uuid}:${Object.matrixWorld.elements.map(Value => Number(Value).toFixed(4)).join(":")}`;
  });
  return Signature;
}

function BuildShape(Model, Signature) {
  const Cached = ShapeCache.get(Model);
  if (Cached?.Signature === Signature) return Cached.Shape;

  Model.updateWorldMatrix(true, true);
  const Triangles = [];
  const Grid = new Map();
  const Bounds = new THREE.Box3().makeEmpty();

  Model.traverse(Object => {
    if (!MeshCanCollide(Object)) return;
    Object.updateWorldMatrix(true, false);
    const Position = Object.geometry.attributes.position;
    const Index = Object.geometry.index || null;
    const TriangleCount = Index ? Math.floor(Index.count / 3) : Math.floor(Position.count / 3);

    for (let TriangleIndex = 0; TriangleIndex < TriangleCount; TriangleIndex += 1) {
      const Offset = TriangleIndex * 3;
      const IA = Index ? Index.getX(Offset) : Offset;
      const IB = Index ? Index.getX(Offset + 1) : Offset + 1;
      const IC = Index ? Index.getX(Offset + 2) : Offset + 2;
      ScratchA.fromBufferAttribute(Position, IA).applyMatrix4(Object.matrixWorld);
      ScratchB.fromBufferAttribute(Position, IB).applyMatrix4(Object.matrixWorld);
      ScratchC.fromBufferAttribute(Position, IC).applyMatrix4(Object.matrixWorld);

      const ABX = ScratchB.x - ScratchA.x;
      const ABZ = ScratchB.z - ScratchA.z;
      const BCX = ScratchC.x - ScratchB.x;
      const BCZ = ScratchC.z - ScratchB.z;
      const CAX = ScratchA.x - ScratchC.x;
      const CAZ = ScratchA.z - ScratchC.z;
      const HorizontalSpanSquared = Math.max(
        ABX * ABX + ABZ * ABZ,
        BCX * BCX + BCZ * BCZ,
        CAX * CAX + CAZ * CAZ
      );
      if (HorizontalSpanSquared <= 0.000004) continue;

      const Triangle = {
        A: new THREE.Vector2(ScratchA.x, ScratchA.z),
        B: new THREE.Vector2(ScratchB.x, ScratchB.z),
        C: new THREE.Vector2(ScratchC.x, ScratchC.z),
        MinY: Math.min(ScratchA.y, ScratchB.y, ScratchC.y),
        MaxY: Math.max(ScratchA.y, ScratchB.y, ScratchC.y)
      };

      const NewIndex = Triangles.length;
      Triangles.push(Triangle);
      Bounds.expandByPoint(ScratchA);
      Bounds.expandByPoint(ScratchB);
      Bounds.expandByPoint(ScratchC);
      AddTriangleToGrid(Grid, Triangle, NewIndex);
    }
  });

  const Shape = { Triangles, Grid, Bounds };
  ShapeCache.set(Model, { Signature, Shape });
  return Shape;
}

function ShapeHitsPlayer(Position, Radius, Shape) {
  if (!Shape?.Triangles?.length || Shape.Bounds.isEmpty()) return false;
  const EffectiveRadius = THREE.MathUtils.clamp(Number(Radius) || 0.255, 0.20, 0.255);
  const FeetY = Position.y - EyeHeight + 0.025;
  const HeadY = Position.y + 0.08;

  if (
    Position.x + EffectiveRadius < Shape.Bounds.min.x ||
    Position.x - EffectiveRadius > Shape.Bounds.max.x ||
    Position.z + EffectiveRadius < Shape.Bounds.min.z ||
    Position.z - EffectiveRadius > Shape.Bounds.max.z ||
    HeadY < Shape.Bounds.min.y - VerticalSkin ||
    FeetY > Shape.Bounds.max.y + VerticalSkin
  ) return false;

  const MinCellX = Math.floor((Position.x - EffectiveRadius) / CellSize);
  const MaxCellX = Math.floor((Position.x + EffectiveRadius) / CellSize);
  const MinCellZ = Math.floor((Position.z - EffectiveRadius) / CellSize);
  const MaxCellZ = Math.floor((Position.z + EffectiveRadius) / CellSize);
  const RadiusSquared = EffectiveRadius * EffectiveRadius;
  const Seen = new Set();

  for (let X = MinCellX; X <= MaxCellX; X += 1) {
    for (let Z = MinCellZ; Z <= MaxCellZ; Z += 1) {
      for (const Index of Shape.Grid.get(CellKey(X, Z)) || []) {
        if (Seen.has(Index)) continue;
        Seen.add(Index);
        const Triangle = Shape.Triangles[Index];
        if (Triangle.MaxY < FeetY - VerticalSkin || Triangle.MinY > HeadY + VerticalSkin) continue;
        if (CircleHitsTriangle(Position.x, Position.z, RadiusSquared, Triangle)) return true;
      }
    }
  }

  return false;
}

function PatchEntry(Entry) {
  if (!Entry?.CoreFixR87 || Entry.Active === false) return false;
  const Model = Entry.CollisionObject;
  if (!Model?.isObject3D || !Model.parent || IsDetailNode(Model)) return false;

  const Signature = ModelSignature(Model);
  if (PatchedEntries.get(Entry) === Signature) return false;

  const Shape = BuildShape(Model, Signature);
  if (!Shape?.Triangles?.length || Shape.Bounds.isEmpty()) return false;

  Entry.Box = Shape.Bounds.clone();
  Entry.OriginalBox = Shape.Bounds.clone();
  Entry.OriginalLegacyBox = Shape.Bounds.clone();
  Entry.TestPlayerCollision = (Position, Radius = 0.255) => ShapeHitsPlayer(Position, Radius, Shape);
  Entry.TestCollision = (Position, Radius = 0.255) => ShapeHitsPlayer(Position, Radius, Shape);
  Entry.PreciseGeometry = true;
  Entry.LegacyCollisionDisabled = true;
  Entry.VisibleCollisionR94 = true;
  PatchedEntries.set(Entry, Signature);
  return true;
}

function QueueEntries(Game) {
  for (const Entry of Game.CollisionBoxes || []) {
    if (Entry?.CoreFixR87 && Entry.Active !== false) PendingEntries.add(Entry);
  }
  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    ScanChunkDetails(Chunk);
    for (const Entry of Chunk?.CollisionEntries || []) {
      if (Entry?.CoreFixR87 && Entry.Active !== false) PendingEntries.add(Entry);
    }
  }
}

function ScheduleWork() {
  if (WorkScheduled || !PendingEntries.size) return;
  WorkScheduled = true;

  const Run = Deadline => {
    WorkScheduled = false;
    let Processed = 0;
    const CanContinue = () => !Deadline || Deadline.didTimeout || Deadline.timeRemaining() > 3;

    for (const Entry of [...PendingEntries]) {
      PendingEntries.delete(Entry);
      PatchEntry(Entry);
      Processed += 1;
      if (Processed >= 2 || !CanContinue()) break;
    }

    if (PendingEntries.size) ScheduleWork();
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(Run, { timeout: 180 });
  } else {
    setTimeout(() => Run(null), 16);
  }
}

function Install() {
  const Game = window.__STORE_GAME__;
  if (!Game?.CollisionBoxes || !Game?.ActiveChunks) return false;

  for (const Chunk of Game.ActiveChunks.values()) ScanChunkDetails(Chunk);
  for (const Chunk of Game.PreparedChunks?.values?.() || []) ScanChunkDetails(Chunk);
  PurgeDetailEntries(Game);
  QueueEntries(Game);
  ScheduleWork();

  const BuildNode = document.getElementById("BuildVersion");
  if (BuildNode) BuildNode.textContent = "BUILD V0.35.65";
  window.__STORE_VISIBLE_COLLISION_FIX_BUILD__ = Build;
  return true;
}

let Attempts = 0;
const Start = setInterval(() => {
  Attempts += 1;
  if (Install() || Attempts > 120) clearInterval(Start);
}, 50);

setInterval(Install, 700);
addEventListener("store-world-buffer-progress", Install);
addEventListener("store-settings-change", Install);
