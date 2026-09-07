import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks) throw new Error("Game must load before retail sale displays.");

const Loader = new GLTFLoader();
const Templates = new Map();
const Processing = new WeakSet();
const KayKitBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/";
const KenneyBase = "https://raw.githubusercontent.com/dennisorlando/junction-2025/f78a38d01f3a47697ff144bfed0301df7f25c784/models/mini-market/GLB%20format/";

const Assets = Object.freeze({
  CoffeeTable: { Url: `${KayKitBase}table_low.gltf`, Label: "COFFEE TABLE", Price: "149.99", Height: 0.48, MaxWidth: 1.70, MaxDepth: 1.15, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" },
  SideTable: { Url: `${KayKitBase}table_small.gltf`, Label: "SIDE TABLE", Price: "89.99", Height: 0.62, MaxWidth: 0.95, MaxDepth: 0.95, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" },
  DiningTable: { Url: `${KayKitBase}table_medium_long.gltf`, Label: "DINING TABLE", Price: "329.99", Height: 0.76, MaxWidth: 2.30, MaxDepth: 1.25, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" },
  FloorLamp: { Url: `${KayKitBase}lamp_standing.gltf`, Label: "FLOOR LAMP", Price: "119.99", Height: 1.58, MaxWidth: 0.62, MaxDepth: 0.62, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" },
  AccentCabinet: { Url: `${KayKitBase}cabinet_small_decorated.gltf`, Label: "ACCENT CABINET", Price: "219.99", Height: 0.92, MaxWidth: 1.05, MaxDepth: 0.70, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" },
  BoxShelf: { Url: `${KenneyBase}shelf-boxes.glb`, Label: "FLAT-PACK BOXES", Price: "129.99", Height: 1.48, MaxWidth: 1.55, MaxDepth: 0.95, Source: "https://kenney.nl/assets/mini-market" }
});

function BoundsOf(Object) {
  Object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(Object);
}

function CloneMaterials(Root) {
  Root.traverse(Object => {
    if (!Object?.isMesh || !Object.material) return;
    const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
    const Copies = Materials.map(Material => {
      const Copy = Material.clone();
      if ("roughness" in Copy) Copy.roughness = Math.max(0.50, Copy.roughness ?? 0.70);
      Copy.needsUpdate = true;
      return Copy;
    });
    Object.material = Array.isArray(Object.material) ? Copies : Copies[0];
    Object.castShadow = false;
    Object.receiveShadow = false;
    Object.frustumCulled = true;
    Object.geometry?.computeBoundingSphere?.();
  });
}
async function LoadTemplate(Key) {
  const Definition = Assets[Key];
  if (!Definition) return null;
  if (!Templates.has(Key)) {
    Templates.set(Key, (async () => {
      const Urls = Array.isArray(Definition.Urls) ? Definition.Urls : [Definition.Url];
      let LastError = null;
      for (let Index = 0; Index < Urls.length; Index += 1) {
        try {
          const Data = await Loader.loadAsync(Urls[Index]);
          const Root = Data.scene;
          Root.name = `RetailSaleTemplateR84-${Key}`;
          CloneMaterials(Root);



          Root.userData.Source = Definition.Source;
          Root.userData.AssetUrl = Urls[Index];
          return Root;
        } catch (Error) {
          LastError = Error;
        }
      }
      throw LastError || new Error(`No asset source available for ${Key}`);
    })().catch(Error => {
      Templates.delete(Key);
      throw Error;
    }));
  }
  return Templates.get(Key);
}

async function CloneAsset(Key) {
  const Template = await LoadTemplate(Key);
  if (!Template) return null;

  const Clone = Template.clone(true);

  Clone.traverse(Object => {
    if (!Object?.isMesh) return;
    Object.castShadow = false;
    Object.receiveShadow = false;
    Object.frustumCulled = true;
  });

  return Clone;
}

function NormalizeAsset(Object, Definition, RotationY = 0) {
  Object.rotation.y = RotationY;
  Object.updateWorldMatrix(true, true);
  let Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return false;
  const Size = Bounds.getSize(new THREE.Vector3());
  const Scale = Math.min(Definition.Height / Math.max(Size.y, 0.001), Definition.MaxWidth / Math.max(Size.x, 0.001), Definition.MaxDepth / Math.max(Size.z, 0.001));
  Object.scale.multiplyScalar(Scale);
  Object.updateWorldMatrix(true, true);
  Bounds = BoundsOf(Object);
  const Center = Bounds.getCenter(new THREE.Vector3());
  Object.position.x -= Center.x;
  Object.position.z -= Center.z;
  Object.position.y -= Bounds.min.y;
  Object.updateWorldMatrix(true, true);
  return true;
}

function ExistingSaleItems(Chunk) {
  return (Chunk.Group?.children || []).filter(Object => Object?.parent === Chunk.Group && Object.userData?.RetailImportedR84);
}

async function PlacePlannedSaleAsset(Chunk, Entry, Index) {
  const Definition = Assets[Entry.AssetKey];
  if (!Definition) return null;
  const Object = await CloneAsset(Entry.AssetKey);
  if (!Object || !NormalizeAsset(Object, Definition, Number(Entry.Rotation) || 0)) return null;
  Object.position.x += Entry.X;
  Object.position.z += Entry.Z;

  Object.name = `${Entry.Name}-${Index}`;
  Object.userData.ChunkId = Chunk.Id;
  Object.userData.LayoutSlot = Entry.Slot;
  Object.userData.LayoutAuthority = Chunk.Layout?.Authority;
  Object.userData.RetailImportedR84 = true;
  Object.userData.RetailSellableR84 = Entry.Sellable !== false;
  Object.userData.RetailLabel = Definition.Label;
  Object.userData.RetailPrice = Definition.Price;
  Object.userData.RetailDescription = Definition.Description || "";
  Object.userData.Source = Object.userData.Source || Definition.Source;
  Object.userData.DecorationNoCollision = false;
  Chunk.Group.add(Object);
  Object.updateWorldMatrix(true, true);

  return Object;
}

function PlacementYield() {
  return WaitForWorkSlice();
}

async function EnsureSaleItems(Chunk) {
  if (!Chunk.Group.userData?.RetailShowroomR79) return false;
  const Planned = Chunk.Layout?.Sale || [];
  const Existing = ExistingSaleItems(Chunk);
  const ExistingSlots = new Set(Existing.map(Object => String(Object.userData?.LayoutSlot || "")));

  for (let Index = 0; Index < Planned.length; Index += 1) {
    const Entry = Planned[Index];
    if (ExistingSlots.has(Entry.Slot)) continue;
    try {
      await PlacePlannedSaleAsset(Chunk, Entry, Index);
    } catch (Error) {
      console.warn(`Planned sale asset unavailable for ${Entry.Slot}`, Error);
    }

    if (Index < Planned.length - 1) await PlacementYield();
  }

  const CurrentSlots = new Set(ExistingSaleItems(Chunk).map(Object => String(Object.userData?.LayoutSlot || "")));
  const Ready = Planned.every(Entry => CurrentSlots.has(Entry.Slot));
  Chunk.Group.userData.RetailSaleAttemptedR85 = true;
  Chunk.Group.userData.RetailSaleItemsR84 = Ready;
  return Ready;
}

export async function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group || Processing.has(Chunk) || Chunk.Group.userData?.PresentationReadyR83) return;
  Processing.add(Chunk);
  try {
    const SaleReady = await EnsureSaleItems(Chunk);
    Chunk.Group.userData.RetailSaleDisplaysR84 = SaleReady;
  } finally {
    Processing.delete(Chunk);
  }
}

export function Ready(Chunk) {
  if (!Chunk?.Group) return false;
  const Planned = Chunk.Layout?.Sale || [];
  const CurrentSlots = new Set(ExistingSaleItems(Chunk).map(Object => String(Object.userData?.LayoutSlot || "")));
  return Planned.every(Entry => CurrentSlots.has(Entry.Slot));
}

export async function Preload() {
  await Promise.allSettled(Object.keys(Assets).map(Key => LoadTemplate(Key)));
}

await Preload();

function Discover() {
  if (window.__STORE_BOOT_CRITICAL__) return;
  for (const Chunk of Game.PreparedChunks.values()) if (!Chunk?.Group?.userData?.PresentationReadyR83) ProcessChunk(Chunk).catch(() => {});
  for (const Chunk of Game.ActiveChunks.values()) if (!Chunk?.Group?.userData?.PresentationReadyR83) ProcessChunk(Chunk).catch(() => {});
}

// Initial discovery only. Runtime chunks are handed here explicitly by
// presentation-ready; duplicate polling caused generation bursts.
Discover();

window.__STORE_RETAIL_SALE_DISPLAYS_R84__ = { ProcessChunk, Ready, Preload, Discover };
window.__STORE_RETAIL_SALE_DISPLAYS_BUILD__ = "V0.35.47-BOOT-OWNER";