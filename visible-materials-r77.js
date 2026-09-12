import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.ActiveChunks || !Game?.PreparedChunks) throw new Error("Game must load before visible material correction.");

const Processed = new WeakMap();
const KnownAssetRoots = new Set([
  "Kitchen_Fridge",
  "Kitchen_Oven",
  "Kitchen_Sink",
  "Bathroom_Sink",
  "Bathroom_Bathtub",
  "Bathroom_Toilet",
  "Light_Floor1",
  "Door_3",
  "Shelf_Large",
  "Bookshelf"
]);

const ExactReplacements = new Map([
  [0x171a18, 0x687268],
  [0x232722, 0x667266],
  [0x171b1a, 0x626b68],
  [0x292a26, 0x746f63],
  [0x242628, 0x7f8986],
  [0x2f2c28, 0x71695f],
  [0x323a3b, 0x667472],
  [0x282d30, 0x68757a]
]);

function SrgbHex(Material) {
  if (!Material?.color?.isColor) return null;
  return Material.color.getHex(THREE.SRGBColorSpace);
}

function Channels(Hex) {
  return {
    Red: (Hex >> 16) & 255,
    Green: (Hex >> 8) & 255,
    Blue: Hex & 255
  };
}

function IsTrueNearBlack(Hex) {
  if (!Number.isInteger(Hex)) return false;
  const { Red, Green, Blue } = Channels(Hex);
  return Math.max(Red, Green, Blue) <= 28;
}

function IsGeneratedCanvasTexture(Texture) {
  return Boolean(Texture?.isCanvasTexture);
}

function FindNamedRoot(Object) {
  let Current = Object;
  while (Current && Current !== Game.Scene) {
    if (KnownAssetRoots.has(String(Current.name || ""))) return Current;
    Current = Current.parent;
  }
  return null;
}

function FindImportedRetailRoot(Object) {
  let Current = Object;
  while (Current && Current !== Game.Scene) {
    const Name = String(Current.name || "");
    if (
      Current.userData?.RetailImportedR79 ||
      Current.userData?.RetailImportedR84 ||
      Current.userData?.RetailSellableR84 ||
      /^Retail(?:Imported-|Armchair|LivingShelf|Bedroom|Storage|Display|CoffeeTable|SideTable|DiningTable|BoxShelf|FloorLamp|AccentCabinet)/i.test(Name)
    ) return Current;
    Current = Current.parent;
  }
  return null;
}

function IsHandleLike(Object, Material) {
  const Name = `${String(Object?.name || "")} ${String(Material?.name || "")}`;
  return /handle|hinge|trim|rail|grip/i.test(Name);
}

function CleanSyntheticMaps(Clone) {
  for (const Key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
    if (IsGeneratedCanvasTexture(Clone?.[Key])) Clone[Key] = null;
  }
}

function AssetProfile(RootName, Object, Material) {
  if (RootName === "Kitchen_Fridge") {
    if (IsHandleLike(Object, Material)) return { Color: 0x474d4d, Roughness: 0.40, Metalness: 0.58 };
    return { Color: 0xe7e3d9, Roughness: 0.50, Metalness: 0.14 };
  }
  if (RootName === "Kitchen_Oven") return { Color: 0x555c5d, Roughness: 0.44, Metalness: 0.58 };
  if (RootName === "Kitchen_Sink" || RootName === "Bathroom_Sink") return { Color: 0xd1d6d3, Roughness: 0.40, Metalness: 0.52 };
  if (RootName === "Bathroom_Bathtub" || RootName === "Bathroom_Toilet") return { Color: 0xeee9df, Roughness: 0.46, Metalness: 0.02 };
  if (RootName === "Light_Floor1") return { Color: 0x777e7d, Roughness: 0.52, Metalness: 0.42 };
  if (RootName === "Door_3") return { Color: 0x8d684f, Roughness: 0.72, Metalness: 0.02 };
  if (RootName === "Shelf_Large" || RootName === "Bookshelf") return { Color: 0x9da5a1, Roughness: 0.62, Metalness: 0.24 };
  return null;
}

function CorrectNamedAssetMaterial(Object, Material, Root) {
  if (!Material) return Material;
  const RootName = String(Root?.name || "");
  const Profile = AssetProfile(RootName, Object, Material);
  if (!Profile) return Material;

  const HasSyntheticMap = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"].some(Key => IsGeneratedCanvasTexture(Material[Key]));
  const Hex = SrgbHex(Material);
  const NeedsColorRepair = Hex !== null && IsTrueNearBlack(Hex);
  if (!HasSyntheticMap && !NeedsColorRepair && RootName !== "Kitchen_Fridge") return Material;

  const Clone = Material.clone();
  CleanSyntheticMaps(Clone);

  if (!Clone.map || RootName === "Kitchen_Fridge") Clone.color?.setHex(Profile.Color, THREE.SRGBColorSpace);
  else if (NeedsColorRepair) Clone.color?.setHex(0xb9beb9, THREE.SRGBColorSpace);

  if ("roughness" in Clone) Clone.roughness = Profile.Roughness;
  if ("metalness" in Clone) Clone.metalness = Profile.Metalness;
  if (Clone.emissive?.isColor && Clone.emissiveIntensity > 0.01) {
    Clone.emissive.setHex(0x000000, THREE.SRGBColorSpace);
    Clone.emissiveIntensity = 0;
  }
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectImportedMaterial(Material) {
  if (!Material) return Material;
  const Hex = SrgbHex(Material);
  if (Hex === null || !IsTrueNearBlack(Hex)) return Material;
  const Clone = Material.clone();
  Clone.color?.setHex(0x858d89, THREE.SRGBColorSpace);
  if ("roughness" in Clone) Clone.roughness = Math.max(0.58, Number(Clone.roughness) || 0);
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectGenericNearBlack(Material) {
  const Hex = SrgbHex(Material);
  if (Hex === null) return Material;
  const Replacement = ExactReplacements.get(Hex) ?? (IsTrueNearBlack(Hex) ? 0x6c7371 : null);
  if (Replacement === null) return Material;
  const Clone = Material.clone();
  Clone.color.setHex(Replacement, THREE.SRGBColorSpace);
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectMaterial(Object, Material) {
  const Root = FindNamedRoot(Object);
  if (Root) return CorrectNamedAssetMaterial(Object, Material, Root);
  if (FindImportedRetailRoot(Object)) return CorrectImportedMaterial(Material);
  return CorrectGenericNearBlack(Material);
}

function MaterialSignature(Material) {
  if (!Material) return "";
  return `${Material.uuid || ""}:${SrgbHex(Material) ?? ""}:${Material.map?.uuid || ""}:${Material.normalMap?.uuid || ""}:${Material.roughnessMap?.uuid || ""}:${Material.metalnessMap?.uuid || ""}`;
}

function ProcessMesh(Object) {
  if (!Object?.isMesh || !Object.material) return;
  const Current = Object.material;
  const Signature = Array.isArray(Current)
    ? Current.map(MaterialSignature).join("|")
    : MaterialSignature(Current);
  if (Processed.get(Object) === Signature) return;

  if (Array.isArray(Current)) Object.material = Current.map(Material => CorrectMaterial(Object, Material));
  else Object.material = CorrectMaterial(Object, Current);

  const Updated = Object.material;
  Processed.set(
    Object,
    Array.isArray(Updated) ? Updated.map(MaterialSignature).join("|") : MaterialSignature(Updated)
  );
}

function ProcessRoot(Root) {
  Root?.traverse?.(Object => {
    if (Object?.isMesh) ProcessMesh(Object);
  });
}

function ProcessChunk(Chunk) {
  if (!Chunk || Chunk.Cancelled) return;
  ProcessRoot(Chunk.Group);
  for (const Object of Chunk.ExternalObjects || []) ProcessRoot(Object);
}

function ProcessAll() {
  const Seen = new Set();
  for (const Chunk of Game.ActiveChunks.values()) {
    if (!Chunk || Seen.has(Chunk)) continue;
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
  for (const Chunk of Game.PreparedChunks.values()) {
    if (!Chunk || Seen.has(Chunk)) continue;
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
}

ProcessAll();

window.__STORE_VISIBLE_MATERIALS_R77__ = { ProcessAll, ProcessChunk };
window.__STORE_VISIBLE_MATERIALS_BUILD__ = "V0.35.61-R91-NO-FAKE-ASSET-TEXTURES";