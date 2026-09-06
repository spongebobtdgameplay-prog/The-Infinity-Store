import * as THREE from "three";
const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.CollisionBoxes) {
  throw new Error("The Infinity Store game must load before store finishing.");
}

const PartitionWork = new WeakSet();
const NoRearWallMarkerFlag = "NoRearWallR105";

function RemoveLegacyDisplayFrames(Chunk) {
  const Remove = [];
  Chunk.Group?.traverse?.(Object => {
    const Name = String(Object?.name || "");
    if (
      Object?.userData?.WallDecorationR76 ||
      Name.startsWith("OnlineWallDecorationR76-PartitionR80-") ||
      Name.startsWith("OnlineWallDecorationR76-RearR80-")
    ) Remove.push(Object);
  });
  for (const Object of Remove) Object.parent?.remove(Object);
}

function RemoveRearClosure(Chunk) {
  if (!Chunk?.Group) return;

  const Remove = [];
  Chunk.Group.traverse?.(Object => {
    const Name = String(Object?.name || "");
    const IsNoRearWallMarker = Object?.userData?.[NoRearWallMarkerFlag] === true;
    if (
      (Name === "RearStoreClosureR80" && !IsNoRearWallMarker) ||
      Name === "RearStoreWallR80" ||
      Name === "RearStoreBaseboardR80" ||
      Object?.userData?.RearStoreWallR80 === true
    ) Remove.push(Object);
  });

  for (const Object of Remove) Object.parent?.remove(Object);

  const RemovedEntries = new Set(
    (Chunk.CollisionEntries || []).filter(Entry => Entry?.Type === "RearStoreWallR80")
  );

  Chunk.CollisionEntries = (Chunk.CollisionEntries || []).filter(Entry => Entry?.Type !== "RearStoreWallR80");

  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    const Entry = Game.CollisionBoxes[Index];
    if (RemovedEntries.has(Entry) || Entry?.Type === "RearStoreWallR80") Game.CollisionBoxes.splice(Index, 1);
  }

  if (Array.isArray(Chunk.StructureBounds)) {
    Chunk.StructureBounds = Chunk.StructureBounds.filter(Box => Box?.userData?.RearStoreWallR80 !== true);
  }
}

function EnsureNoRearWallMarker(Chunk) {
  if (!Chunk?.Group) return false;

  let Marker = Chunk.Group.getObjectByName("RearStoreClosureR80");
  if (Marker?.userData?.[NoRearWallMarkerFlag] === true) return true;

  if (Marker) Marker.parent?.remove(Marker);

  Marker = new THREE.Group();
  Marker.name = "RearStoreClosureR80";
  Marker.userData.ChunkId = Chunk.Id;
  Marker.userData[NoRearWallMarkerFlag] = true;
  Marker.userData.VisibleRearWall = false;
  Chunk.Group.add(Marker);
  return true;
}

function BrightPartitionMaterial(Material, Color) {
  if (!Material?.clone) return Material;
  const Copy = Material.clone();
  Copy.color?.setHex(Color, THREE.SRGBColorSpace);
  if ("roughness" in Copy) Copy.roughness = Math.max(0.72, Copy.roughness ?? 0.82);
  if ("metalness" in Copy) Copy.metalness = Math.min(0.18, Copy.metalness ?? 0.05);
  Copy.needsUpdate = true;
  return Copy;
}

async function FinishPartitions(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || PartitionWork.has(Chunk) || Chunk.Group.userData?.PresentationReadyR83) return;
  PartitionWork.add(Chunk);
  try {
    RemoveLegacyDisplayFrames(Chunk);
    RemoveRearClosure(Chunk);
    const Partitions = [];
    Chunk.Group?.traverse?.(Object => {
      if (Object?.name === "ShowroomPartition" && Object.isMesh) Partitions.push(Object);
      else if ((Object?.name === "PartitionCap" || Object?.name === "PartitionBase") && Object.isMesh && !Object.userData?.FinishColorR83) {
        Object.material = BrightPartitionMaterial(Object.material, 0x8f877a);
        Object.userData.FinishColorR83 = true;
      }
    });

    for (let Index = 0; Index < Partitions.length; Index += 1) {
      const Partition = Partitions[Index];
      if (!Partition.userData?.FinishColorR83) {
        Partition.material = BrightPartitionMaterial(Partition.material, 0xc4beb2);
        Partition.userData.FinishColorR83 = true;
      }
      Partition.userData.MerchandisingWallR80 = true;
    }
  } finally {
    PartitionWork.delete(Chunk);
  }
}

async function EnsureRearClosure() {
  for (const Chunk of Game.ActiveChunks.values()) RemoveRearClosure(Chunk);
  for (const Chunk of Game.PreparedChunks.values()) RemoveRearClosure(Chunk);

  const FirstChunk = Game.ActiveChunks.get(0) || [...Game.PreparedChunks.values()].find(Chunk => Chunk?.Index === 0);
  if (!FirstChunk?.Ready || !FirstChunk.Group) return false;
  return EnsureNoRearWallMarker(FirstChunk);
}

async function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || Chunk.Group.userData?.PresentationReadyR83) return;
  RemoveLegacyDisplayFrames(Chunk);
  RemoveRearClosure(Chunk);
  await FinishPartitions(Chunk);
}

async function ProcessAll() {
  for (const Chunk of Game.ActiveChunks.values()) await ProcessChunk(Chunk);
  for (const Chunk of Game.PreparedChunks.values()) await ProcessChunk(Chunk);
  await EnsureRearClosure();
}

ProcessAll().catch(Error => console.warn("Initial store finish failed", Error));

window.__STORE_FINISH_R80__ = { ProcessAll, ProcessChunk, EnsureRearClosure, RemoveRearClosure };
window.__STORE_FINISH_BUILD__ = "V0.35.58-NO-REAR-WALL-BOOT-COMPAT";