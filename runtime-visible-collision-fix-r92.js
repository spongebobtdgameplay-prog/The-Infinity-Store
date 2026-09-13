import {
  THREE,
  IsVisualHelper,
  IsWalkableSurface
} from "./store-engine-core-r95.js";

const Build = "V0.35.66-R96-STREAMED-PHYSICAL-COLLISION";
const EyeHeight = 1.68;
const CellSize = 0.46;
const VerticalSkin = 0.022;
const HorizontalFaceCutoff = 0.90;
const CollisionChunkRadius = 2;
const RefreshIntervalMs = 320;
const PendingChunks = new Set();
const ManagedChunks = new Map();
const ScratchA = new THREE.Vector3();
const ScratchB = new THREE.Vector3();
const ScratchC = new THREE.Vector3();
const ScratchAB = new THREE.Vector3();
const ScratchAC = new THREE.Vector3();
const ScratchNormal = new THREE.Vector3();
const InstanceMatrix = new THREE.Matrix4();
const WorldMatrix = new THREE.Matrix4();
let WorkScheduled = false;

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

  const T = THREE.MathUtils.clamp(
    ((X - A.x) * DX + (Z - A.y) * DZ) / LengthSquared,
    0,
    1
  );
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

function CollisionMesh(Object) {
  if (!Object?.isMesh || !Object.geometry?.attributes?.position) return false;
  if (Object.userData?.ForceNoCollisionR95 === true) return false;
  if (Object.userData?.RenderBatchR104 === true) return false;
  if (IsVisualHelper(Object) || IsWalkableSurface(Object)) return false;

  // Static batching hides the original render meshes. Keep those hidden source
  // meshes as the collision authority instead of turning one giant instanced
  // render batch into a chunk-sized collision box.
  const BatchedSource = Object.userData?.RenderBatchedSourceR104 === true;
  if (Object.visible === false && !BatchedSource) return false;

  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  if (Materials.length && Materials.every(Material => {
    if (!Material || Material.visible === false) return true;
    return Material.transparent === true && Number(Material.opacity) <= 0.05;
  })) return false;

  return true;
}

function AddGeometryTriangles(Object, Matrix, Triangles, Grid, Bounds) {
  const Geometry = Object.geometry;
  const Position = Geometry?.attributes?.position;
  if (!Position) return;

  const Index = Geometry.index || null;
  const TriangleCount = Index
    ? Math.floor(Index.count / 3)
    : Math.floor(Position.count / 3);

  for (let TriangleIndex = 0; TriangleIndex < TriangleCount; TriangleIndex += 1) {
    const Offset = TriangleIndex * 3;
    const IA = Index ? Index.getX(Offset) : Offset;
    const IB = Index ? Index.getX(Offset + 1) : Offset + 1;
    const IC = Index ? Index.getX(Offset + 2) : Offset + 2;

    ScratchA.fromBufferAttribute(Position, IA).applyMatrix4(Matrix);
    ScratchB.fromBufferAttribute(Position, IB).applyMatrix4(Matrix);
    ScratchC.fromBufferAttribute(Position, IC).applyMatrix4(Matrix);

    ScratchAB.copy(ScratchB).sub(ScratchA);
    ScratchAC.copy(ScratchC).sub(ScratchA);
    ScratchNormal.crossVectors(ScratchAB, ScratchAC);
    const NormalLength = ScratchNormal.length();
    if (NormalLength <= 0.000001) continue;

    // Floors, tabletops and rug tops are support surfaces, not horizontal walls.
    // Their side faces remain collidable.
    if (Math.abs(ScratchNormal.y / NormalLength) >= HorizontalFaceCutoff) continue;

    const HorizontalSpanSquared = Math.max(
      (ScratchB.x - ScratchA.x) ** 2 + (ScratchB.z - ScratchA.z) ** 2,
      (ScratchC.x - ScratchB.x) ** 2 + (ScratchC.z - ScratchB.z) ** 2,
      (ScratchA.x - ScratchC.x) ** 2 + (ScratchA.z - ScratchC.z) ** 2
    );
    if (HorizontalSpanSquared <= 0.000001) continue;

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
}

function BuildShape(Root) {
  Root.updateWorldMatrix(true, true);
  const Triangles = [];
  const Grid = new Map();
  const Bounds = new THREE.Box3().makeEmpty();
  let MeshCount = 0;
  let InstanceCount = 0;

  Root.traverse(Object => {
    if (!CollisionMesh(Object)) return;
    Object.updateWorldMatrix(true, false);
    MeshCount += 1;

    if (Object.isInstancedMesh) {
      const Count = Math.max(0, Number(Object.count) || 0);
      for (let Index = 0; Index < Count; Index += 1) {
        Object.getMatrixAt(Index, InstanceMatrix);
        WorldMatrix.multiplyMatrices(Object.matrixWorld, InstanceMatrix);
        AddGeometryTriangles(Object, WorldMatrix, Triangles, Grid, Bounds);
        InstanceCount += 1;
      }
      return;
    }

    AddGeometryTriangles(Object, Object.matrixWorld, Triangles, Grid, Bounds);
  });

  return { Triangles, Grid, Bounds, MeshCount, InstanceCount };
}

function ShapeHitsPlayer(Position, Radius, Shape) {
  if (!Shape?.Triangles?.length || Shape.Bounds.isEmpty()) return false;

  const EffectiveRadius = THREE.MathUtils.clamp(Number(Radius) || 0.255, 0.20, 0.29);
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

function ChunkStamp(Chunk) {
  const Children = Chunk?.Group?.children || [];
  let Stamp = `${Children.length}:${Chunk.Group?.userData?.PresentationReadyR83 ? 1 : 0}`;
  for (const Object of Children) {
    Stamp += `|${Object.uuid}:${Object.children?.length || 0}:${Object.userData?.RenderBatchR104 ? 1 : 0}`;
  }
  return Stamp;
}

function RemoveGlobalEntry(Game, Chunk, Entry) {
  if (!Entry) return;
  Entry.Active = false;

  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    if (Game.CollisionBoxes[Index] === Entry) Game.CollisionBoxes.splice(Index, 1);
  }

  const LocalIndex = Chunk?.CollisionEntries?.indexOf?.(Entry) ?? -1;
  if (LocalIndex >= 0) Chunk.CollisionEntries.splice(LocalIndex, 1);
}

function RemoveRecord(Game, Chunk) {
  const Record = ManagedChunks.get(Chunk);
  if (!Record) return;
  for (const Entry of Record.Entries || []) RemoveGlobalEntry(Game, Chunk, Entry);
  ManagedChunks.delete(Chunk);
}

function PurgeOldR95Entries(Game, Chunk) {
  for (const Entry of [...(Chunk?.CollisionEntries || [])]) {
    if (!Entry?.CoreFixR95 || Entry.CoreFixR96) continue;
    RemoveGlobalEntry(Game, Chunk, Entry);
  }
}

function SyncEntryActivation(Game, Chunk, Entry) {
  if (!Entry) return;
  const Active = Boolean(Chunk?.Active && !Chunk?.Cancelled && Chunk?.Group?.parent);
  Entry.Active = Active;
  const GlobalIndex = Game.CollisionBoxes.indexOf(Entry);
  if (Active && GlobalIndex < 0) Game.CollisionBoxes.push(Entry);
  else if (!Active && GlobalIndex >= 0) Game.CollisionBoxes.splice(GlobalIndex, 1);
}

function MakeEntry(Chunk, Root, Shape, RootIndex) {
  const StableBounds = Shape.Bounds.clone();
  return {
    Box: StableBounds,
    OriginalBox: StableBounds.clone(),
    OriginalLegacyBox: StableBounds.clone(),
    ChunkId: Chunk.Id,
    Type: `VisiblePhysicalObjectR96:${String(Root.name || RootIndex)}`,
    Active: false,
    CoreFixR95: true,
    CoreFixR96: true,
    PreciseGeometry: true,
    LegacyCollisionDisabled: true,
    ProceduralBodyContact: true,
    CollisionObject: Root,
    VisibleMeshCountR96: Shape.MeshCount,
    VisibleInstanceCountR96: Shape.InstanceCount,
    VisibleTriangleCountR96: Shape.Triangles.length,
    TestPlayerCollision(Position, Radius = 0.255) {
      return ShapeHitsPlayer(Position, Radius, Shape);
    },
    TestCollision(Position, Radius = 0.255) {
      return ShapeHitsPlayer(Position, Radius, Shape);
    }
  };
}

function InstallChunk(Game, Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled || !Chunk.Active) return false;
  if (!Chunk.Group.userData?.PresentationReadyR83) return false;

  Chunk.CollisionEntries ||= [];
  PurgeOldR95Entries(Game, Chunk);

  const Stamp = ChunkStamp(Chunk);
  const Existing = ManagedChunks.get(Chunk);
  if (Existing?.Stamp === Stamp) {
    for (const Entry of Existing.Entries) SyncEntryActivation(Game, Chunk, Entry);
    return false;
  }

  if (Existing) RemoveRecord(Game, Chunk);

  const Entries = [];
  const Children = Chunk.Group.children || [];

  for (let RootIndex = 0; RootIndex < Children.length; RootIndex += 1) {
    const Root = Children[RootIndex];
    if (!Root?.isObject3D || IsWalkableSurface(Root)) continue;
    if (Root.userData?.RenderBatchR104 === true) continue;

    const Shape = BuildShape(Root);
    if (!Shape.Triangles.length || Shape.Bounds.isEmpty()) continue;

    const Entry = MakeEntry(Chunk, Root, Shape, RootIndex);
    Chunk.CollisionEntries.push(Entry);
    Entries.push(Entry);
    SyncEntryActivation(Game, Chunk, Entry);
  }

  ManagedChunks.set(Chunk, { Stamp, Entries });

  Chunk.Group.userData ||= {};
  Chunk.Group.userData.VisiblePhysicalCollisionR96 = true;
  Chunk.Group.userData.VisiblePhysicalObjectCountR96 = Entries.length;
  Chunk.Group.userData.VisiblePhysicalTriangleCountR96 = Entries.reduce(
    (Total, Entry) => Total + (Number(Entry.VisibleTriangleCountR96) || 0),
    0
  );
  return true;
}

function CurrentChunkIndex(Game) {
  if (!Game?.Camera || typeof Game.ChunkIndexForZ !== "function") return 0;
  return Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z));
}

function QueueNearChunks(Game) {
  const CurrentIndex = CurrentChunkIndex(Game);

  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    if (!Chunk?.Group || Chunk.Cancelled || !Chunk.Active) continue;
    const Distance = Math.abs((Number(Chunk.Index) || 0) - CurrentIndex);
    if (Distance <= CollisionChunkRadius) PendingChunks.add(Chunk);
  }

  // Precise triangle collision is needed around the player, not for every
  // prefetched aisle in memory. Far aisles keep their normal lightweight
  // collision until they enter this two-chunk safety buffer.
  for (const [Chunk] of [...ManagedChunks]) {
    const Distance = Math.abs((Number(Chunk?.Index) || 0) - CurrentIndex);
    if (Chunk?.Cancelled || !Chunk?.Active || Distance > CollisionChunkRadius) {
      RemoveRecord(Game, Chunk);
    }
  }
}

function CleanupRemoved(Game) {
  for (const [Chunk, Record] of [...ManagedChunks]) {
    if (Chunk?.Active && Chunk?.Group?.parent && !Chunk.Cancelled) {
      for (const Entry of Record.Entries || []) SyncEntryActivation(Game, Chunk, Entry);
      continue;
    }
    RemoveRecord(Game, Chunk);
  }
}

function ScheduleWork(Game) {
  if (WorkScheduled || !PendingChunks.size) return;
  WorkScheduled = true;

  const Run = Deadline => {
    WorkScheduled = false;
    let Processed = 0;
    const CanContinue = () => !Deadline || Deadline.didTimeout || Deadline.timeRemaining() > 5;

    for (const Chunk of [...PendingChunks]) {
      PendingChunks.delete(Chunk);
      InstallChunk(Game, Chunk);
      Processed += 1;
      if (Processed >= 1 || !CanContinue()) break;
    }

    if (PendingChunks.size) ScheduleWork(Game);
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(Run, { timeout: 300 });
  } else {
    setTimeout(() => Run(null), 18);
  }
}

function Install() {
  const Game = window.__STORE_GAME__;
  if (!Game?.CollisionBoxes || !Game?.ActiveChunks || !Game?.Camera) return false;

  QueueNearChunks(Game);
  CleanupRemoved(Game);
  ScheduleWork(Game);

  const BuildNode = document.getElementById("BuildVersion");
  if (BuildNode) BuildNode.textContent = "BUILD V0.35.66 • R96";

  window.__STORE_VISIBLE_COLLISION_FIX_BUILD__ = Build;
  window.__STORE_COLLISION_POLICY_R96__ = Object.freeze({
    Mode: "STREAMED_VISIBLE_PHYSICAL_OBJECTS",
    CollisionChunkRadius,
    PreparedChunkTriangleCollision: false,
    ChunkAggregateCollision: false
  });
  return true;
}

let Attempts = 0;
const Start = setInterval(() => {
  Attempts += 1;
  if (Install() || Attempts > 160) clearInterval(Start);
}, 50);

const Refresh = setInterval(Install, RefreshIntervalMs);
addEventListener("pagehide", () => {
  clearInterval(Start);
  clearInterval(Refresh);
}, { once: true });
addEventListener("store-world-buffer-progress", Install);
addEventListener("store-settings-change", Install);

export { Install, BuildShape, ShapeHitsPlayer };
