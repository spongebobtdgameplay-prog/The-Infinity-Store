import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.CollisionBoxes || !Game?.ActiveChunks || !Game?.PreparedChunks) {
  throw new Error("The Infinity Store must load before core collision authority.");
}

const SurfaceStep = window.__STORE_SURFACE_STEP_ANIMATION_R87__ || null;
const Engine = window.__STORE_ENGINE__ || null;
const EngineCollision = Engine?.Collision || null;
const EngineRender = Engine?.Render || null;
const ProcessedChunks = new WeakMap();
const RemovedGeometryNames = new Set(["Window_Large1"]);

function IsRugObject(Object) {
  const Name = String(Object?.name || "");
  return Boolean(
    Name.startsWith("CouchDisplayRugR84-") ||
    Name.startsWith("OnlineDisplayRugR75-") ||
    Name === "LargeShowroomRugR82" ||
    Object?.userData?.DecorationKind === "Rug" ||
    Object?.userData?.DecorationKind === "LargeShowroomRug" ||
    Object?.userData?.WalkableCarpetR87 === true
  );
}

function EntryBounds(Entry) {
  return Entry?.OriginalStructureBox || Entry?.OriginalBox || Entry?.Box || Entry || null;
}

function IsWalkableEntry(Entry) {
  if (!Entry) return false;
  const Type = String(Entry.Type || "");
  const Object = Entry.CollisionObject;
  if (/Rug|Carpet|FloorSurface|WalkableSurface/i.test(Type) || IsRugObject(Object)) return true;
  const Bounds = EntryBounds(Entry);
  if (!Bounds?.min || !Bounds?.max) return false;
  const Height = Bounds.max.y - Bounds.min.y;
  return Bounds.max.y <= 0.18 && Bounds.min.y <= 0.10 && Height <= 0.18;
}

function RemoveEntry(Chunk, Entry) {
  if (!Entry) return;
  Entry.Active = false;
  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    if (Game.CollisionBoxes[Index] === Entry) Game.CollisionBoxes.splice(Index, 1);
  }
  const LocalIndex = Chunk?.CollisionEntries?.indexOf?.(Entry) ?? -1;
  if (LocalIndex >= 0) Chunk.CollisionEntries.splice(LocalIndex, 1);
}

function PurgeLegacyCollision(Chunk) {
  for (const Entry of [...(Chunk.CollisionEntries || [])]) {
    const LegacyGenerated = Boolean(
      Entry?.SpawnCollisionR44 ||
      Entry?.CoreFixR87 ||
      Entry?.CoreFixR88 ||
      (Entry?.EngineCompoundR99 && !Entry?.EngineCompoundR100)
    );
    const DecorativeWindow = /Window_Large1/i.test(String(Entry?.Type || ""));
    if (LegacyGenerated || DecorativeWindow || IsWalkableEntry(Entry)) RemoveEntry(Chunk, Entry);
  }
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
  if (!Root?.traverse) return;
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

function FixRetailColors(Chunk) {
  for (const Object of Chunk.Group?.children || []) {
    if (!Object?.parent || IsRugObject(Object)) continue;
    const Name = String(Object.name || "");
    if (
      /Chair|Armchair|Shelf|Book|Box|Cart|Basket|Bag|Oven|Fridge|Sink|Couch|Sofa/i.test(Name) ||
      Object.userData?.RetailSellableR84
    ) FixDarkMaterials(Object);
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

function InstallEngineCollision(Chunk) {
  if (!EngineCollision?.EnsureChunkCollision) return 0;
  return EngineCollision.EnsureChunkCollision(
    Chunk,
    Game.CollisionBoxes,
    {
      EyeHeight: 1.68,
      MaximumPieces: 96,
      CollisionGridAxis: 4,
      CollisionCellPadding: 0.004
    }
  );
}

function ProcessInternal(Chunk, Force = false) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return 0;
  const Before = ChunkSignature(Chunk);
  if (!Force && ProcessedChunks.get(Chunk) === Before && Chunk.Group.userData?.CoreFixR100) return 0;

  RemoveDecorativeWindows(Chunk);
  PurgeLegacyCollision(Chunk);
  RegisterWalkableRugs(Chunk);
  FixRetailColors(Chunk);
  const Added = InstallEngineCollision(Chunk);

  Chunk.Group.userData.CoreFixR100 = true;
  Chunk.Group.userData.CoreFixR99 = true;
  Chunk.Group.userData.CoreFixR88 = true;
  Chunk.Group.userData.CoreFixR87 = true;
  Chunk.Group.userData.CoreFixR86 = true;
  Chunk.Group.userData.EngineCollisionCountR100 = Added;
  ProcessedChunks.set(Chunk, ChunkSignature(Chunk));
  return Added;
}

async function InstallEngineRenderBatch(Chunk) {
  if (!EngineRender?.OptimizeChunkStaticRender || !Chunk?.Group || Chunk.Cancelled) return null;
  return EngineRender.OptimizeChunkStaticRender(Chunk, {
    Yield: () => WaitForWorkSlice(4, 900)
  });
}

export async function ProcessChunkAsync(Chunk, Force = false) {
  const Added = ProcessInternal(Chunk, Force);
  await InstallEngineRenderBatch(Chunk);
  return Added;
}

export function ProcessChunk(Chunk, Force = false) {
  return ProcessInternal(Chunk, Force);
}

export function ProcessAll() {
  const Seen = new Set();
  for (const Chunk of Game.ActiveChunks.values()) {
    Seen.add(Chunk);
    ProcessInternal(Chunk);
  }
  for (const Chunk of Game.PreparedChunks.values()) {
    if (!Seen.has(Chunk)) ProcessInternal(Chunk);
  }
}

ProcessAll();

window.__STORE_CORE_FIX_R86__ = { ProcessAll, ProcessChunk, ProcessChunkAsync };
window.__STORE_CORE_FIX_R87__ = window.__STORE_CORE_FIX_R86__;
window.__STORE_CORE_FIX_BUILD__ = "V0.35.70-R100-ENGINE-COLLISION-RENDER";
