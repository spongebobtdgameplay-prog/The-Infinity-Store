import * as THREE from "three";

const Build = "V0.35.62-R92-VISIBLE-COLLISION";
const ShapeCache = new WeakMap();
const PatchedEntries = new WeakSet();
const PatchedRoots = new WeakSet();
const CellSize = 0.52;
const EyeHeight = 1.68;
const ScratchA = new THREE.Vector3();
const ScratchB = new THREE.Vector3();
const ScratchC = new THREE.Vector3();
const ScratchAB = new THREE.Vector3();
const ScratchAC = new THREE.Vector3();
const ScratchNormal = new THREE.Vector3();
const ScratchWorld = new THREE.Vector3();
const FrustumMatrix = new THREE.Matrix4();
const Frustum = new THREE.Frustum();
const ChunkBox = new THREE.Box3();

function IsNoCollisionNode(Object) {
  let Current = Object;
  while (Current) {
    const Data = Current.userData || {};
    const Name = String(Current.name || "");
    if (
      Data.DecorationNoCollision === true ||
      Data.CompactPriceAuthorityR83 === true ||
      Data.ShelfStockR83 === true ||
      Data.WalkableCarpetR87 === true ||
      Data.DecorationKind === "Rug" ||
      Data.DecorationKind === "LargeShowroomRug" ||
      /CompactPriceTag|FurniturePriceSign|FurnitureItemSign|PricePlacard|Placard|ShelfStock|OnlineSurfaceDecoration|Text|Label|Glow|Highlight|Selection|Outline|Rug|Carpet/i.test(Name)
    ) return true;
    Current = Current.parent || null;
  }
  return false;
}

function MarkNoCollision(Object) {
  if (!Object || PatchedRoots.has(Object)) return;
  PatchedRoots.add(Object);
  Object.traverse?.(Child => {
    Child.userData ||= {};
    Child.userData.DecorationNoCollision = true;
    Child.userData.IgnoreRayCollisionR35 = true;
    Child.userData.RayCollisionSolidR35 = false;
    Child.userData.LegacyMovementCollisionDisabledR35 = true;
  });
}

function MarkDecorations(Game) {
  Game.Scene?.traverse?.(Object => {
    if (!Object?.isObject3D) return;
    const Data = Object.userData || {};
    const Name = String(Object.name || "");
    if (
      Data.CompactPriceAuthorityR83 === true ||
      Data.ShelfStockR83 === true ||
      Data.WalkableCarpetR87 === true ||
      Data.DecorationKind === "Rug" ||
      Data.DecorationKind === "LargeShowroomRug" ||
      /CompactPriceTag|FurniturePriceSign|FurnitureItemSign|PricePlacard|Placard|ShelfStock|OnlineSurfaceDecoration/i.test(Name)
    ) MarkNoCollision(Object);
  });
}

function EntryObject(Entry) {
  return Entry?.CollisionObject || Entry?.SourceModel || Entry?.Model || null;
}

function PurgeDecorationEntries(Game) {
  const RemoveFrom = Entries => {
    if (!Array.isArray(Entries)) return;
    for (let Index = Entries.length - 1; Index >= 0; Index -= 1) {
      const Entry = Entries[Index];
      const Object = EntryObject(Entry);
      const Type = String(Entry?.Type || "");
      if (
        IsNoCollisionNode(Object) ||
        /Price|Placard|ShelfStock|OnlineSurfaceDecoration|Rug|Carpet/i.test(Type)
      ) {
        if (Entry) Entry.Active = false;
        Entries.splice(Index, 1);
      }
    }
  };

  RemoveFrom(Game.CollisionBoxes);
  for (const Chunk of Game.ActiveChunks?.values?.() || []) RemoveFrom(Chunk?.CollisionEntries);
  for (const Chunk of Game.PreparedChunks?.values?.() || []) RemoveFrom(Chunk?.CollisionEntries);
}

function MaterialVisible(Material) {
  if (!Material || Material.visible === false) return false;
  if (Material.transparent && Number(Material.opacity) <= 0.08) return false;
  return true;
}

function MeshCanCollide(Object) {
  if (!Object?.isMesh || !Object.visible || !Object.geometry?.attributes?.position) return false;
  if (IsNoCollisionNode(Object)) return false;
  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  return !Materials.length || Materials.some(MaterialVisible);
}

function CellKey(X, Z) {
  return `${X}:${Z}`;
}

function AddTriangleToGrid(Grid, Triangle, Index) {
  const MinX = Math.floor(Triangle.MinX / CellSize);
  const MaxX = Math.floor(Triangle.MaxX / CellSize);
  const MinZ = Math.floor(Triangle.MinZ / CellSize);
  const MaxZ = Math.floor(Triangle.MaxZ / CellSize);
  for (let X = MinX; X <= MaxX; X += 1) {
    for (let Z = MinZ; Z <= MaxZ; Z += 1) {
      const Key = CellKey(X, Z);
      let Bucket = Grid.get(Key);
      if (!Bucket) {
        Bucket = [];
        Grid.set(Key, Bucket);
      }
      Bucket.push(Index);
    }
  }
}

function BuildShape(Model) {
  const Existing = ShapeCache.get(Model);
  if (Existing) return Existing;

  Model.updateWorldMatrix(true, true);
  const Triangles = [];
  const Grid = new Map();
  const Bounds = new THREE.Box3().makeEmpty();

  Model.traverse(Object => {
    if (!MeshCanCollide(Object)) return;
    Object.updateWorldMatrix(true, false);
    const Geometry = Object.geometry;
    const Position = Geometry.attributes.position;
    const Index = Geometry.index;
    const TriangleCount = Index ? Math.floor(Index.count / 3) : Math.floor(Position.count / 3);

    for (let TriangleIndex = 0; TriangleIndex < TriangleCount; TriangleIndex += 1) {
      const Offset = TriangleIndex * 3;
      const IA = Index ? Index.getX(Offset) : Offset;
      const IB = Index ? Index.getX(Offset + 1) : Offset + 1;
      const IC = Index ? Index.getX(Offset + 2) : Offset + 2;

      ScratchA.fromBufferAttribute(Position, IA).applyMatrix4(Object.matrixWorld);
      ScratchB.fromBufferAttribute(Position, IB).applyMatrix4(Object.matrixWorld);
      ScratchC.fromBufferAttribute(Position, IC).applyMatrix4(Object.matrixWorld);
      ScratchAB.copy(ScratchB).sub(ScratchA);
      ScratchAC.copy(ScratchC).sub(ScratchA);
      ScratchNormal.crossVectors(ScratchAB, ScratchAC);

      const NormalLength = ScratchNormal.length();
      if (NormalLength <= 0.000001) continue;
      const HorizontalNormal = Math.hypot(ScratchNormal.x, ScratchNormal.z) / NormalLength;
      if (HorizontalNormal < 0.24) continue;

      const Triangle = {
        AX: ScratchA.x,
        AZ: ScratchA.z,
        BX: ScratchB.x,
        BZ: ScratchB.z,
        CX: ScratchC.x,
        CZ: ScratchC.z,
        MinX: Math.min(ScratchA.x, ScratchB.x, ScratchC.x),
        MaxX: Math.max(ScratchA.x, ScratchB.x, ScratchC.x),
        MinZ: Math.min(ScratchA.z, ScratchB.z, ScratchC.z),
        MaxZ: Math.max(ScratchA.z, ScratchB.z, ScratchC.z),
        MinY: Math.min(ScratchA.y, ScratchB.y, ScratchC.y),
        MaxY: Math.max(ScratchA.y, ScratchB.y, ScratchC.y)
      };

      if (Triangle.MaxY - Triangle.MinY < 0.025) continue;
      const NewIndex = Triangles.length;
      Triangles.push(Triangle);
      Bounds.expandByPoint(ScratchA);
      Bounds.expandByPoint(ScratchB);
      Bounds.expandByPoint(ScratchC);
      AddTriangleToGrid(Grid, Triangle, NewIndex);
    }
  });

  const Shape = { Triangles, Grid, Bounds };
  ShapeCache.set(Model, Shape);
  return Shape;
}

function DistanceSquaredToSegment(X, Z, AX, AZ, BX, BZ) {
  const DX = BX - AX;
  const DZ = BZ - AZ;
  const LengthSquared = DX * DX + DZ * DZ;
  if (LengthSquared <= 0.0000001) {
    const PX = X - AX;
    const PZ = Z - AZ;
    return PX * PX + PZ * PZ;
  }
  const T = THREE.MathUtils.clamp(((X - AX) * DX + (Z - AZ) * DZ) / LengthSquared, 0, 1);
  const PX = X - (AX + DX * T);
  const PZ = Z - (AZ + DZ * T);
  return PX * PX + PZ * PZ;
}

function PointInsideProjectedTriangle(X, Z, Triangle) {
  const AB = (Triangle.BX - Triangle.AX) * (Z - Triangle.AZ) - (Triangle.BZ - Triangle.AZ) * (X - Triangle.AX);
  const BC = (Triangle.CX - Triangle.BX) * (Z - Triangle.BZ) - (Triangle.CZ - Triangle.BZ) * (X - Triangle.BX);
  const CA = (Triangle.AX - Triangle.CX) * (Z - Triangle.CZ) - (Triangle.AZ - Triangle.CZ) * (X - Triangle.CX);
  const HasNegative = AB < -0.000001 || BC < -0.000001 || CA < -0.000001;
  const HasPositive = AB > 0.000001 || BC > 0.000001 || CA > 0.000001;
  return !(HasNegative && HasPositive);
}

function TriangleTouchesCircle(Position, RadiusSquared, FeetY, HeadY, Triangle) {
  if (Triangle.MaxY < FeetY || Triangle.MinY > HeadY) return false;
  const Radius = Math.sqrt(RadiusSquared);
  if (Position.x + Radius < Triangle.MinX || Position.x - Radius > Triangle.MaxX) return false;
  if (Position.z + Radius < Triangle.MinZ || Position.z - Radius > Triangle.MaxZ) return false;
  return PointInsideProjectedTriangle(Position.x, Position.z, Triangle) ||
    DistanceSquaredToSegment(Position.x, Position.z, Triangle.AX, Triangle.AZ, Triangle.BX, Triangle.BZ) <= RadiusSquared ||
    DistanceSquaredToSegment(Position.x, Position.z, Triangle.BX, Triangle.BZ, Triangle.CX, Triangle.CZ) <= RadiusSquared ||
    DistanceSquaredToSegment(Position.x, Position.z, Triangle.CX, Triangle.CZ, Triangle.AX, Triangle.AZ) <= RadiusSquared;
}

function ShapeTouchesPlayer(Position, Radius, Shape) {
  if (!Shape?.Triangles?.length || Shape.Bounds.isEmpty()) return false;
  const EffectiveRadius = THREE.MathUtils.clamp(Number(Radius) || 0.225, 0.19, 0.225);
  const RadiusSquared = EffectiveRadius * EffectiveRadius;
  const FeetY = Position.y - EyeHeight + 0.055;
  const HeadY = Position.y + 0.08;

  if (
    Position.x + EffectiveRadius < Shape.Bounds.min.x ||
    Position.x - EffectiveRadius > Shape.Bounds.max.x ||
    Position.z + EffectiveRadius < Shape.Bounds.min.z ||
    Position.z - EffectiveRadius > Shape.Bounds.max.z ||
    HeadY < Shape.Bounds.min.y ||
    FeetY > Shape.Bounds.max.y
  ) return false;

  const MinCellX = Math.floor((Position.x - EffectiveRadius) / CellSize);
  const MaxCellX = Math.floor((Position.x + EffectiveRadius) / CellSize);
  const MinCellZ = Math.floor((Position.z - EffectiveRadius) / CellSize);
  const MaxCellZ = Math.floor((Position.z + EffectiveRadius) / CellSize);
  const Seen = new Set();

  for (let X = MinCellX; X <= MaxCellX; X += 1) {
    for (let Z = MinCellZ; Z <= MaxCellZ; Z += 1) {
      for (const Index of Shape.Grid.get(CellKey(X, Z)) || []) {
        if (Seen.has(Index)) continue;
        Seen.add(Index);
        if (TriangleTouchesCircle(Position, RadiusSquared, FeetY, HeadY, Shape.Triangles[Index])) return true;
      }
    }
  }

  return false;
}

function PatchExactEntry(Entry) {
  if (!Entry?.CoreFixR87 || PatchedEntries.has(Entry)) return;
  const Model = Entry.CollisionObject;
  if (!Model?.isObject3D || IsNoCollisionNode(Model)) return;
  const Shape = BuildShape(Model);
  if (!Shape?.Triangles?.length || Shape.Bounds.isEmpty()) return;

  Entry.Box = Shape.Bounds.clone();
  Entry.OriginalBox = Shape.Bounds.clone();
  Entry.OriginalLegacyBox = Shape.Bounds.clone();
  Entry.TestPlayerCollision = (Position, Radius = 0.225) => ShapeTouchesPlayer(Position, Radius, Shape);
  Entry.TestCollision = (Position, Radius = 0.225) => ShapeTouchesPlayer(Position, Radius, Shape);
  Entry.VisibleCollisionR92 = true;
  PatchedEntries.add(Entry);
}

function PatchCollisionEntries(Game) {
  const Seen = new Set();
  const Patch = Entry => {
    if (!Entry || Seen.has(Entry)) return;
    Seen.add(Entry);
    PatchExactEntry(Entry);
  };
  for (const Entry of Game.CollisionBoxes || []) Patch(Entry);
  for (const Chunk of Game.ActiveChunks?.values?.() || []) for (const Entry of Chunk?.CollisionEntries || []) Patch(Entry);
  for (const Chunk of Game.PreparedChunks?.values?.() || []) for (const Entry of Chunk?.CollisionEntries || []) Patch(Entry);
}

function DistanceXZ(A, B) {
  return Math.hypot(A.x - B.x, A.z - B.z);
}

function UpdateDetailVisibility(Game) {
  const Camera = Game.Camera;
  if (!Camera?.isCamera) return;
  Camera.updateMatrixWorld();
  FrustumMatrix.multiplyMatrices(Camera.projectionMatrix, Camera.matrixWorldInverse);
  Frustum.setFromProjectionMatrix(FrustumMatrix);
  const FogFar = Number(Game.Scene?.fog?.far) || Number(Camera.far) || 150;
  const ChunkHideDistance = Math.max(92, Math.min(FogFar + 10, Number(Camera.far) - 4));

  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    if (!Chunk?.Group) continue;
    ChunkBox.set(
      new THREE.Vector3(-17.2, -0.2, Number(Chunk.BottomZ) - 0.2),
      new THREE.Vector3(17.2, 4.2, Number(Chunk.TopZ) + 0.2)
    );
    const CenterZ = (Number(Chunk.BottomZ) + Number(Chunk.TopZ)) * 0.5;
    ScratchWorld.set(0, Camera.position.y, CenterZ);
    const Distance = DistanceXZ(Camera.position, ScratchWorld);
    const InView = Frustum.intersectsBox(ChunkBox);
    Chunk.Group.visible = Distance <= ChunkHideDistance && (InView || Distance < 38);
  }

  Game.Scene?.traverse?.(Object => {
    if (!Object?.isObject3D || !Object.parent) return;
    const Data = Object.userData || {};
    const Name = String(Object.name || "");
    const IsPrice = Data.CompactPriceAuthorityR83 === true || /CompactPriceTag|FurniturePriceSign|FurnitureItemSign/i.test(Name);
    const IsStock = Data.ShelfStockR83 === true || /ShelfStock|OnlineSurfaceDecoration/i.test(Name);
    if (!IsPrice && !IsStock) return;
    Object.getWorldPosition(ScratchWorld);
    const Distance = DistanceXZ(Camera.position, ScratchWorld);
    const Limit = IsPrice ? 24 : 34;
    Object.visible = Distance <= Limit;
  });
}

function Install() {
  const Game = window.__STORE_GAME__;
  const Player = window.__STORE_PLAYER__;
  if (!Game?.Scene || !Game?.Camera || !Game?.CollisionBoxes || !Player) return false;

  MarkDecorations(Game);
  PurgeDecorationEntries(Game);
  PatchCollisionEntries(Game);
  UpdateDetailVisibility(Game);

  const BuildNode = document.getElementById("BuildVersion");
  if (BuildNode) BuildNode.textContent = "BUILD V0.35.62";
  window.__STORE_VERSION__ = "0.35.62";
  window.__STORE_VISIBLE_COLLISION_FIX_R92__ = {
    Build,
    Refresh() {
      MarkDecorations(Game);
      PurgeDecorationEntries(Game);
      PatchCollisionEntries(Game);
      UpdateDetailVisibility(Game);
    }
  };
  window.__STORE_VISIBLE_COLLISION_FIX_BUILD__ = Build;
  return true;
}

let Installed = false;
let LastDetailUpdate = 0;

function Tick(Now) {
  if (!Installed) Installed = Install();
  if (Installed) {
    const Game = window.__STORE_GAME__;
    if (Game && Now - LastDetailUpdate > 180) {
      LastDetailUpdate = Now;
      MarkDecorations(Game);
      PurgeDecorationEntries(Game);
      PatchCollisionEntries(Game);
      UpdateDetailVisibility(Game);
    }
  }
  requestAnimationFrame(Tick);
}

requestAnimationFrame(Tick);
