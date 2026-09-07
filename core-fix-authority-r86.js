import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.Camera || !Game?.CollisionBoxes || !Game?.ActiveChunks || !Game?.PreparedChunks) {
  throw new Error("The Infinity Store must load before core collision authority.");
}

const SurfaceStep = window.__STORE_SURFACE_STEP_ANIMATION_R87__ || null;
const Physics = window.__STORE_PROCEDURAL_PHYSICS__ || null;
const PlayerEyeHeight = 1.68;
const CELL_SIZE = 0.58;
const MIN_TRIANGLE_AREA = 0.0007;
const MIN_HORIZONTAL_NORMAL = 0.08;

const FurnitureNames = new Set([
  "Couch_Large1", "Couch_L", "Chair_2", "Table_RoundLarge", "Bed_King", "Bed_Single",
  "NightStand_2", "Shelf_Large", "Bookshelf", "Kitchen_Cabinet1", "Kitchen_Fridge",
  "Kitchen_Oven", "Kitchen_Sink", "Bathroom_Sink", "Bathroom_Bathtub", "Bathroom_Toilet", "Light_Floor1"
]);
const RetailNames = new Set([
  "RetailArmchairR79", "RetailLivingShelfR79", "RetailBedroomCabinetR79", "RetailBedroomChairR79",
  "RetailStorageShelfR79", "RetailStorageCabinetR79", "RetailDisplayCabinetR79"
]);
const RemovedGeometryNames = new Set(["Window_Large1"]);
const ProcessedCollision = new WeakMap();
const ProcessedChunks = new WeakMap();
const ExactShapeCache = new Map();
const TempA = new THREE.Vector3();
const TempB = new THREE.Vector3();
const TempC = new THREE.Vector3();
const TempAB = new THREE.Vector3();
const TempAC = new THREE.Vector3();
const TempNormal = new THREE.Vector3();
const TempLocal = new THREE.Vector3();
const TempScale = new THREE.Vector3();

function BoundsOf(Object) {
  Object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(Object);
}

function EntryBounds(Entry) {
  return Entry?.OriginalStructureBox || Entry?.OriginalBox || Entry?.Box || Entry || null;
}

function IsStructureEntry(Entry) {
  return Boolean(Entry?.PrecisePlayerStructure || /Wall|Partition|Boundary|RearStore|Ceiling|Door/i.test(String(Entry?.Type || "")));
}

function IsRugObject(Object) {
  const Name = String(Object?.name || "");
  return Name.startsWith("CouchDisplayRugR84-") ||
    Name.startsWith("OnlineDisplayRugR75-") ||
    Name === "LargeShowroomRugR82" ||
    Object?.userData?.DecorationKind === "Rug" ||
    Object?.userData?.DecorationKind === "LargeShowroomRug" ||
    Object?.userData?.WalkableCarpetR87 === true;
}

function IsLowWalkableEntry(Entry) {
  if (!Entry || Entry.CoreFixR87 || IsStructureEntry(Entry)) return false;
  const Type = String(Entry.Type || "");
  const Object = Entry.CollisionObject;
  if (/Rug|Carpet|FloorSurface|WalkableSurface/i.test(Type) || IsRugObject(Object)) return true;
  const Box = EntryBounds(Entry);
  if (!Box?.min || !Box?.max) return false;
  const Height = Box.max.y - Box.min.y;
  return Box.max.y <= 0.18 && Box.min.y <= 0.10 && Height <= 0.18;
}

function IsManagedRoot(Object) {
  if (!Object?.isObject3D || IsRugObject(Object)) return false;
  const Name = String(Object.name || "");
  if (FurnitureNames.has(Name) || RetailNames.has(Name)) return true;
  if (Object.userData?.RetailSellableR84) return true;
  if (Object.userData?.ForceSolidCollisionR30 === true) return true;
  if (
    Name.startsWith("RetailCoffeeTableR84") ||
    Name.startsWith("RetailSideTableR84") ||
    Name.startsWith("RetailDiningTableR84") ||
    Name.startsWith("RetailBoxShelfR84") ||
    Name.startsWith("RetailFloorLampR84") ||
    Name.startsWith("RetailAccentCabinetR84")
  ) return true;
  return false;
}

function IsLegacyManagedEntry(Entry) {
  if (!Entry || Entry.CoreFixR87) return false;
  if (IsManagedRoot(Entry.CollisionObject) || IsManagedRoot(Entry.SourceModel) || IsManagedRoot(Entry.Model)) return true;
  const Type = String(Entry.Type || "");
  if (Type === "RetailFurnitureSolidR83") return true;
  for (const Name of FurnitureNames) {
    if (Type === Name || Type.startsWith(`${Name}MeshCollisionR86`) || Type.startsWith(`${Name}Exact`)) return true;
  }
  for (const Name of RetailNames) if (Type === Name || Type.startsWith(`${Name}Solid`)) return true;
  if (/^Retail(CoffeeTable|SideTable|DiningTable|BoxShelf|FloorLamp|AccentCabinet)R84.*Solid/i.test(Type)) return true;
  return false;
}

function RejectFutureCollision(Entry) {
  if (!Entry) return false;
  return IsLowWalkableEntry(Entry) || IsLegacyManagedEntry(Entry) || /Window_Large1/i.test(String(Entry.Type || ""));
}

if (!Game.CollisionBoxes.__CoreGuardR87) {
  const OriginalPush = Game.CollisionBoxes.push;
  Game.CollisionBoxes.push = function GuardedCollisionPush(...Entries) {
    const Allowed = Entries.filter(Entry => !RejectFutureCollision(Entry));
    return OriginalPush.apply(this, Allowed);
  };
  Object.defineProperty(Game.CollisionBoxes, "__CoreGuardR87", { value: true, configurable: false, enumerable: false });
}

function RemoveGlobalEntry(Chunk, Entry) {
  if (!Entry) return;
  Entry.Active = false;
  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    if (Game.CollisionBoxes[Index] === Entry) Game.CollisionBoxes.splice(Index, 1);
  }
  const LocalIndex = Chunk?.CollisionEntries?.indexOf?.(Entry) ?? -1;
  if (LocalIndex >= 0) Chunk.CollisionEntries.splice(LocalIndex, 1);
}

function PurgeGhostAndLegacyEntries(Chunk) {
  for (const Entry of [...(Chunk.CollisionEntries || [])]) {
    if (IsLowWalkableEntry(Entry) || IsLegacyManagedEntry(Entry) || /Window_Large1/i.test(String(Entry?.Type || ""))) RemoveGlobalEntry(Chunk, Entry);
  }
  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    const Entry = Game.CollisionBoxes[Index];
    if (Entry?.ChunkId !== Chunk.Id) continue;
    if (IsLowWalkableEntry(Entry) || IsLegacyManagedEntry(Entry) || /Window_Large1/i.test(String(Entry?.Type || ""))) Game.CollisionBoxes.splice(Index, 1);
  }
}

function PointInsideTriangle(X, Z, A, B, C) {
  const AB = (B.x - A.x) * (Z - A.y) - (B.y - A.y) * (X - A.x);
  const BC = (C.x - B.x) * (Z - B.y) - (C.y - B.y) * (X - B.x);
  const CA = (A.x - C.x) * (Z - C.y) - (A.y - C.y) * (X - C.x);
  const HasNegative = AB < -0.000001 || BC < -0.000001 || CA < -0.000001;
  const HasPositive = AB > 0.000001 || BC > 0.000001 || CA > 0.000001;
  return !(HasNegative && HasPositive);
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

function CircleHitsTriangle(X, Z, RadiusSquared, Triangle) {
  const A = Triangle.A;
  const B = Triangle.B;
  const C = Triangle.C;
  return PointInsideTriangle(X, Z, A, B, C) ||
    DistanceSquaredToSegment(X, Z, A, B) <= RadiusSquared ||
    DistanceSquaredToSegment(X, Z, B, C) <= RadiusSquared ||
    DistanceSquaredToSegment(X, Z, C, A) <= RadiusSquared;
}

function CellKey(X, Z) {
  return `${X}:${Z}`;
}

function AddTriangleToGrid(Grid, Triangle, Index) {
  const MinX = Math.floor(Math.min(Triangle.A.x, Triangle.B.x, Triangle.C.x) / CELL_SIZE);
  const MaxX = Math.floor(Math.max(Triangle.A.x, Triangle.B.x, Triangle.C.x) / CELL_SIZE);
  const MinZ = Math.floor(Math.min(Triangle.A.y, Triangle.B.y, Triangle.C.y) / CELL_SIZE);
  const MaxZ = Math.floor(Math.max(Triangle.A.y, Triangle.B.y, Triangle.C.y) / CELL_SIZE);
  for (let X = MinX; X <= MaxX; X += 1) {
    for (let Z = MinZ; Z <= MaxZ; Z += 1) {
      const Key = CellKey(X, Z);
      if (!Grid.has(Key)) Grid.set(Key, []);
      Grid.get(Key).push(Index);
    }
  }
}

function ExactShapeKey(Model) {
  Model.updateWorldMatrix(true, true);
  const E = Model.matrixWorld.elements;
  const GeometryIds = [];
  Model.traverse(Object => {
    if (!Object?.isMesh || !Object.visible || !Object.geometry?.attributes?.position) return;
    if (/Text|Label|Glow/i.test(String(Object.name || ""))) return;
    GeometryIds.push(Object.geometry.uuid);
  });
  return [
    String(Model.name || "Furniture").replace(/-\d+$/, ""),
    E[0].toFixed(4), E[1].toFixed(4), E[2].toFixed(4),
    E[4].toFixed(4), E[5].toFixed(4), E[6].toFixed(4),
    E[8].toFixed(4), E[9].toFixed(4), E[10].toFixed(4),
    GeometryIds.join(",")
  ].join("|");
}

function BuildExactFootprint(Model, Origin) {
  Model.updateWorldMatrix(true, true);
  const Triangles = [];
  const Grid = new Map();
  const Bounds2 = new THREE.Box2().makeEmpty();

  Model.traverse(Object => {
    if (!Object?.isMesh || !Object.visible || !Object.geometry?.attributes?.position) return;
    if (/Text|Label|Glow/i.test(String(Object.name || ""))) return;
    const Position = Object.geometry.attributes.position;
    const Index = Object.geometry.index;
    const TriangleCount = Index ? Math.floor(Index.count / 3) : Math.floor(Position.count / 3);

    for (let TriangleIndex = 0; TriangleIndex < TriangleCount; TriangleIndex += 1) {
      const Offset = TriangleIndex * 3;
      const IA = Index ? Index.getX(Offset) : Offset;
      const IB = Index ? Index.getX(Offset + 1) : Offset + 1;
      const IC = Index ? Index.getX(Offset + 2) : Offset + 2;
      TempA.fromBufferAttribute(Position, IA).applyMatrix4(Object.matrixWorld);
      TempB.fromBufferAttribute(Position, IB).applyMatrix4(Object.matrixWorld);
      TempC.fromBufferAttribute(Position, IC).applyMatrix4(Object.matrixWorld);
      TempAB.copy(TempB).sub(TempA);
      TempAC.copy(TempC).sub(TempA);
      TempNormal.crossVectors(TempAB, TempAC);
      const Length = TempNormal.length();
      if (Length <= 0.000001) continue;
      const HorizontalAmount = Math.abs(TempNormal.y / Length);
      if (HorizontalAmount < MIN_HORIZONTAL_NORMAL) continue;
      const Area = Math.abs((TempB.x - TempA.x) * (TempC.z - TempA.z) - (TempB.z - TempA.z) * (TempC.x - TempA.x)) * 0.5;
      if (Area < MIN_TRIANGLE_AREA) continue;

      const Triangle = {
        A: new THREE.Vector2(TempA.x - Origin.x, TempA.z - Origin.z),
        B: new THREE.Vector2(TempB.x - Origin.x, TempB.z - Origin.z),
        C: new THREE.Vector2(TempC.x - Origin.x, TempC.z - Origin.z)
      };
      const NewIndex = Triangles.length;
      Triangles.push(Triangle);
      Bounds2.expandByPoint(Triangle.A);
      Bounds2.expandByPoint(Triangle.B);
      Bounds2.expandByPoint(Triangle.C);
      AddTriangleToGrid(Grid, Triangle, NewIndex);
    }
  });

  return { Triangles, Grid, Bounds2 };
}

function GetExactFootprint(Model, Origin) {
  const Key = ExactShapeKey(Model);
  const Cached = ExactShapeCache.get(Key);
  if (Cached) return Cached;
  const Geometry = BuildExactFootprint(Model, Origin);
  ExactShapeCache.set(Key, Geometry);
  return Geometry;
}

function BuildOrientedFallback(Model) {
  const Pieces = [];
  Model.updateWorldMatrix(true, true);
  Model.traverse(Object => {
    if (!Object?.isMesh || !Object.visible || !Object.geometry) return;
    if (/Text|Label|Glow/i.test(String(Object.name || ""))) return;
    Object.geometry.computeBoundingBox?.();
    const LocalBox = Object.geometry.boundingBox?.clone?.();
    if (!LocalBox || LocalBox.isEmpty()) return;
    Object.updateWorldMatrix(true, false);
    const Inverse = Object.matrixWorld.clone().invert();
    Object.getWorldScale(TempScale);
    const Scale = TempScale.clone().set(Math.abs(TempScale.x), Math.abs(TempScale.y), Math.abs(TempScale.z));
    const WorldBox = new THREE.Box3().setFromObject(Object);
    if (WorldBox.isEmpty()) return;
    Pieces.push({ LocalBox, Inverse, Scale, WorldBox });
  });
  return Pieces.slice(0, 30);
}

function CircleHitsOrientedPiece(Position, Radius, Piece) {
  const FeetY = Position.y - PlayerEyeHeight;
  const HeadY = Position.y + 0.12;
  if (Piece.WorldBox.max.y < FeetY + 0.03 || Piece.WorldBox.min.y > HeadY) return false;
  TempLocal.copy(Position).applyMatrix4(Piece.Inverse);
  const ClosestX = THREE.MathUtils.clamp(TempLocal.x, Piece.LocalBox.min.x, Piece.LocalBox.max.x);
  const ClosestZ = THREE.MathUtils.clamp(TempLocal.z, Piece.LocalBox.min.z, Piece.LocalBox.max.z);
  const DX = (TempLocal.x - ClosestX) * Math.max(Piece.Scale.x, 0.0001);
  const DZ = (TempLocal.z - ClosestZ) * Math.max(Piece.Scale.z, 0.0001);
  return DX * DX + DZ * DZ <= Radius * Radius;
}

function CircleHitsExact(Position, Radius, Geometry, FallbackPieces, Origin, StableBox) {
  const FeetY = Position.y - PlayerEyeHeight;
  const HeadY = Position.y + 0.12;
  if (StableBox.max.y < FeetY + 0.03 || StableBox.min.y > HeadY) return false;
  if (
    Position.x + Radius < StableBox.min.x ||
    Position.x - Radius > StableBox.max.x ||
    Position.z + Radius < StableBox.min.z ||
    Position.z - Radius > StableBox.max.z
  ) return false;

  if (Geometry.Triangles.length) {
    const LocalX = Position.x - Origin.x;
    const LocalZ = Position.z - Origin.z;
    const Bounds = Geometry.Bounds2;
    if (LocalX + Radius < Bounds.min.x || LocalX - Radius > Bounds.max.x || LocalZ + Radius < Bounds.min.y || LocalZ - Radius > Bounds.max.y) return false;
    const MinCellX = Math.floor((LocalX - Radius) / CELL_SIZE);
    const MaxCellX = Math.floor((LocalX + Radius) / CELL_SIZE);
    const MinCellZ = Math.floor((LocalZ - Radius) / CELL_SIZE);
    const MaxCellZ = Math.floor((LocalZ + Radius) / CELL_SIZE);
    const RadiusSquared = Radius * Radius;
    const Seen = new Set();
    for (let X = MinCellX; X <= MaxCellX; X += 1) {
      for (let Z = MinCellZ; Z <= MaxCellZ; Z += 1) {
        for (const Index of Geometry.Grid.get(CellKey(X, Z)) || []) {
          if (Seen.has(Index)) continue;
          Seen.add(Index);
          if (CircleHitsTriangle(LocalX, LocalZ, RadiusSquared, Geometry.Triangles[Index])) return true;
        }
      }
    }
    return false;
  }

  for (const Piece of FallbackPieces) if (CircleHitsOrientedPiece(Position, Radius, Piece)) return true;
  return false;
}

function TargetSignature(Model) {
  Model.updateWorldMatrix(true, true);
  const E = Model.matrixWorld.elements;
  return `${E[0].toFixed(3)}:${E[2].toFixed(3)}:${E[5].toFixed(3)}:${E[8].toFixed(3)}:${E[10].toFixed(3)}:${E[12].toFixed(3)}:${E[13].toFixed(3)}:${E[14].toFixed(3)}:${Model.children.length}`;
}

function RemoveExistingCoreEntry(Chunk, Model) {
  for (const Entry of [...(Chunk.CollisionEntries || [])]) {
    if (
      Entry?.CollisionObject === Model &&
      (Entry.CoreFixR87 || Entry.SpawnCollisionR44)
    ) {
      RemoveGlobalEntry(Chunk, Entry);
    }
  }
}

function InstallExactCollision(Chunk, Model) {
  const Signature = TargetSignature(Model);
  const Existing = (Chunk.CollisionEntries || []).find(
    Entry => Entry?.CoreFixR87 && Entry.CollisionObject === Model
  );

  if (
    Existing &&
    ProcessedCollision.get(Model) === Signature
  ) {
    Existing.Active = Boolean(Chunk.Active);
    if (
      Chunk.Active &&
      !Game.CollisionBoxes.includes(Existing)
    ) {
      Game.CollisionBoxes.push(Existing);
    }
    return;
  }

  RemoveExistingCoreEntry(Chunk, Model);

  const Origin = new THREE.Vector3();
  Model.getWorldPosition(Origin);
  const Geometry = GetExactFootprint(Model, Origin);
  const FallbackPieces = Geometry.Triangles.length ? [] : BuildOrientedFallback(Model);
  const StableBox = BoundsOf(Model);

  const Entry = {
    Box: StableBox.clone(),
    OriginalBox: StableBox.clone(),
    OriginalLegacyBox: StableBox.clone(),
    ChunkId: Chunk.Id,
    Type: `${String(Model.name || "Furniture")}ExactMeshR87`,
    Active: Boolean(Chunk.Active),
    CoreFixR87: true,
    CoreFixR88: true,
    PreciseGeometry: true,
    LegacyCollisionDisabled: true,
    CollisionObject: Model,
    TestPlayerCollision(Position, Radius = 0.28) {
      return CircleHitsExact(Position, Radius, Geometry, FallbackPieces, Origin, StableBox);
    }
  };

  Chunk.CollisionEntries.push(Entry);
  if (Chunk.Active && !Game.CollisionBoxes.includes(Entry)) {
    Game.CollisionBoxes.push(Entry);
  }

  Model.userData.RayCollisionSolidR35 = true;
  Model.userData.LegacyMovementCollisionDisabledR35 = true;
  Model.traverse(Object => {
    if (!Object?.isMesh) return;
    Object.userData.RayCollisionSolidR35 = true;
  });

  ProcessedCollision.set(Model, Signature);
}

function MaterialHex(Material) {
  if (!Material?.color?.isColor) return null;
  return Material.color.getHex(THREE.SRGBColorSpace);
}

function IsHardToSee(Material) {
  const Hex = MaterialHex(Material);
  if (Hex === null) return false;
  const Red = (Hex >> 16) & 255;
  const Green = (Hex >> 8) & 255;
  const Blue = Hex & 255;
  return Math.max(Red, Green, Blue) <= 54 || (Red + Green + Blue) / 3 <= 42;
}

function ReplacementForName(Name) {
  if (/Chair|Armchair/i.test(Name)) return 0x87977f;
  if (/Shelf|Book|Box/i.test(Name)) return 0x958a77;
  if (/Cart/i.test(Name)) return 0x87928d;
  if (/Basket|Bag/i.test(Name)) return 0xa88f72;
  if (/Oven|Fridge|Sink|Light/i.test(Name)) return 0x8b9698;
  if (/Couch|Sofa/i.test(Name)) return 0x7e8f83;
  return 0x7b8580;
}

function FixDarkMaterials(Root) {
  const Replacement = ReplacementForName(String(Root.name || ""));
  Root.traverse(Object => {
    if (!Object?.isMesh || !Object.material) return;
    const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
    const Updated = Materials.map(Material => {
      if (!IsHardToSee(Material)) return Material;
      const Copy = Material.clone();
      Copy.color?.setHex(Copy.map ? 0xb8beb8 : Replacement, THREE.SRGBColorSpace);
      if ("roughness" in Copy) Copy.roughness = Math.max(0.54, Copy.roughness ?? 0.70);
      if (Copy.emissive?.isColor && Copy.emissiveIntensity > 0.01) {
        Copy.emissive.setHex(0x252c28, THREE.SRGBColorSpace);
        Copy.emissiveIntensity = Math.min(Copy.emissiveIntensity, 0.08);
      }
      Copy.needsUpdate = true;
      return Copy;
    });
    Object.material = Array.isArray(Object.material) ? Updated : Updated[0];
  });
}

function RemoveDecorativeWindows(Chunk) {
  const Removed = new Set();
  for (const Model of Chunk.Models || []) {
    if (!Model?.parent || !RemovedGeometryNames.has(String(Model.name || ""))) continue;
    Removed.add(Model);
    Model.parent.remove(Model);
  }
  if (Removed.size) Chunk.Models = (Chunk.Models || []).filter(Model => !Removed.has(Model));

  const RemoveObjects = [];
  Chunk.Group?.traverse?.(Object => {
    if (Object !== Chunk.Group && RemovedGeometryNames.has(String(Object?.name || ""))) RemoveObjects.push(Object);
  });
  for (const Object of RemoveObjects) Object.parent?.remove(Object);
}

function RegisterWalkableRugs(Chunk) {
  SurfaceStep?.UnregisterChunk?.(Chunk.Id);
  Chunk.Group?.traverse?.(Object => {
    if (!IsRugObject(Object) || !Object.visible) return;
    Object.userData.WalkableCarpetR87 = true;
    Object.userData.DecorationNoCollision = true;
    SurfaceStep?.RegisterRug?.(Object, Chunk.Id);
  });
}

function CollectManagedRoots(Chunk) {
  const Roots = [];
  const Seen = new Set();
  for (const Model of Chunk.Models || []) {
    if (!Model?.parent || !IsManagedRoot(Model) || Seen.has(Model)) continue;
    Seen.add(Model);
    Roots.push(Model);
  }
  for (const Object of Chunk.Group?.children || []) {
    if (!Object?.parent || !IsManagedRoot(Object) || Seen.has(Object)) continue;
    Seen.add(Object);
    Roots.push(Object);
  }
  return Roots;
}

function FixRetailZoneColors(Chunk) {
  for (const Object of Chunk.Group?.children || []) {
    const Name = String(Object?.name || "");
    if (!Object?.parent || IsRugObject(Object)) continue;
    if (Name.startsWith("ShoppingCartR82-") || Name.startsWith("ShoppingBasketR82-") || Name.startsWith("BagShelfR82-")) FixDarkMaterials(Object);
  }
}

function ChunkSignature(Chunk) {
  return [
    Chunk.Group?.children?.length || 0,
    Chunk.Models?.length || 0,
    Chunk.CollisionEntries?.length || 0,
    Chunk.Group?.userData?.RetailSaleDisplaysR84 ? 1 : 0,
    Chunk.Group?.userData?.RetailZonesR82 ? 1 : 0,
    Chunk.Group?.userData?.ShelfStockR83 ? 1 : 0
  ].join(":");
}

function CollisionBudgetYield() {
  return WaitForWorkSlice();
}

export async function ProcessChunkAsync(Chunk, Force = false) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return;

  const BeforeSignature = ChunkSignature(Chunk);
  if (
    !Force &&
    ProcessedChunks.get(Chunk) === BeforeSignature &&
    Chunk.Group.userData?.CoreFixR88
  ) return;

  RemoveDecorativeWindows(Chunk);
  PurgeGhostAndLegacyEntries(Chunk);
  RegisterWalkableRugs(Chunk);

  const Roots = CollectManagedRoots(Chunk);
  for (let Index = 0; Index < Roots.length; Index += 1) {
    const Root = Roots[Index];
    FixDarkMaterials(Root);
    InstallExactCollision(Chunk, Root);
    if (Index < Roots.length - 1) await CollisionBudgetYield();
  }

  FixRetailZoneColors(Chunk);
  Chunk.Group.userData.CoreFixR88 = true;
  Chunk.Group.userData.CoreFixR87 = true;
  Chunk.Group.userData.CoreFixR86 = true;
  ProcessedChunks.set(Chunk, ChunkSignature(Chunk));
}

export function ProcessChunk(Chunk, Force = false) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return;

  const BeforeSignature = ChunkSignature(Chunk);
  if (!Force && ProcessedChunks.get(Chunk) === BeforeSignature && Chunk.Group.userData?.CoreFixR88) return;

  RemoveDecorativeWindows(Chunk);
  PurgeGhostAndLegacyEntries(Chunk);
  RegisterWalkableRugs(Chunk);

  const Roots = CollectManagedRoots(Chunk);
  for (const Root of Roots) {
    FixDarkMaterials(Root);
    InstallExactCollision(Chunk, Root);
  }
  FixRetailZoneColors(Chunk);

  Chunk.Group.userData.CoreFixR88 = true;
  Chunk.Group.userData.CoreFixR87 = true;
  Chunk.Group.userData.CoreFixR86 = true;
  ProcessedChunks.set(Chunk, ChunkSignature(Chunk));
}

export function ProcessAll() {
  const Seen = new Set();
  for (const Chunk of Game.ActiveChunks.values()) {
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
  for (const Chunk of Game.PreparedChunks.values()) if (!Seen.has(Chunk)) ProcessChunk(Chunk);

  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    const Entry = Game.CollisionBoxes[Index];
    if (IsLowWalkableEntry(Entry) || IsLegacyManagedEntry(Entry) || /Window_Large1/i.test(String(Entry?.Type || ""))) Game.CollisionBoxes.splice(Index, 1);
  }
}

// Initial pass only. New chunks are processed explicitly by presentation-ready
// after their furniture/retail passes finish. Avoid rescanning every chunk every
// ~950 ms forever.
ProcessAll();

window.__STORE_CORE_FIX_R86__ = { ProcessAll, ProcessChunk, ProcessChunkAsync };
window.__STORE_CORE_FIX_R87__ = window.__STORE_CORE_FIX_R86__;
window.__STORE_CORE_FIX_BUILD__ = "V0.35.45-SPAWN-COLLISION-HANDOFF";
