import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.CollisionBoxes) throw new Error("Game must load before generator integrity.");

const State = new WeakMap();
const TempCenter = new THREE.Vector3();
const SeamStructureNames = new Set([
  "Floor", "Ceiling", "WallLeft", "WallRight", "BaseboardLeft", "BaseboardRight"
]);

const ManagedNames = new Set([
  "Couch_Large1", "Couch_L", "Chair_2", "Table_RoundLarge", "Bed_King", "Bed_Single",
  "NightStand_2", "Shelf_Large", "Bookshelf", "Kitchen_Cabinet1", "Kitchen_Fridge",
  "Kitchen_Oven", "Kitchen_Sink", "Bathroom_Bathtub", "Bathroom_Toilet", "Light_Floor1",
  "RetailArmchairR79", "RetailLivingShelfR79", "RetailBedroomCabinetR79", "RetailBedroomChairR79",
  "RetailStorageShelfR79", "RetailStorageCabinetR79", "RetailDisplayCabinetR79"
]);

function BoundsOf(Object) {
  Object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(Object);
}

function ManagedRoots(Chunk) {
  const Roots = [];
  const Seen = new Set();
  for (const Model of Chunk.Models || []) {
    if (!Model?.parent || Seen.has(Model)) continue;
    if (!ManagedNames.has(Model.name) && !Model.userData?.LayoutSlot) continue;
    Seen.add(Model);
    Roots.push(Model);
  }
  for (const Object of Chunk.Group?.children || []) {
    if (!Object?.parent || Seen.has(Object)) continue;
    if (!ManagedNames.has(Object.name) && !Object.userData?.RetailSellableR84 && !Object.userData?.LayoutSlot) continue;
    if (/Rug|Partition|Header|Price|Task/i.test(String(Object.name || ""))) continue;
    Seen.add(Object);
    Roots.push(Object);
  }
  return Roots;
}

function SetBoxChunkDepth(Box, Chunk) {
  if (!Box?.min || !Box?.max) return;
  Box.min.z = Chunk.BottomZ;
  Box.max.z = Chunk.TopZ;
}

function NormalizeChunkSeams(Chunk) {
  if (!Chunk?.Group || Chunk.Group.userData?.SeamNormalizedR90) return;
  const TargetDepth = Math.max(0.001, Number(Chunk.TopZ) - Number(Chunk.BottomZ));

  for (const Name of SeamStructureNames) {
    const Object = Chunk.Group.getObjectByName?.(Name);
    if (!Object?.isMesh || !Object.geometry) continue;
    Object.geometry.computeBoundingBox?.();
    const LocalBounds = Object.geometry.boundingBox;
    if (!LocalBounds?.min || !LocalBounds?.max) continue;
    const LocalDepth = (LocalBounds.max.z - LocalBounds.min.z) * Math.abs(Number(Object.scale?.z) || 1);
    if (!Number.isFinite(LocalDepth) || LocalDepth <= 0.0001) continue;
    if (Math.abs(LocalDepth - TargetDepth) <= 0.001) continue;
    Object.scale.z *= TargetDepth / LocalDepth;
    Object.updateMatrix();
    Object.updateWorldMatrix(true, true);
    Object.geometry.computeBoundingSphere?.();
    Object.userData.SeamNormalizedR90 = true;
  }

  for (const Entry of Chunk.CollisionEntries || []) {
    if (!SeamStructureNames.has(String(Entry?.Type || ""))) continue;
    SetBoxChunkDepth(Entry.Box, Chunk);
    SetBoxChunkDepth(Entry.OriginalBox, Chunk);
    SetBoxChunkDepth(Entry.OriginalLegacyBox, Chunk);
    SetBoxChunkDepth(Entry.OriginalStructureBox, Chunk);
  }

  Chunk.Group.userData.SeamNormalizedR90 = true;
}

function ProtectVisualStreaming(Chunk) {
  let Changed = false;
  for (const Object of ManagedRoots(Chunk)) {
    if (!Object?.userData) continue;
    if (Object.userData.StreamAmbientR101 !== true) Changed = true;
    Object.userData.StreamAmbientR101 = true;
    Object.userData.ObjectStreamCulledR101 = false;
    Object.userData.ObjectStreamWasVisibleR101 = true;
    Object.visible = true;
  }

  for (const Object of Chunk.Group?.children || []) {
    if (!Object?.userData || Object.userData?.CompactPriceAuthorityR83) continue;
    if (!Object.userData?.LayoutSlot && !Object.userData?.RetailSellableR84) continue;
    if (Object.userData.StreamAmbientR101 !== true) Changed = true;
    Object.userData.StreamAmbientR101 = true;
    Object.userData.ObjectStreamCulledR101 = false;
    Object.userData.ObjectStreamWasVisibleR101 = true;
    Object.visible = true;
  }

  if (Changed) {
    delete Chunk.StreamableRootsR101;
    delete Chunk.StreamableRootsStampR101;
  }
}

function RemoveCollisionForObject(Chunk, Object) {
  for (let Index = Chunk.CollisionEntries.length - 1; Index >= 0; Index -= 1) {
    const Entry = Chunk.CollisionEntries[Index];
    if (Entry?.CollisionObject !== Object && Entry?.SourceModel !== Object && Entry?.LayoutSlot !== Object.userData?.LayoutSlot) continue;
    Entry.Active = false;
    const GlobalIndex = Game.CollisionBoxes.indexOf(Entry);
    if (GlobalIndex >= 0) Game.CollisionBoxes.splice(GlobalIndex, 1);
    Chunk.CollisionEntries.splice(Index, 1);
  }
}

function RemoveUnplannedObject(Chunk, Object, Reason) {
  console.warn(`Removed unplanned generated object ${Object.name} from ${Chunk.Id}: ${Reason}`);
  RemoveCollisionForObject(Chunk, Object);
  Object.parent?.remove(Object);
  const ModelIndex = Chunk.Models.indexOf(Object);
  if (ModelIndex >= 0) Chunk.Models.splice(ModelIndex, 1);
}

function TightenLegacyCollision(Chunk, Object) {
  const Slot = String(Object.userData?.LayoutSlot || "");
  if (!Slot) return;
  const Entry = (Chunk.CollisionEntries || []).find(Value =>
    Value?.LayoutSlot === Slot ||
    (Value?.Type === Object.name && !Value?.PreciseGeometry)
  );
  if (!Entry || Entry.PreciseGeometry || typeof Entry.TestPlayerCollision === "function") return;
  const Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return;
  const Center = Bounds.getCenter(TempCenter);
  const Size = Bounds.getSize(new THREE.Vector3());
  const HalfX = Math.max(0.10, Size.x * 0.485);
  const HalfZ = Math.max(0.10, Size.z * 0.485);
  const Box = new THREE.Box3(
    new THREE.Vector3(Center.x - HalfX, Math.max(0, Bounds.min.y), Center.z - HalfZ),
    new THREE.Vector3(Center.x + HalfX, Bounds.max.y, Center.z + HalfZ)
  );
  Entry.Box = Box;
  Entry.OriginalBox = Box.clone();
  Entry.OriginalLegacyBox = Box.clone();
  Entry.LayoutSlot = Slot;
  Entry.GeneratorExactR77 = true;
}

function ViolatesCentralAisle(Chunk, Object) {
  const Aisle = Chunk.Layout?.CenterAisle;
  if (!Aisle) return false;
  const Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return false;
  return Bounds.max.x > Aisle.MinX && Bounds.min.x < Aisle.MaxX &&
    Bounds.max.z > Aisle.MinZ && Bounds.min.z < Aisle.MaxZ;
}

function OverlapXZ(A, B, Padding = 0.04) {
  return A.max.x > B.min.x - Padding && A.min.x < B.max.x + Padding &&
    A.max.z > B.min.z - Padding && A.min.z < B.max.z + Padding;
}

function ViolatesStructure(Chunk, Bounds) {
  for (const Structure of Chunk.StructureBounds || []) {
    if (OverlapXZ(Bounds, Structure, 0.035)) return true;
  }
  return false;
}

function OutsideChunk(Chunk, Bounds) {
  return Bounds.min.x < -16.55 || Bounds.max.x > 16.55 ||
    Bounds.min.z < Chunk.BottomZ + 0.35 || Bounds.max.z > Chunk.TopZ - 0.35;
}

function ValidatePlannedObjects(Chunk) {
  const PlannedSlots = Chunk.Layout?.Slots || {};
  const Roots = [...ManagedRoots(Chunk)].sort((A, B) =>
    String(A.userData?.LayoutSlot || "").localeCompare(String(B.userData?.LayoutSlot || ""))
  );

  for (const Object of Roots) {
    const Slot = String(Object.userData?.LayoutSlot || "");
    if (!Slot || !PlannedSlots[Slot]) {
      RemoveUnplannedObject(Chunk, Object, "no authoritative layout slot");
      continue;
    }

    const Bounds = BoundsOf(Object);
    if (Bounds.isEmpty()) {
      RemoveUnplannedObject(Chunk, Object, "empty model bounds");
      continue;
    }
    if (ViolatesCentralAisle(Chunk, Object)) {
      RemoveUnplannedObject(Chunk, Object, "intrudes into protected central aisle");
      continue;
    }
    if (OutsideChunk(Chunk, Bounds)) {
      RemoveUnplannedObject(Chunk, Object, "extends outside the chunk display envelope");
      continue;
    }
    if (ViolatesStructure(Chunk, Bounds)) {
      RemoveUnplannedObject(Chunk, Object, "intersects a structural wall or partition");
      continue;
    }

    TightenLegacyCollision(Chunk, Object);
  }
}

function ChunkSignature(Chunk) {
  const Parts = [Chunk.Layout?.Template || "none"];
  for (const Object of ManagedRoots(Chunk)) {
    Parts.push(`${Object.userData?.LayoutSlot || "unplanned"}:${Object.position.x.toFixed(2)}:${Object.position.z.toFixed(2)}`);
  }
  return Parts.sort().join("|");
}

export function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group?.userData?.WorldPolishR72 || !Chunk.Layout) return;
  NormalizeChunkSeams(Chunk);
  ProtectVisualStreaming(Chunk);
  const Signature = ChunkSignature(Chunk);
  if (State.get(Chunk) === Signature) return;
  ValidatePlannedObjects(Chunk);
  ProtectVisualStreaming(Chunk);
  State.set(Chunk, ChunkSignature(Chunk));
  Chunk.Group.userData.GeneratorIntegrityR77 = true;
}

export function ProcessAll() {
  const Seen = new Set();
  for (const Chunk of Game.ActiveChunks.values()) {
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
  for (const Chunk of Game.PreparedChunks.values()) if (!Seen.has(Chunk)) ProcessChunk(Chunk);
}

ProcessAll();

window.__STORE_GENERATOR_INTEGRITY_R77__ = { ProcessAll, ProcessChunk };
window.__STORE_GENERATOR_INTEGRITY_BUILD__ = "V0.35.60-R90-SEAM-STREAM-GUARD";
