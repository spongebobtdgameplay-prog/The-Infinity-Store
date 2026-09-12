import * as THREE from "three";

const Build = "V0.35.63-R93-MESH-PART-COLLISION";
const ShapeCache = new WeakMap();
const PatchedEntries = new WeakSet();
const DetailRoots = new Set();
const EyeHeight = 1.68;
const ScratchLocal = new THREE.Vector3();
const ScratchWorld = new THREE.Vector3();
const ScratchScale = new THREE.Vector3();
const BathroomProfiles = new Map([
  ["Bathroom_Toilet", { Color: 0xc9c4ba, Roughness: 0.48, Metalness: 0.01 }],
  ["Bathroom_Bathtub", { Color: 0xc9c4ba, Roughness: 0.50, Metalness: 0.01 }],
  ["Bathroom_Sink", { Color: 0xc5c1b7, Roughness: 0.46, Metalness: 0.02 }]
]);

function IsDetailNode(Object) {
  let Current = Object;
  while (Current) {
    const Data = Current.userData || {};
    const Name = String(Current.name || "");
    if (
      Data.CompactPriceAuthorityR83 === true ||
      Data.ShelfStockR83 === true ||
      Data.WalkableCarpetR87 === true ||
      Data.DecorationKind === "Rug" ||
      Data.DecorationKind === "LargeShowroomRug" ||
      /CompactPriceTag|FurniturePriceSign|FurnitureItemSign|PricePlacard|Placard|ShelfStock|OnlineSurfaceDecoration|Rug|Carpet/i.test(Name)
    ) return true;
    Current = Current.parent || null;
  }
  return false;
}

function MarkDetailNoCollision(Object) {
  if (!Object?.isObject3D) return;
  DetailRoots.add(Object);
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
  for (const Object of Chunk.Group.children || []) {
    if (IsDetailNode(Object)) MarkDetailNoCollision(Object);
  }
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
  if (!Object?.isMesh || !Object.geometry) return false;
  if (IsDetailNode(Object)) return false;
  if (/Text|Label|Glow|Highlight|Selection|Outline/i.test(String(Object.name || ""))) return false;
  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  return !Materials.length || Materials.some(MaterialVisible);
}

function BuildShape(Model) {
  const Existing = ShapeCache.get(Model);
  if (Existing) return Existing;

  Model.updateWorldMatrix(true, true);
  const Pieces = [];
  const Bounds = new THREE.Box3().makeEmpty();

  Model.traverse(Object => {
    if (!MeshCanCollide(Object)) return;
    Object.geometry.computeBoundingBox?.();
    const LocalBox = Object.geometry.boundingBox?.clone?.();
    if (!LocalBox || LocalBox.isEmpty()) return;

    Object.updateWorldMatrix(true, false);
    const Inverse = Object.matrixWorld.clone().invert();
    Object.getWorldScale(ScratchScale);
    const Scale = ScratchScale.clone().set(
      Math.abs(ScratchScale.x),
      Math.abs(ScratchScale.y),
      Math.abs(ScratchScale.z)
    );
    const WorldBox = LocalBox.clone().applyMatrix4(Object.matrixWorld);
    if (WorldBox.isEmpty()) return;

    const Width = WorldBox.max.x - WorldBox.min.x;
    const Height = WorldBox.max.y - WorldBox.min.y;
    const Depth = WorldBox.max.z - WorldBox.min.z;
    if (Width < 0.008 && Height < 0.008 && Depth < 0.008) return;

    Pieces.push({ LocalBox, Inverse, Scale, WorldBox });
    Bounds.union(WorldBox);
  });

  const Shape = { Pieces: Pieces.slice(0, 72), Bounds };
  ShapeCache.set(Model, Shape);
  return Shape;
}

function PieceHitsPlayer(Position, Radius, Piece) {
  const FeetY = Position.y - EyeHeight + 0.035;
  const HeadY = Position.y + 0.08;
  if (Piece.WorldBox.max.y < FeetY || Piece.WorldBox.min.y > HeadY) return false;

  ScratchLocal.copy(Position).applyMatrix4(Piece.Inverse);
  const ClosestX = THREE.MathUtils.clamp(ScratchLocal.x, Piece.LocalBox.min.x, Piece.LocalBox.max.x);
  const ClosestZ = THREE.MathUtils.clamp(ScratchLocal.z, Piece.LocalBox.min.z, Piece.LocalBox.max.z);
  const DX = (ScratchLocal.x - ClosestX) * Math.max(Piece.Scale.x, 0.0001);
  const DZ = (ScratchLocal.z - ClosestZ) * Math.max(Piece.Scale.z, 0.0001);
  return DX * DX + DZ * DZ <= Radius * Radius;
}

function ShapeHitsPlayer(Position, Radius, Shape) {
  if (!Shape?.Pieces?.length || Shape.Bounds.isEmpty()) return false;
  const EffectiveRadius = THREE.MathUtils.clamp(Number(Radius) || 0.255, 0.20, 0.28);
  const FeetY = Position.y - EyeHeight + 0.035;
  const HeadY = Position.y + 0.08;

  if (
    Position.x + EffectiveRadius < Shape.Bounds.min.x ||
    Position.x - EffectiveRadius > Shape.Bounds.max.x ||
    Position.z + EffectiveRadius < Shape.Bounds.min.z ||
    Position.z - EffectiveRadius > Shape.Bounds.max.z ||
    HeadY < Shape.Bounds.min.y ||
    FeetY > Shape.Bounds.max.y
  ) return false;

  for (const Piece of Shape.Pieces) {
    if (PieceHitsPlayer(Position, EffectiveRadius, Piece)) return true;
  }
  return false;
}

function PatchExactEntry(Entry) {
  if (!Entry?.CoreFixR87 || PatchedEntries.has(Entry)) return;
  const Model = Entry.CollisionObject;
  if (!Model?.isObject3D || IsDetailNode(Model)) return;

  const Shape = BuildShape(Model);
  if (!Shape?.Pieces?.length || Shape.Bounds.isEmpty()) return;

  Entry.Box = Shape.Bounds.clone();
  Entry.OriginalBox = Shape.Bounds.clone();
  Entry.OriginalLegacyBox = Shape.Bounds.clone();
  Entry.TestPlayerCollision = (Position, Radius = 0.255) => ShapeHitsPlayer(Position, Radius, Shape);
  Entry.TestCollision = (Position, Radius = 0.255) => ShapeHitsPlayer(Position, Radius, Shape);
  Entry.VisibleCollisionR93 = true;
  Entry.Active = Entry.Active !== false;
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

function NormalizeAssetRoot(Root) {
  const Profile = BathroomProfiles.get(String(Root?.name || ""));
  if (!Profile || Root.userData?.VisibleAssetMaterialR93) return;
  Root.userData.VisibleAssetMaterialR93 = true;

  Root.traverse(Object => {
    if (!Object?.isMesh || !Object.material) return;
    const Source = Array.isArray(Object.material) ? Object.material : [Object.material];
    const Updated = Source.map(Material => {
      if (!Material || Material.map || !Material.color?.isColor) return Material;
      const Hex = Material.color.getHex(THREE.SRGBColorSpace);
      const Red = (Hex >> 16) & 255;
      const Green = (Hex >> 8) & 255;
      const Blue = Hex & 255;
      if (Math.min(Red, Green, Blue) < 215) return Material;
      const Clone = Material.clone();
      Clone.color.setHex(Profile.Color, THREE.SRGBColorSpace);
      if ("roughness" in Clone) Clone.roughness = Profile.Roughness;
      if ("metalness" in Clone) Clone.metalness = Profile.Metalness;
      Clone.needsUpdate = true;
      return Clone;
    });
    Object.material = Array.isArray(Object.material) ? Updated : Updated[0];
  });
}

function ScanAssets(Chunk) {
  for (const Model of Chunk?.Models || []) NormalizeAssetRoot(Model);
  for (const Object of Chunk?.Group?.children || []) NormalizeAssetRoot(Object);
}

function UpdateDetailVisibility(Game) {
  for (const Object of [...DetailRoots]) {
    if (!Object?.parent) {
      DetailRoots.delete(Object);
      continue;
    }
    Object.getWorldPosition(ScratchWorld);
    const Distance = Math.hypot(
      Game.Camera.position.x - ScratchWorld.x,
      Game.Camera.position.z - ScratchWorld.z
    );
    const IsPrice = Object.userData?.CompactPriceAuthorityR83 === true || /Price|Placard/i.test(String(Object.name || ""));
    Object.visible = Distance <= (IsPrice ? 26 : 38);
  }
}

function Install() {
  const Game = window.__STORE_GAME__;
  if (!Game?.Scene || !Game?.Camera || !Game?.CollisionBoxes) return false;

  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    ScanChunkDetails(Chunk);
    ScanAssets(Chunk);
  }
  for (const Chunk of Game.PreparedChunks?.values?.() || []) {
    ScanChunkDetails(Chunk);
    ScanAssets(Chunk);
  }

  PurgeDetailEntries(Game);
  PatchCollisionEntries(Game);
  UpdateDetailVisibility(Game);

  const BuildNode = document.getElementById("BuildVersion");
  if (BuildNode) BuildNode.textContent = "BUILD V0.35.63";
  window.__STORE_VISIBLE_COLLISION_FIX_BUILD__ = Build;
  return true;
}

let Attempts = 0;
const Start = setInterval(() => {
  Attempts += 1;
  if (Install() || Attempts > 100) clearInterval(Start);
}, 50);

setInterval(Install, 850);
addEventListener("store-world-buffer-progress", Install);
addEventListener("store-settings-change", Install);
