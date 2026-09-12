import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.ActiveChunks || !Game?.PreparedChunks) throw new Error("Game must load before visible material correction.");

const Processed = new WeakMap();
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

function CreateRetailTexture(Base, LineA, LineB, Vertical = false) {
  const Canvas = document.createElement("canvas");
  Canvas.width = 96;
  Canvas.height = 96;
  const Context = Canvas.getContext("2d", { alpha: false });
  Context.fillStyle = Base;
  Context.fillRect(0, 0, 96, 96);
  for (let Index = 0; Index < 24; Index += 1) {
    Context.globalAlpha = 0.08 + (Index % 5) * 0.012;
    Context.fillStyle = Index % 2 ? LineA : LineB;
    if (Vertical) Context.fillRect(Index * 4, 0, 1, 96);
    else Context.fillRect(0, Index * 4, 96, 1);
  }
  Context.globalAlpha = 0.08;
  for (let Index = 0; Index < 80; Index += 1) {
    const X = (Index * 37) % 96;
    const Y = (Index * 61) % 96;
    Context.fillStyle = Index % 2 ? LineA : LineB;
    Context.fillRect(X, Y, 1, 1);
  }
  Context.globalAlpha = 1;
  const Texture = new THREE.CanvasTexture(Canvas);
  Texture.wrapS = THREE.RepeatWrapping;
  Texture.wrapT = THREE.RepeatWrapping;
  Texture.repeat.set(2, 2);
  Texture.colorSpace = THREE.SRGBColorSpace;
  Texture.anisotropy = Math.min(2, Game.Renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  Texture.needsUpdate = true;
  return Texture;
}

const BrushedMetalTexture = CreateRetailTexture("#7f8986", "#b8c0bc", "#59615e");
const WarmLaminateTexture = CreateRetailTexture("#8c7359", "#c3a17d", "#5f4b3b", true);
const NeutralFabricTexture = CreateRetailTexture("#777b75", "#a7aba4", "#555a54", true);

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

function IsNeutralGray(Hex) {
  if (!Number.isInteger(Hex)) return false;
  const { Red, Green, Blue } = Channels(Hex);
  const Max = Math.max(Red, Green, Blue);
  const Min = Math.min(Red, Green, Blue);
  return Max - Min <= 22;
}

function FindModelRoot(Object) {
  let Current = Object;
  while (Current && Current !== Game.Scene) {
    const Name = String(Current.name || "");
    if (Name === "Shelf_Large" || Name === "Window_Large1") return Current;
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

function CorrectShelfMaterial(Material) {
  if (!Material) return Material;
  const Clone = Material.clone();
  const Hex = SrgbHex(Clone);
  if (!Clone.map) {
    Clone.map = BrushedMetalTexture;
    Clone.color?.setHex(0xffffff, THREE.SRGBColorSpace);
  } else if (Hex !== null && (IsTrueNearBlack(Hex) || IsNeutralGray(Hex))) {
    Clone.color?.setHex(0xaeb7b3, THREE.SRGBColorSpace);
  }
  if ("roughness" in Clone) Clone.roughness = 0.58;
  if ("metalness" in Clone) Clone.metalness = 0.30;
  if (Clone.emissive?.isColor) {
    Clone.emissive.setHex(0x151a18, THREE.SRGBColorSpace);
    Clone.emissiveIntensity = 0.04;
  }
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectWindowMaterial(Material) {
  if (!Material) return Material;
  const Clone = Material.clone();
  Clone.color?.setHex(0x84949a, THREE.SRGBColorSpace);
  if ("roughness" in Clone) Clone.roughness = 0.52;
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectBlackMaterial(Material) {
  const Hex = SrgbHex(Material);
  if (Hex === null) return Material;
  const Replacement = ExactReplacements.get(Hex) ?? (IsTrueNearBlack(Hex) ? 0x6c7371 : null);
  if (Replacement === null) return Material;
  const Clone = Material.clone();
  Clone.color.setHex(Replacement, THREE.SRGBColorSpace);
  Clone.needsUpdate = true;
  return Clone;
}

function ImportedProfile(Root) {
  const Name = String(Root?.name || "");
  if (/Shelf|Storage|Display/i.test(Name)) {
    return { Texture: BrushedMetalTexture, Color: 0xffffff, Roughness: 0.58, Metalness: 0.28 };
  }
  if (/Cabinet|Table/i.test(Name)) {
    return { Texture: WarmLaminateTexture, Color: 0xffffff, Roughness: 0.66, Metalness: 0.06 };
  }
  if (/Chair|Armchair/i.test(Name)) {
    return { Texture: NeutralFabricTexture, Color: 0xffffff, Roughness: 0.86, Metalness: 0.01 };
  }
  return { Texture: BrushedMetalTexture, Color: 0xffffff, Roughness: 0.68, Metalness: 0.12 };
}

function CorrectImportedMaterial(Material, Root) {
  if (!Material) return Material;
  const Hex = SrgbHex(Material);
  const NeedsSurface = !Material.map && (Hex === null || IsNeutralGray(Hex) || IsTrueNearBlack(Hex));
  const NeedsBrightening = Hex !== null && IsTrueNearBlack(Hex);
  if (!NeedsSurface && !NeedsBrightening) return Material;

  const Profile = ImportedProfile(Root);
  const Clone = Material.clone();
  if (NeedsSurface) {
    Clone.map = Profile.Texture;
    Clone.color?.setHex(Profile.Color, THREE.SRGBColorSpace);
  } else if (NeedsBrightening) {
    Clone.color?.setHex(0x8c9591, THREE.SRGBColorSpace);
  }
  if ("roughness" in Clone) Clone.roughness = Math.max(Profile.Roughness, Number(Clone.roughness) || 0);
  if ("metalness" in Clone) Clone.metalness = Math.min(Profile.Metalness, Number(Clone.metalness) || Profile.Metalness);
  Clone.needsUpdate = true;
  return Clone;
}

function CorrectMaterial(Object, Material) {
  const Root = FindModelRoot(Object);
  if (Root?.name === "Shelf_Large") return CorrectShelfMaterial(Material);
  if (Root?.name === "Window_Large1") return CorrectWindowMaterial(Material);

  const Imported = FindImportedRetailRoot(Object);
  if (Imported) return CorrectImportedMaterial(Material, Imported);
  return CorrectBlackMaterial(Material);
}

function ProcessMesh(Object) {
  if (!Object?.isMesh) return;
  const Current = Object.material;
  if (!Current) return;

  const Root = FindModelRoot(Object);
  const Imported = FindImportedRetailRoot(Object);
  const RootName = Root?.name || "";
  const ImportedName = Imported?.name || "";
  const Signature = Array.isArray(Current)
    ? `${RootName}:${ImportedName}:` + Current.map(Material => `${Material?.uuid || ""}:${SrgbHex(Material) ?? ""}:${Material?.map?.uuid || ""}`).join(":")
    : `${RootName}:${ImportedName}:${Current.uuid || ""}:${SrgbHex(Current) ?? ""}:${Current.map?.uuid || ""}`;
  if (Processed.get(Object) === Signature) return;

  if (Array.isArray(Current)) Object.material = Current.map(Material => CorrectMaterial(Object, Material));
  else Object.material = CorrectMaterial(Object, Current);

  const Updated = Object.material;
  const UpdatedSignature = Array.isArray(Updated)
    ? `${RootName}:${ImportedName}:` + Updated.map(Material => `${Material?.uuid || ""}:${SrgbHex(Material) ?? ""}:${Material?.map?.uuid || ""}`).join(":")
    : `${RootName}:${ImportedName}:${Updated?.uuid || ""}:${SrgbHex(Updated) ?? ""}:${Updated?.map?.uuid || ""}`;
  Processed.set(Object, UpdatedSignature);
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
window.__STORE_VISIBLE_MATERIALS_BUILD__ = "V0.35.59-R88-SURFACES";
