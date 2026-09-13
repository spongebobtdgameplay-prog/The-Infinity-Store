import * as THREE from "three";

const Build = "V0.35.70-R100-ENGINE";
const RequiredThreeRevision = "180";

if (!THREE?.Vector3 || !THREE?.BufferGeometry || !THREE?.BatchedMesh) {
  throw new Error("The Infinity Store engine requires Three.js r180 with BatchedMesh before boot.");
}
if (String(THREE.REVISION) !== RequiredThreeRevision) {
  throw new Error(`Unsupported Three.js revision ${THREE.REVISION}; expected ${RequiredThreeRevision}.`);
}

function Clamp(Value, Min, Max) {
  return Math.min(Max, Math.max(Min, Value));
}

function GaussianInfluence(DistanceSquared, Radius) {
  const SafeRadius = Math.max(0.0001, Number(Radius) || 0.0001);
  return Math.exp(-Math.max(0, DistanceSquared) / (2 * SafeRadius * SafeRadius));
}

function RingBulge(Depth, Influence, BulgeAmount) {
  const T = Clamp(Number(Influence) || 0, 0, 1);
  return 2 * (Number(Depth) || 0) * (Number(BulgeAmount) || 0) * T * (1 - T);
}

function IsWalkableSurface(Object) {
  const Data = Object?.userData || {};
  const Name = String(Object?.name || "");
  return Boolean(
    Data.WalkableCarpetR87 === true ||
    Data.DecorationKind === "Rug" ||
    Data.DecorationKind === "LargeShowroomRug" ||
    /Rug|Carpet|WalkableSurface/i.test(Name)
  );
}

function IsVisualHelper(Object) {
  const Data = Object?.userData || {};
  const Name = String(Object?.name || "");
  const GeometryType = String(Object?.geometry?.type || "");
  return Boolean(
    Data.NonPhysicalVisualR95 === true ||
    Data.IgnoreWorldCollisionR95 === true ||
    Data.RenderBatchR104 === true ||
    Data.EngineRenderBatchR100 === true ||
    /Text|Label|Glow|Highlight|Selection|Outline|Crosshair/i.test(Name) ||
    /TextGeometry/i.test(GeometryType)
  );
}

function IsPhysicalMesh(Object) {
  if (!Object?.isMesh || !Object.visible || !Object.geometry?.attributes?.position) return false;
  if (Object.userData?.ForceNoCollisionR95 === true) return false;
  if (IsVisualHelper(Object)) return false;

  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  if (Materials.length && Materials.every(Material => {
    if (!Material || Material.visible === false) return true;
    return Material.transparent === true && Number(Material.opacity) <= 0.05;
  })) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Engine-owned compound collision.
// R100 subdivides irregular meshes into occupied local-space cells. Runtime
// collision remains cheap OBB tests, but the boxes follow the actual projected
// mesh much more closely than one bounding box per mesh.
// ---------------------------------------------------------------------------

const CollisionScratch = {
  Local: new THREE.Vector3(),
  ClosestLocal: new THREE.Vector3(),
  ClosestWorld: new THREE.Vector3(),
  Delta: new THREE.Vector3(),
  LocalNormal: new THREE.Vector3(),
  WorldNormal: new THREE.Vector3(),
  Scale: new THREE.Vector3()
};
const GeometryCollisionCells = new WeakMap();

function CollisionCellCacheKey(Options = {}) {
  const Axis = Clamp(Math.trunc(Number(Options.CollisionGridAxis) || 4), 1, 4);
  const Padding = Math.max(0, Number(Options.CollisionCellPadding) || 0.004);
  return `${Axis}:${Padding.toFixed(5)}`;
}

function PointInTriangle2D(X, Z, AX, AZ, BX, BZ, CX, CZ) {
  const D1 = (X - BX) * (AZ - BZ) - (AX - BX) * (Z - BZ);
  const D2 = (X - CX) * (BZ - CZ) - (BX - CX) * (Z - CZ);
  const D3 = (X - AX) * (CZ - AZ) - (CX - AX) * (Z - AZ);
  const HasNegative = D1 < -1e-8 || D2 < -1e-8 || D3 < -1e-8;
  const HasPositive = D1 > 1e-8 || D2 > 1e-8 || D3 > 1e-8;
  return !(HasNegative && HasPositive);
}

function SegmentIntersectsSegment2D(AX, AZ, BX, BZ, CX, CZ, DX, DZ) {
  const R1X = BX - AX;
  const R1Z = BZ - AZ;
  const R2X = DX - CX;
  const R2Z = DZ - CZ;
  const Denominator = R1X * R2Z - R1Z * R2X;
  if (Math.abs(Denominator) <= 1e-10) return false;
  const QX = CX - AX;
  const QZ = CZ - AZ;
  const T = (QX * R2Z - QZ * R2X) / Denominator;
  const U = (QX * R1Z - QZ * R1X) / Denominator;
  return T >= -1e-8 && T <= 1 + 1e-8 && U >= -1e-8 && U <= 1 + 1e-8;
}

function TriangleIntersectsCell2D(AX, AZ, BX, BZ, CX, CZ, MinX, MaxX, MinZ, MaxZ) {
  const InRect = (X, Z) => X >= MinX && X <= MaxX && Z >= MinZ && Z <= MaxZ;
  if (InRect(AX, AZ) || InRect(BX, BZ) || InRect(CX, CZ)) return true;

  for (const [X, Z] of [[MinX, MinZ], [MaxX, MinZ], [MaxX, MaxZ], [MinX, MaxZ]]) {
    if (PointInTriangle2D(X, Z, AX, AZ, BX, BZ, CX, CZ)) return true;
  }

  const TriangleEdges = [[AX, AZ, BX, BZ], [BX, BZ, CX, CZ], [CX, CZ, AX, AZ]];
  const RectEdges = [
    [MinX, MinZ, MaxX, MinZ], [MaxX, MinZ, MaxX, MaxZ],
    [MaxX, MaxZ, MinX, MaxZ], [MinX, MaxZ, MinX, MinZ]
  ];
  for (const TriangleEdge of TriangleEdges) {
    for (const RectEdge of RectEdges) {
      if (SegmentIntersectsSegment2D(...TriangleEdge, ...RectEdge)) return true;
    }
  }
  return false;
}

function RootCollisionOwned(Chunk, Root) {
  const Name = String(Root?.name || "");
  for (const Entry of Chunk?.CollisionEntries || []) {
    if (!Entry) continue;
    if (
      Entry.CollisionObject === Root ||
      Entry.SourceModel === Root ||
      Entry.Model === Root
    ) return true;
    const Type = String(Entry.Type || "");
    if (Name && (Type === Name || Type.startsWith(`${Name}Exact`) || Type.startsWith(`${Name}MeshCollision`))) {
      return true;
    }
  }
  return false;
}

function GeometryCellBoxes(Geometry, Options = {}) {
  const CacheKey = CollisionCellCacheKey(Options);
  let GeometryCache = GeometryCollisionCells.get(Geometry);
  if (GeometryCache?.has(CacheKey)) return GeometryCache.get(CacheKey);
  if (!GeometryCache) {
    GeometryCache = new Map();
    GeometryCollisionCells.set(Geometry, GeometryCache);
  }

  if (!Geometry?.attributes?.position) return [];
  if (!Geometry.boundingBox) Geometry.computeBoundingBox?.();
  const Bounds = Geometry.boundingBox?.clone?.();
  if (!Bounds || Bounds.isEmpty()) return [];

  const Position = Geometry.attributes.position;
  const Size = Bounds.getSize(new THREE.Vector3());
  const Longest = Math.max(Size.x, Size.z);
  const RequestedAxisCells = Clamp(Math.trunc(Number(Options.CollisionGridAxis) || 4), 1, 4);
  const DenseEnough = Position.count >= 24 && Longest >= 0.34;
  const AxisCells = DenseEnough ? RequestedAxisCells : 1;
  const XCells = Size.x >= Math.max(0.18, Longest * 0.28) ? AxisCells : 1;
  const ZCells = Size.z >= Math.max(0.18, Longest * 0.28) ? AxisCells : 1;

  if (XCells === 1 && ZCells === 1) {
    const Single = [Bounds];
    GeometryCache.set(CacheKey, Single);
    return Single;
  }

  const Count = XCells * ZCells;
  const Occupied = new Uint8Array(Count);
  const MinY = new Float64Array(Count);
  const MaxY = new Float64Array(Count);
  MinY.fill(Infinity);
  MaxY.fill(-Infinity);

  const CellWidth = Math.max(Size.x / XCells, 0.0001);
  const CellDepth = Math.max(Size.z / ZCells, 0.0001);
  const Index = Geometry.index;
  const TriangleCount = Index
    ? Math.floor(Index.count / 3)
    : Math.floor(Position.count / 3);

  const CellX = Value => Clamp(
    Math.floor((Value - Bounds.min.x) / CellWidth),
    0,
    XCells - 1
  );
  const CellZ = Value => Clamp(
    Math.floor((Value - Bounds.min.z) / CellDepth),
    0,
    ZCells - 1
  );

  for (let Triangle = 0; Triangle < TriangleCount; Triangle += 1) {
    const Offset = Triangle * 3;
    const IA = Index ? Index.getX(Offset) : Offset;
    const IB = Index ? Index.getX(Offset + 1) : Offset + 1;
    const IC = Index ? Index.getX(Offset + 2) : Offset + 2;

    const AX = Position.getX(IA);
    const AY = Position.getY(IA);
    const AZ = Position.getZ(IA);
    const BX = Position.getX(IB);
    const BY = Position.getY(IB);
    const BZ = Position.getZ(IB);
    const CX = Position.getX(IC);
    const CY = Position.getY(IC);
    const CZ = Position.getZ(IC);

    const MinCellX = CellX(Math.min(AX, BX, CX));
    const MaxCellX = CellX(Math.max(AX, BX, CX));
    const MinCellZ = CellZ(Math.min(AZ, BZ, CZ));
    const MaxCellZ = CellZ(Math.max(AZ, BZ, CZ));
    const TriangleMinY = Math.min(AY, BY, CY);
    const TriangleMaxY = Math.max(AY, BY, CY);

    for (let Z = MinCellZ; Z <= MaxCellZ; Z += 1) {
      for (let X = MinCellX; X <= MaxCellX; X += 1) {
        const CellMinX = Bounds.min.x + X * CellWidth;
        const CellMaxX = X === XCells - 1 ? Bounds.max.x : CellMinX + CellWidth;
        const CellMinZ = Bounds.min.z + Z * CellDepth;
        const CellMaxZ = Z === ZCells - 1 ? Bounds.max.z : CellMinZ + CellDepth;
        if (!TriangleIntersectsCell2D(
          AX, AZ, BX, BZ, CX, CZ,
          CellMinX, CellMaxX, CellMinZ, CellMaxZ
        )) continue;

        const CellIndex = Z * XCells + X;
        Occupied[CellIndex] = 1;
        MinY[CellIndex] = Math.min(MinY[CellIndex], TriangleMinY);
        MaxY[CellIndex] = Math.max(MaxY[CellIndex], TriangleMaxY);
      }
    }
  }

  const Boxes = [];
  const Padding = Math.max(0, Number(Options.CollisionCellPadding) || 0.004);
  for (let Z = 0; Z < ZCells; Z += 1) {
    for (let X = 0; X < XCells; X += 1) {
      const CellIndex = Z * XCells + X;
      if (!Occupied[CellIndex]) continue;

      const MinX = Bounds.min.x + X * CellWidth;
      const MaxX = X === XCells - 1 ? Bounds.max.x : MinX + CellWidth;
      const MinZ = Bounds.min.z + Z * CellDepth;
      const MaxZ = Z === ZCells - 1 ? Bounds.max.z : MinZ + CellDepth;
      const CellMinY = Number.isFinite(MinY[CellIndex]) ? MinY[CellIndex] : Bounds.min.y;
      const CellMaxY = Number.isFinite(MaxY[CellIndex]) ? MaxY[CellIndex] : Bounds.max.y;

      Boxes.push(new THREE.Box3(
        new THREE.Vector3(
          Math.max(Bounds.min.x, MinX - Padding),
          Math.max(Bounds.min.y, CellMinY - Padding),
          Math.max(Bounds.min.z, MinZ - Padding)
        ),
        new THREE.Vector3(
          Math.min(Bounds.max.x, MaxX + Padding),
          Math.min(Bounds.max.y, CellMaxY + Padding),
          Math.min(Bounds.max.z, MaxZ + Padding)
        )
      ));
    }
  }

  const Result = Boxes.length ? Boxes : [Bounds];
  GeometryCache.set(CacheKey, Result);
  return Result;
}

function BuildCollisionPieces(Root, Options = {}) {
  if (!Root?.isObject3D) return [];
  const Pieces = [];
  const MaximumPieces = Clamp(Math.trunc(Number(Options.MaximumPieces) || 72), 1, 128);

  Root.updateWorldMatrix(true, true);
  Root.traverse(Object => {
    if (Pieces.length >= MaximumPieces || !IsPhysicalMesh(Object)) return;
    if (IsWalkableSurface(Object)) return;
    const Name = String(Object.name || "");
    if (/^(Floor|Ceiling)$/i.test(Name)) return;

    const LocalBoxes = GeometryCellBoxes(Object.geometry, Options);
    if (!LocalBoxes.length) return;

    Object.updateWorldMatrix(true, false);
    const MatrixWorld = Object.matrixWorld.clone();
    const Inverse = MatrixWorld.clone().invert();
    Object.getWorldScale(CollisionScratch.Scale);
    const Scale = CollisionScratch.Scale.clone().set(
      Math.max(0.0001, Math.abs(CollisionScratch.Scale.x)),
      Math.max(0.0001, Math.abs(CollisionScratch.Scale.y)),
      Math.max(0.0001, Math.abs(CollisionScratch.Scale.z))
    );

    for (const LocalBox of LocalBoxes) {
      if (Pieces.length >= MaximumPieces) break;
      const WorldBox = LocalBox.clone().applyMatrix4(MatrixWorld);
      if (WorldBox.isEmpty()) continue;
      Pieces.push({
        Object,
        LocalBox: LocalBox.clone(),
        MatrixWorld,
        Inverse,
        Scale,
        WorldBox
      });
    }
  });

  return Pieces;
}

function PieceVerticalOverlap(Position, Piece, EyeHeight = 1.68) {
  const FeetY = Position.y - EyeHeight;
  const HeadY = Position.y + 0.10;
  return Piece.WorldBox.max.y >= FeetY + 0.025 && Piece.WorldBox.min.y <= HeadY;
}

function PieceTouchesCircle(Position, Radius, Piece, EyeHeight = 1.68) {
  if (!PieceVerticalOverlap(Position, Piece, EyeHeight)) return false;
  const SafeRadius = Math.max(0.01, Number(Radius) || 0.01);
  const Box = Piece.WorldBox;
  if (
    Position.x + SafeRadius < Box.min.x ||
    Position.x - SafeRadius > Box.max.x ||
    Position.z + SafeRadius < Box.min.z ||
    Position.z - SafeRadius > Box.max.z
  ) return false;

  CollisionScratch.Local.copy(Position).applyMatrix4(Piece.Inverse);
  const LocalBox = Piece.LocalBox;
  const Inside =
    CollisionScratch.Local.x >= LocalBox.min.x &&
    CollisionScratch.Local.x <= LocalBox.max.x &&
    CollisionScratch.Local.z >= LocalBox.min.z &&
    CollisionScratch.Local.z <= LocalBox.max.z;
  if (Inside) return true;

  CollisionScratch.ClosestLocal.set(
    Clamp(CollisionScratch.Local.x, LocalBox.min.x, LocalBox.max.x),
    CollisionScratch.Local.y,
    Clamp(CollisionScratch.Local.z, LocalBox.min.z, LocalBox.max.z)
  );
  CollisionScratch.ClosestWorld
    .copy(CollisionScratch.ClosestLocal)
    .applyMatrix4(Piece.MatrixWorld);
  const DX = Position.x - CollisionScratch.ClosestWorld.x;
  const DZ = Position.z - CollisionScratch.ClosestWorld.z;
  return DX * DX + DZ * DZ <= SafeRadius * SafeRadius;
}

function CompoundTouchesCircle(Position, Radius, Pieces, EyeHeight = 1.68) {
  for (const Piece of Pieces || []) {
    if (PieceTouchesCircle(Position, Radius, Piece, EyeHeight)) return true;
  }
  return false;
}

function PieceContactNormal(Position, Radius, Motion, Piece, Target, EyeHeight = 1.68) {
  if (!PieceTouchesCircle(Position, Radius, Piece, EyeHeight)) return false;

  const LocalBox = Piece.LocalBox;
  CollisionScratch.Local.copy(Position).applyMatrix4(Piece.Inverse);
  const Inside =
    CollisionScratch.Local.x >= LocalBox.min.x &&
    CollisionScratch.Local.x <= LocalBox.max.x &&
    CollisionScratch.Local.z >= LocalBox.min.z &&
    CollisionScratch.Local.z <= LocalBox.max.z;

  if (!Inside) {
    CollisionScratch.ClosestLocal.set(
      Clamp(CollisionScratch.Local.x, LocalBox.min.x, LocalBox.max.x),
      CollisionScratch.Local.y,
      Clamp(CollisionScratch.Local.z, LocalBox.min.z, LocalBox.max.z)
    );
    CollisionScratch.ClosestWorld
      .copy(CollisionScratch.ClosestLocal)
      .applyMatrix4(Piece.MatrixWorld);
    Target.copy(Position).sub(CollisionScratch.ClosestWorld);
    Target.y = 0;
    if (Target.lengthSq() <= 0.000001) return false;
    Target.normalize();
  } else {
    const Left = (CollisionScratch.Local.x - LocalBox.min.x) * Piece.Scale.x;
    const Right = (LocalBox.max.x - CollisionScratch.Local.x) * Piece.Scale.x;
    const Back = (CollisionScratch.Local.z - LocalBox.min.z) * Piece.Scale.z;
    const Front = (LocalBox.max.z - CollisionScratch.Local.z) * Piece.Scale.z;
    const Minimum = Math.min(Left, Right, Back, Front);

    if (Minimum === Left) CollisionScratch.LocalNormal.set(-1, 0, 0);
    else if (Minimum === Right) CollisionScratch.LocalNormal.set(1, 0, 0);
    else if (Minimum === Back) CollisionScratch.LocalNormal.set(0, 0, -1);
    else CollisionScratch.LocalNormal.set(0, 0, 1);

    Target.copy(CollisionScratch.LocalNormal).transformDirection(Piece.MatrixWorld);
    Target.y = 0;
    if (Target.lengthSq() <= 0.000001) return false;
    Target.normalize();
  }

  if (Motion?.lengthSq?.() > 0.000001 && Motion.dot(Target) > 0) Target.negate();
  return true;
}

function CompoundContactNormal(Position, Radius, Motion, Pieces, Target = new THREE.Vector3(), EyeHeight = 1.68) {
  let BestScore = -Infinity;
  let Found = false;
  CollisionScratch.WorldNormal.set(0, 0, 0);

  for (const Piece of Pieces || []) {
    if (!PieceContactNormal(Position, Radius, Motion, Piece, CollisionScratch.Delta, EyeHeight)) continue;
    const Score = Motion?.lengthSq?.() > 0.000001 ? -Motion.dot(CollisionScratch.Delta) : 1;
    if (Score <= BestScore) continue;
    BestScore = Score;
    CollisionScratch.WorldNormal.copy(CollisionScratch.Delta);
    Found = true;
  }

  if (!Found) return false;
  Target.copy(CollisionScratch.WorldNormal);
  return true;
}

function BuildCompoundCollisionEntry(Root, ChunkId = "", Options = {}) {
  const Pieces = BuildCollisionPieces(Root, Options);
  if (!Pieces.length) return null;

  const Bounds = new THREE.Box3().makeEmpty();
  for (const Piece of Pieces) Bounds.union(Piece.WorldBox);
  if (Bounds.isEmpty()) return null;

  const EyeHeight = Math.max(1.0, Number(Options.EyeHeight) || 1.68);
  return {
    Box: Bounds.clone(),
    OriginalBox: Bounds.clone(),
    ChunkId: String(ChunkId || Root.userData?.ChunkId || ""),
    Type: `${String(Root.name || "PhysicalObject")}EngineCompoundR100`,
    Active: false,
    EngineCompoundR99: true,
    EngineCompoundR100: true,
    PreciseGeometry: true,
    CollisionObject: Root,
    CollisionPieces: Pieces,
    TestPlayerCollision(Position, Radius = 0.48) {
      return CompoundTouchesCircle(Position, Radius, Pieces, EyeHeight);
    },
    GetContactNormal(Position, Radius, Motion, Target = new THREE.Vector3()) {
      return CompoundContactNormal(Position, Radius, Motion, Pieces, Target, EyeHeight);
    }
  };
}

function EngineCollisionRoots(Chunk) {
  const Roots = [];
  const Seen = new Set();
  const Add = Root => {
    if (!Root?.isObject3D || Seen.has(Root) || !Root.parent) return;
    Seen.add(Root);
    Roots.push(Root);
  };

  for (const Model of Chunk?.Models || []) Add(Model);
  for (const Object of Chunk?.Group?.children || []) Add(Object);
  for (const Object of Chunk?.ExternalObjects || []) Add(Object);
  return Roots;
}

function EnsureChunkCollision(Chunk, GlobalCollisionBoxes = null, Options = {}) {
  if (!Chunk?.Group || Chunk.Cancelled) return 0;
  let Added = 0;

  for (const Root of EngineCollisionRoots(Chunk)) {
    if (RootCollisionOwned(Chunk, Root)) continue;
    if (Root.isLight || IsWalkableSurface(Root) || IsVisualHelper(Root)) continue;

    const Entry = BuildCompoundCollisionEntry(Root, Chunk.Id, Options);
    if (!Entry) continue;

    Entry.Active = Boolean(Chunk.Active);
    Chunk.CollisionEntries ||= [];
    Chunk.CollisionEntries.push(Entry);
    Root.userData ||= {};
    Root.userData.EngineCollisionR100 = true;

    if (
      Entry.Active &&
      Array.isArray(GlobalCollisionBoxes) &&
      !GlobalCollisionBoxes.includes(Entry)
    ) GlobalCollisionBoxes.push(Entry);

    Added += 1;
  }

  return Added;
}

// ---------------------------------------------------------------------------
// Engine-owned static render batching.
// THREE.BatchedMesh can combine different geometries that share one material.
// This is the important difference from the old game-side InstancedMesh pass,
// which only batched exact geometry UUID matches and left hundreds of draws.
// ---------------------------------------------------------------------------

const RenderScratch = {
  ChunkInverse: new THREE.Matrix4(),
  LocalMatrix: new THREE.Matrix4()
};

function RenderMaterialSignature(Material) {
  if (!Material || Array.isArray(Material)) return "";
  const TextureId = Texture => Texture?.uuid || "";
  return [
    Material.type,
    Material.color?.isColor ? Material.color.getHexString() : "",
    Material.emissive?.isColor ? Material.emissive.getHexString() : "",
    Number(Material.emissiveIntensity || 0).toFixed(3),
    Number(Material.roughness ?? -1).toFixed(3),
    Number(Material.metalness ?? -1).toFixed(3),
    Number(Material.opacity ?? 1).toFixed(3),
    Number(Material.alphaTest ?? 0).toFixed(3),
    Number(Material.side ?? 0),
    Number(Material.blending ?? 0),
    Material.depthTest === false ? 0 : 1,
    Material.depthWrite === false ? 0 : 1,
    Material.vertexColors === true ? 1 : 0,
    TextureId(Material.map),
    TextureId(Material.normalMap),
    TextureId(Material.roughnessMap),
    TextureId(Material.metalnessMap),
    TextureId(Material.emissiveMap),
    TextureId(Material.aoMap),
    TextureId(Material.lightMap)
  ].join(":");
}

function GeometryLayoutSignature(Geometry) {
  if (!Geometry?.attributes?.position) return "";
  const Attributes = Object.keys(Geometry.attributes).sort().map(Name => {
    const Attribute = Geometry.attributes[Name];
    return [
      Name,
      Attribute.itemSize,
      Attribute.normalized ? 1 : 0,
      Attribute.array?.constructor?.name || ""
    ].join("/");
  }).join(",");
  const Index = Geometry.index;
  return `${Index ? `I/${Index.array?.constructor?.name || ""}` : "N"}|${Attributes}`;
}

function CanEngineBatchMesh(Mesh) {
  if (!Mesh?.isMesh || Mesh.isBatchedMesh || Mesh.isInstancedMesh || Mesh.isSkinnedMesh) return false;
  if (!Mesh.visible || !Mesh.geometry?.attributes?.position || !Mesh.material) return false;
  if (Array.isArray(Mesh.material)) return false;
  if (Mesh.morphTargetInfluences?.length) return false;
  if (Mesh.material.transparent === true) return false;
  if (Mesh.userData?.NoRenderBatchR104 || Mesh.userData?.NoEngineBatchR100) return false;
  if (IsVisualHelper(Mesh)) return false;
  return true;
}

function EngineBatchRoots(Chunk) {
  const Roots = [];
  const Seen = new Set();
  const Add = Root => {
    if (!Root?.isObject3D || !Root.parent || Seen.has(Root)) return;
    if (Root.name === "StoreTask" || IsWalkableSurface(Root)) return;
    Seen.add(Root);
    Roots.push(Root);
  };

  for (const Model of Chunk?.Models || []) Add(Model);
  for (const Object of Chunk?.Group?.children || []) {
    if (
      Object?.userData?.RetailImportedR79 ||
      Object?.userData?.RetailSellableR84 ||
      Object?.userData?.ShelfStockR83
    ) Add(Object);
  }
  return Roots;
}

function DisposeBatchOnRemoval(Batch) {
  const Dispose = () => {
    Batch.removeEventListener("removed", Dispose);
    Batch.dispose?.();
  };
  Batch.addEventListener("removed", Dispose);
}

async function OptimizeChunkStaticRender(Chunk, Options = {}) {
  if (!Chunk?.Group || Chunk.Cancelled) return { Batches: 0, Sources: 0 };
  if (Chunk.Group.userData?.EngineStaticBatchedR100) {
    return {
      Batches: Number(Chunk.Group.userData.EngineStaticBatchCountR100) || 0,
      Sources: Number(Chunk.Group.userData.EngineStaticSourceCountR100) || 0
    };
  }

  const Yield = typeof Options.Yield === "function"
    ? Options.Yield
    : (() => Promise.resolve());
  const Roots = EngineBatchRoots(Chunk);
  if (!Roots.length) {
    Chunk.Group.userData.EngineStaticBatchedR100 = true;
    Chunk.Group.userData.StaticRenderBatchedR104 = true;
    return { Batches: 0, Sources: 0 };
  }

  Chunk.Group.updateWorldMatrix(true, true);
  RenderScratch.ChunkInverse.copy(Chunk.Group.matrixWorld).invert();
  const Groups = new Map();

  for (let RootIndex = 0; RootIndex < Roots.length; RootIndex += 1) {
    const Root = Roots[RootIndex];
    Root.updateWorldMatrix(true, true);
    Root.traverse(Mesh => {
      if (!CanEngineBatchMesh(Mesh)) return;
      const MaterialSignature = RenderMaterialSignature(Mesh.material);
      const LayoutSignature = GeometryLayoutSignature(Mesh.geometry);
      if (!MaterialSignature || !LayoutSignature) return;
      const Key = `${MaterialSignature}|${LayoutSignature}`;
      let Group = Groups.get(Key);
      if (!Group) {
        Group = { Material: Mesh.material, Meshes: [] };
        Groups.set(Key, Group);
      }
      Group.Meshes.push(Mesh);
    });

    if (RootIndex > 0 && RootIndex % 3 === 0) await Yield();
  }

  let BatchCount = 0;
  let SourceCount = 0;

  for (const Group of Groups.values()) {
    if (Group.Meshes.length < 2) continue;

    const UniqueGeometry = new Map();
    let MaxVertices = 0;
    let MaxIndices = 0;
    for (const Mesh of Group.Meshes) {
      const Geometry = Mesh.geometry;
      if (UniqueGeometry.has(Geometry.uuid)) continue;
      UniqueGeometry.set(Geometry.uuid, Geometry);
      MaxVertices += Geometry.attributes.position.count;
      MaxIndices += Geometry.index?.count || 0;
    }

    if (!MaxVertices) continue;

    let Batch = null;
    try {
      Batch = new THREE.BatchedMesh(
        Group.Meshes.length,
        MaxVertices,
        Math.max(1, MaxIndices),
        Group.Material
      );
      Batch.name = `EngineStaticBatchR100-${Chunk.Index}-${BatchCount}`;
      Batch.userData.ChunkId = Chunk.Id;
      Batch.userData.RenderBatchR104 = true;
      Batch.userData.EngineRenderBatchR100 = true;
      Batch.userData.DecorationNoCollision = true;
      Batch.castShadow = false;
      Batch.receiveShadow = false;
      Batch.frustumCulled = true;
      Batch.perObjectFrustumCulled = true;
      Batch.sortObjects = false;

      const GeometryIds = new Map();
      for (const [Uuid, Geometry] of UniqueGeometry) {
        GeometryIds.set(Uuid, Batch.addGeometry(Geometry));
      }

      const BatchedSources = [];
      for (const Mesh of Group.Meshes) {
        Mesh.updateWorldMatrix(true, false);
        RenderScratch.LocalMatrix.multiplyMatrices(
          RenderScratch.ChunkInverse,
          Mesh.matrixWorld
        );
        if (RenderScratch.LocalMatrix.determinant() < 0) continue;
        const GeometryId = GeometryIds.get(Mesh.geometry.uuid);
        if (!Number.isInteger(GeometryId)) continue;
        const InstanceId = Batch.addInstance(GeometryId);
        Batch.setMatrixAt(InstanceId, RenderScratch.LocalMatrix);
        BatchedSources.push(Mesh);
      }

      if (BatchedSources.length < 2) {
        Batch.dispose?.();
        continue;
      }

      Batch.computeBoundingBox?.();
      Batch.computeBoundingSphere?.();
      Batch.updateMatrix();
      Batch.matrixAutoUpdate = false;
      Chunk.Group.add(Batch);
      DisposeBatchOnRemoval(Batch);

      for (const Mesh of BatchedSources) {
        Mesh.visible = false;
        Mesh.userData.RenderBatchedSourceR104 = true;
        Mesh.userData.EngineBatchedSourceR100 = true;
        SourceCount += 1;
      }
      BatchCount += 1;
    } catch (Error) {
      Batch?.dispose?.();
      console.warn("Engine static batch skipped", Error);
    }

    if (BatchCount > 0 && BatchCount % 2 === 0) await Yield();
  }

  for (let RootIndex = 0; RootIndex < Roots.length; RootIndex += 1) {
    const Root = Roots[RootIndex];
    let VisiblePhysicalMesh = false;
    Root.traverse(Object => {
      if (!Object?.isObject3D) return;
      Object.updateMatrix();
      Object.matrixAutoUpdate = false;
      if (Object?.isMesh && Object.visible && !IsVisualHelper(Object)) {
        VisiblePhysicalMesh = true;
      }
    });
    if (!VisiblePhysicalMesh) {
      Root.userData.RenderBatchedSourceR104 = true;
      Root.userData.EngineBatchedSourceRootR100 = true;
    }
    if (RootIndex > 0 && RootIndex % 4 === 0) await Yield();
  }

  Chunk.Group.userData.EngineStaticBatchedR100 = true;
  Chunk.Group.userData.EngineStaticBatchCountR100 = BatchCount;
  Chunk.Group.userData.EngineStaticSourceCountR100 = SourceCount;
  // Compatibility flag: game.js's older UUID-only batching pass must not run.
  Chunk.Group.userData.StaticRenderBatchedR104 = true;
  Chunk.Group.userData.StaticRenderBatchCountR104 = BatchCount;
  Chunk.Group.userData.StaticRenderSourceMeshCountR104 = SourceCount;

  return { Batches: BatchCount, Sources: SourceCount };
}

class GroupedSpringDeformer {
  constructor(Mesh, Options = {}) {
    if (!Mesh?.isMesh || !Mesh.geometry?.attributes?.position) {
      throw new TypeError("GroupedSpringDeformer requires a THREE.Mesh with position geometry.");
    }

    this.Mesh = Mesh;
    this.Geometry = Mesh.geometry;
    this.Position = this.Geometry.attributes.position;
    this.VertexCount = this.Position.count;
    this.Options = {
      WeldPrecision: Math.max(100, Number(Options.WeldPrecision) || 10000),
      Radius: Math.max(0.001, Number(Options.Radius) || 0.65),
      BulgeAmount: Number.isFinite(Options.BulgeAmount) ? Options.BulgeAmount : 0.50,
      Stiffness: Math.max(0, Number(Options.Stiffness) || 260),
      DampingPressed: Math.max(0, Number(Options.DampingPressed) || 12),
      ReleaseStiffness: Math.max(0, Number(Options.ReleaseStiffness) || 1.5),
      ReleaseDamping: Math.max(0, Number(Options.ReleaseDamping) || 13),
      ReleaseSnapBack: Math.max(0, Number(Options.ReleaseSnapBack) || 1.8),
      InfluenceCutoff: Math.max(0, Number(Options.InfluenceCutoff) || 0.001),
      SleepThreshold: Math.max(0.00001, Number(Options.SleepThreshold) || 0.002),
      RecalculateNormals: Options.RecalculateNormals !== false,
      NormalUpdateEvery: Math.max(1, Math.floor(Number(Options.NormalUpdateEvery) || 2))
    };

    this.PressPoint = new THREE.Vector3();
    this.PressDirection = new THREE.Vector3(0, -1, 0);
    this.TempPoint = new THREE.Vector3();
    this.TempDirection = new THREE.Vector3();
    this.TempQuaternion = new THREE.Quaternion();
    this.Pressing = false;
    this.Depth = 0;
    this.Radius = this.Options.Radius;
    this.Sleeping = true;
    this.Frame = 0;
    this.BuildGroups();
  }

  BuildGroups() {
    if (!this.Geometry.attributes.normal) this.Geometry.computeVertexNormals();
    const Normal = this.Geometry.attributes.normal;
    const Precision = this.Options.WeldPrecision;
    const Lookup = new Map();
    const PositionSums = [];
    const NormalSums = [];
    const Counts = [];
    this.VertexGroup = new Int32Array(this.VertexCount);
    this.RestVertices = new Float32Array(this.VertexCount * 3);

    for (let Index = 0; Index < this.VertexCount; Index += 1) {
      const X = this.Position.getX(Index);
      const Y = this.Position.getY(Index);
      const Z = this.Position.getZ(Index);
      const NX = Normal?.getX(Index) || 0;
      const NY = Normal?.getY(Index) || 1;
      const NZ = Normal?.getZ(Index) || 0;
      const Offset = Index * 3;
      this.RestVertices[Offset] = X;
      this.RestVertices[Offset + 1] = Y;
      this.RestVertices[Offset + 2] = Z;

      const Key = `${Math.round(X * Precision)}:${Math.round(Y * Precision)}:${Math.round(Z * Precision)}`;
      let Group = Lookup.get(Key);
      if (Group === undefined) {
        Group = PositionSums.length / 3;
        Lookup.set(Key, Group);
        PositionSums.push(0, 0, 0);
        NormalSums.push(0, 0, 0);
        Counts.push(0);
      }

      this.VertexGroup[Index] = Group;
      const GroupOffset = Group * 3;
      PositionSums[GroupOffset] += X;
      PositionSums[GroupOffset + 1] += Y;
      PositionSums[GroupOffset + 2] += Z;
      NormalSums[GroupOffset] += NX;
      NormalSums[GroupOffset + 1] += NY;
      NormalSums[GroupOffset + 2] += NZ;
      Counts[Group] += 1;
    }

    this.GroupCount = Counts.length;
    this.GroupRest = new Float32Array(this.GroupCount * 3);
    this.GroupNormal = new Float32Array(this.GroupCount * 3);
    this.GroupDisplacement = new Float32Array(this.GroupCount * 3);
    this.GroupVelocity = new Float32Array(this.GroupCount * 3);

    for (let Group = 0; Group < this.GroupCount; Group += 1) {
      const Offset = Group * 3;
      const Count = Math.max(1, Counts[Group]);
      this.GroupRest[Offset] = PositionSums[Offset] / Count;
      this.GroupRest[Offset + 1] = PositionSums[Offset + 1] / Count;
      this.GroupRest[Offset + 2] = PositionSums[Offset + 2] / Count;
      let NX = NormalSums[Offset] / Count;
      let NY = NormalSums[Offset + 1] / Count;
      let NZ = NormalSums[Offset + 2] / Count;
      const Length = Math.hypot(NX, NY, NZ) || 1;
      this.GroupNormal[Offset] = NX / Length;
      this.GroupNormal[Offset + 1] = NY / Length;
      this.GroupNormal[Offset + 2] = NZ / Length;
    }
  }

  SetPressLocal(Point, InwardDirection, Depth, Radius = this.Options.Radius) {
    this.PressPoint.copy(Point);
    this.PressDirection.copy(InwardDirection);
    if (this.PressDirection.lengthSq() <= 0.0000001) this.PressDirection.set(0, -1, 0);
    else this.PressDirection.normalize();
    this.Depth = Math.max(0, Number(Depth) || 0);
    this.Radius = Math.max(0.001, Number(Radius) || this.Options.Radius);
    this.Pressing = this.Depth > 0;
    this.Sleeping = false;
    return this;
  }

  SetPressWorld(WorldPoint, WorldInwardDirection, Depth, Radius = this.Options.Radius) {
    this.Mesh.updateWorldMatrix(true, false);
    this.TempPoint.copy(WorldPoint);
    this.Mesh.worldToLocal(this.TempPoint);
    this.Mesh.getWorldQuaternion(this.TempQuaternion).invert();
    this.TempDirection.copy(WorldInwardDirection).applyQuaternion(this.TempQuaternion).normalize();
    return this.SetPressLocal(this.TempPoint, this.TempDirection, Depth, Radius);
  }

  Release() {
    if (!this.Pressing) return this;
    this.Pressing = false;
    const Radius = Math.max(0.001, this.Radius);
    const Snap = this.Options.ReleaseSnapBack;
    for (let Group = 0; Group < this.GroupCount; Group += 1) {
      const Offset = Group * 3;
      const DX = this.GroupRest[Offset] - this.PressPoint.x;
      const DY = this.GroupRest[Offset + 1] - this.PressPoint.y;
      const DZ = this.GroupRest[Offset + 2] - this.PressPoint.z;
      const Influence = GaussianInfluence(DX * DX + DY * DY + DZ * DZ, Radius);
      if (Influence < 0.01) continue;
      const Scale = Influence * Snap;
      this.GroupVelocity[Offset] -= this.GroupDisplacement[Offset] * Scale;
      this.GroupVelocity[Offset + 1] -= this.GroupDisplacement[Offset + 1] * Scale;
      this.GroupVelocity[Offset + 2] -= this.GroupDisplacement[Offset + 2] * Scale;
    }
    this.Sleeping = false;
    return this;
  }

  Step(Delta) {
    if (this.Sleeping) return false;
    const Dt = Math.min(Math.max(0, Number(Delta) || 0), 1 / 30);
    if (Dt <= 0) return false;

    const Radius = Math.max(0.001, this.Radius);
    const Depth = this.Pressing ? this.Depth : 0;
    const ThresholdSquared = this.Options.SleepThreshold * this.Options.SleepThreshold;
    let Moving = false;

    for (let Group = 0; Group < this.GroupCount; Group += 1) {
      const Offset = Group * 3;
      let Influence = 0;
      if (this.Pressing && Depth > 0) {
        const DX = this.GroupRest[Offset] - this.PressPoint.x;
        const DY = this.GroupRest[Offset + 1] - this.PressPoint.y;
        const DZ = this.GroupRest[Offset + 2] - this.PressPoint.z;
        Influence = GaussianInfluence(DX * DX + DY * DY + DZ * DZ, Radius);
        if (Influence <= this.Options.InfluenceCutoff) Influence = 0;
      }

      const PressAmount = Depth * Influence;
      const Bulge = RingBulge(Depth, Influence, this.Options.BulgeAmount);
      const TargetX = this.PressDirection.x * PressAmount + this.GroupNormal[Offset] * Bulge;
      const TargetY = this.PressDirection.y * PressAmount + this.GroupNormal[Offset + 1] * Bulge;
      const TargetZ = this.PressDirection.z * PressAmount + this.GroupNormal[Offset + 2] * Bulge;
      const Spring = THREE.MathUtils.lerp(this.Options.ReleaseStiffness, this.Options.Stiffness, Influence);
      const Damping = THREE.MathUtils.lerp(this.Options.ReleaseDamping, this.Options.DampingPressed, Influence);
      const DampingFactor = 1 / (1 + Dt * Damping);

      const VX = (this.GroupVelocity[Offset] + Dt * Spring * (TargetX - this.GroupDisplacement[Offset])) * DampingFactor;
      const VY = (this.GroupVelocity[Offset + 1] + Dt * Spring * (TargetY - this.GroupDisplacement[Offset + 1])) * DampingFactor;
      const VZ = (this.GroupVelocity[Offset + 2] + Dt * Spring * (TargetZ - this.GroupDisplacement[Offset + 2])) * DampingFactor;
      const X = this.GroupDisplacement[Offset] + Dt * VX;
      const Y = this.GroupDisplacement[Offset + 1] + Dt * VY;
      const Z = this.GroupDisplacement[Offset + 2] + Dt * VZ;

      this.GroupVelocity[Offset] = VX;
      this.GroupVelocity[Offset + 1] = VY;
      this.GroupVelocity[Offset + 2] = VZ;
      this.GroupDisplacement[Offset] = X;
      this.GroupDisplacement[Offset + 1] = Y;
      this.GroupDisplacement[Offset + 2] = Z;
      if (VX * VX + VY * VY + VZ * VZ > ThresholdSquared || X * X + Y * Y + Z * Z > ThresholdSquared) Moving = true;
    }

    this.Apply();
    if (!this.Pressing && !Moving) {
      this.GroupVelocity.fill(0);
      this.GroupDisplacement.fill(0);
      this.Apply();
      this.Sleeping = true;
    }
    return true;
  }

  Apply() {
    for (let Index = 0; Index < this.VertexCount; Index += 1) {
      const VertexOffset = Index * 3;
      const GroupOffset = this.VertexGroup[Index] * 3;
      this.Position.setXYZ(
        Index,
        this.RestVertices[VertexOffset] + this.GroupDisplacement[GroupOffset],
        this.RestVertices[VertexOffset + 1] + this.GroupDisplacement[GroupOffset + 1],
        this.RestVertices[VertexOffset + 2] + this.GroupDisplacement[GroupOffset + 2]
      );
    }
    this.Position.needsUpdate = true;
    this.Frame += 1;
    if (this.Options.RecalculateNormals && this.Frame % this.Options.NormalUpdateEvery === 0) this.Geometry.computeVertexNormals();
    this.Geometry.computeBoundingSphere();
  }

  Reset() {
    this.Pressing = false;
    this.Depth = 0;
    this.GroupVelocity.fill(0);
    this.GroupDisplacement.fill(0);
    this.Sleeping = true;
    this.Apply();
    return this;
  }
}

const Deformers = new Set();

function RegisterDeformer(Mesh, Options = {}) {
  const Existing = Mesh?.userData?.GroupedSpringDeformerR95;
  if (Existing instanceof GroupedSpringDeformer) return Existing;
  const Deformer = new GroupedSpringDeformer(Mesh, Options);
  Mesh.userData ||= {};
  Mesh.userData.GroupedSpringDeformerR95 = Deformer;
  Deformers.add(Deformer);
  return Deformer;
}

function UnregisterDeformer(Deformer) {
  if (!Deformer) return false;
  Deformers.delete(Deformer);
  if (Deformer.Mesh?.userData?.GroupedSpringDeformerR95 === Deformer) delete Deformer.Mesh.userData.GroupedSpringDeformerR95;
  return true;
}

function StepDeformers(Delta) {
  for (const Deformer of Deformers) {
    if (!Deformer?.Mesh?.parent) {
      UnregisterDeformer(Deformer);
      continue;
    }
    Deformer.Step(Delta);
  }
}

function AutoRegisterDeformables(Root) {
  const Added = [];
  Root?.traverse?.(Object => {
    if (!Object?.isMesh) return;
    const Data = Object.userData || {};
    if (Data.DeformableR95 !== true && Data.SquishyR95 !== true && Data.BendableR95 !== true) return;
    Added.push(RegisterDeformer(Object, Data.DeformationOptionsR95 || {}));
  });
  return Added;
}

const Engine = Object.freeze({
  Build,
  THREE,
  Math: Object.freeze({ GaussianInfluence, RingBulge }),
  CollisionPolicy: Object.freeze({ IsPhysicalMesh, IsVisualHelper, IsWalkableSurface }),
  Collision: Object.freeze({
    GeometryCellBoxes,
    BuildCollisionPieces,
    BuildCompoundCollisionEntry,
    EnsureChunkCollision,
    CompoundTouchesCircle,
    CompoundContactNormal
  }),
  Render: Object.freeze({
    OptimizeChunkStaticRender,
    RenderMaterialSignature,
    GeometryLayoutSignature
  }),
  Deformation: Object.freeze({
    GroupedSpringDeformer,
    RegisterDeformer,
    UnregisterDeformer,
    StepDeformers,
    AutoRegisterDeformables,
    Deformers
  })
});

window.__STORE_ENGINE__ = Engine;
window.__STORE_THREE__ = THREE;
window.__STORE_ENGINE_BUILD__ = Build;

export {
  THREE,
  Engine,
  GroupedSpringDeformer,
  GaussianInfluence,
  RingBulge,
  IsPhysicalMesh,
  IsVisualHelper,
  IsWalkableSurface,
  GeometryCellBoxes,
  BuildCollisionPieces,
  BuildCompoundCollisionEntry,
  EnsureChunkCollision,
  CompoundTouchesCircle,
  CompoundContactNormal,
  OptimizeChunkStaticRender,
  RegisterDeformer,
  UnregisterDeformer,
  StepDeformers,
  AutoRegisterDeformables
};
