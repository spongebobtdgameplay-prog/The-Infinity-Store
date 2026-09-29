import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Create3DText } from "./three-text-utility-r73.js?v=20260824-86";

const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.CollisionBoxes) {
  throw new Error("The Infinity Store game must load before retail zones.");
}

const KenneyCommit = "f78a38d01f3a47697ff144bfed0301df7f25c784";
const KenneyBase = `https://raw.githubusercontent.com/dennisorlando/junction-2025/${KenneyCommit}/models/mini-market/GLB%20format/`;
const KenneySource = "https://kenney.nl/assets/mini-market";
const KayKitBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/";
const Loader = new GLTFLoader();
const Templates = new Map();
const Processing = new WeakSet();

const Assets = Object.freeze({
  Cart: { Url: `${KenneyBase}shopping-cart.glb`, Source: KenneySource },
  Basket: { Url: `${KenneyBase}shopping-basket.glb`, Source: KenneySource },
  BagShelf: { Url: `${KenneyBase}shelf-bags.glb`, Source: KenneySource },
  RugLarge: { Url: `${KayKitBase}rug_rectangle_stripes_A.gltf`, Source: "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0" }
});

const ZoneBoardMaterial = new THREE.MeshStandardMaterial({ color: 0xd8ccb3, roughness: 0.86, metalness: 0.02 });
const ZoneFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x858e87, roughness: 0.62, metalness: 0.34 });
const ZoneTextMaterial = new THREE.MeshStandardMaterial({ color: 0x4c5e55, roughness: 0.48, metalness: 0.02 });

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
      if ("roughness" in Copy) Copy.roughness = Math.max(0.46, Copy.roughness ?? 0.7);
      Copy.needsUpdate = true;
      return Copy;
    });
    Object.material = Array.isArray(Object.material) ? Copies : Copies[0];
    Object.castShadow = false;
    Object.receiveShadow = false;
  });
}

async function LoadTemplate(Key) {
  const Definition = Assets[Key];
  if (!Definition) throw new Error(`Unknown retail-zone asset ${Key}`);
  if (!Templates.has(Key)) {
    Templates.set(Key, Loader.loadAsync(Definition.Url).then(Gltf => {
      const Root = Gltf.scene.clone(true);
      Root.name = `RetailZoneTemplate-${Key}`;
      Root.userData.Source = Definition.Source;
      Root.userData.License = "CC0-1.0";
      CloneMaterials(Root);
      return Root;
    }).catch(Error => {
      Templates.delete(Key);
      throw Error;
    }));
  }
  return Templates.get(Key);
}

async function CloneAsset(Key) {
  const Template = await LoadTemplate(Key);
  const Clone = Template.clone(true);
  CloneMaterials(Clone);
  Clone.userData.RetailZoneR82 = true;
  Clone.userData.Source = Assets[Key].Source;
  Clone.userData.License = "CC0-1.0";
  return Clone;
}

function NormalizeHeight(Object, TargetHeight, MaximumWidth = Infinity, MaximumDepth = Infinity) {
  let Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return false;
  const Size = Bounds.getSize(new THREE.Vector3());
  const Scale = Math.min(
    TargetHeight / Math.max(Size.y, 0.001),
    MaximumWidth / Math.max(Size.x, 0.001),
    MaximumDepth / Math.max(Size.z, 0.001)
  );
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

function XZOverlap(A, B, Padding = 0.10) {
  return A.max.x > B.min.x - Padding && A.min.x < B.max.x + Padding && A.max.z > B.min.z - Padding && A.min.z < B.max.z + Padding;
}

function CanPlace(Chunk, Bounds, Extra = []) {
  if (Bounds.min.x < -16.15 || Bounds.max.x > 16.15) return false;
  if (Bounds.min.z < Chunk.BottomZ + 0.50 || Bounds.max.z > Chunk.TopZ - 0.50) return false;
  for (const Box of Chunk.StructureBounds || []) if (XZOverlap(Bounds, Box, 0.08)) return false;
  for (const Box of Chunk.ReservedBounds || []) if (XZOverlap(Bounds, Box, 0.10)) return false;
  for (const Box of Extra) if (XZOverlap(Bounds, Box, 0.10)) return false;
  return true;
}

function AddCollision(Chunk, Object, Type, Reserve = false) {
  void Type;
  const Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return null;

  Object.userData.RayCollisionSolidR35 = true;
  const Box = Bounds.clone();
  if (Reserve) Chunk.ReservedBounds.push(Box.clone());
  return Box;
}

async function MakeZoneHeader(Text) {
  const Group = new THREE.Group();
  Group.name = `RetailZoneHeaderR82-${Text.replaceAll(" ", "-")}`;
  const Frame = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.55, 0.095), ZoneFrameMaterial);
  const Board = new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.43, 0.115), ZoneBoardMaterial);
  Group.add(Frame, Board);
  const Label = await Create3DText(Text, {
    MaxWidth: 1.92,
    MaxHeight: 0.24,
    Depth: 0.026,
    Material: ZoneTextMaterial
  });
  Label.position.set(0, -0.005, 0.075);
  Group.add(Label);
  return Group;
}

const PlannedZoneAssets = Object.freeze({
  Cart: { Key: "Cart", TargetHeight: 0.88, MaximumWidth: 1.15, MaximumDepth: 1.45, Prefix: "ShoppingCartR82" },
  Basket: { Key: "Basket", TargetHeight: 0.42, MaximumWidth: 0.75, MaximumDepth: 0.75, Prefix: "ShoppingBasketR82" },
  BagShelf: { Key: "BagShelf", TargetHeight: 1.55, MaximumWidth: 1.45, MaximumDepth: 0.95, Prefix: "BagShelfR82" }
});

async function PlacePlannedZoneAsset(Chunk, Entry, Index) {
  const Existing = (Chunk.Group?.children || []).find(Object => Object?.userData?.LayoutSlot === Entry.Slot);
  if (Existing) return Existing;
  const Definition = PlannedZoneAssets[Entry.Model];
  if (!Definition) return null;
  const Object = await CloneAsset(Definition.Key);
  if (!NormalizeHeight(Object, Definition.TargetHeight, Definition.MaximumWidth, Definition.MaximumDepth)) return null;
  Object.position.set(Entry.X, 0, Entry.Z);
  Object.rotation.y = Number(Entry.Rotation) || 0;
  Object.updateWorldMatrix(true, true);
  Object.name = `${Definition.Prefix}-${Index}`;
  Object.userData.ChunkId = Chunk.Id;
  Object.userData.LayoutSlot = Entry.Slot;
  Object.userData.LayoutAuthority = Chunk.Layout?.Authority;
  Object.userData.RetailZoneR82 = true;
  Object.userData.DecorationNoCollision = false;
  Chunk.Group.add(Object);
  const Solid = AddCollision(Chunk, Object, `${Object.name}SolidR82`, false);
  if (Solid) {
    const Collision = (Chunk.CollisionEntries || []).find(Value => Value?.Type === `${Object.name}SolidR82`);
    if (Collision) Collision.LayoutSlot = Entry.Slot;
  }
  return Object;
}

function PlacementYield() {
  return new Promise(Resolve => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => Resolve(), { timeout: 700 });
    } else {
      requestAnimationFrame(() => Resolve());
    }
  });
}

async function AddPlannedZoneHeaders(Chunk) {
  const Headers = Chunk.Layout?.ZoneHeaders || [];
  for (let HeaderIndex = 0; HeaderIndex < Headers.length; HeaderIndex += 1) {
    const HeaderPlan = Headers[HeaderIndex];
    if ((Chunk.Group?.children || []).some(Object => Object?.userData?.LayoutSlot === HeaderPlan.Slot)) continue;
    try {
      const Header = await MakeZoneHeader(HeaderPlan.Text);
      Header.position.set(HeaderPlan.X, 2.30, HeaderPlan.Z);
      Header.rotation.y = Number(HeaderPlan.Rotation) || 0;
      Header.userData.ChunkId = Chunk.Id;
      Header.userData.LayoutSlot = HeaderPlan.Slot;
      Header.userData.LayoutAuthority = Chunk.Layout?.Authority;
      Header.userData.RetailZoneR82 = true;
      Header.userData.WallMountedR82 = HeaderPlan.WallMounted === true;
      Header.userData.DecorationNoCollision = false;
      Header.userData.ForceSolidCollisionR30 = true;
      Header.userData.RayCollisionSolidR35 = true;
      Header.userData.SignCollisionR50 = true;
      Chunk.Group.add(Header);
      AddCollision(
        Chunk,
        Header,
        HeaderPlan.Text === "CART RETURN" ? "CartReturnSignSolidR82" : "BagAreaSignSolidR82",
        false
      );
    } catch (Error) {
      console.warn(`Planned retail-zone header unavailable for ${HeaderPlan.Slot}`, Error);
    }

    if (HeaderIndex < Headers.length - 1) await PlacementYield();
  }
}

export async function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group || Processing.has(Chunk)) return;
  if (Chunk.Group.userData.RetailZonesR82) return;
  Processing.add(Chunk);
  try {
    let Index = 0;
    const PlannedZones = Chunk.Layout?.Zones || [];
    for (const Entry of PlannedZones) {
      try {
        await PlacePlannedZoneAsset(Chunk, Entry, Index);
      } catch (Error) {
        console.warn(`Planned retail-zone asset unavailable for ${Entry.Slot}`, Error);
      }
      Index += 1;
      if (Index < PlannedZones.length) await PlacementYield();
    }

    await PlacementYield();
    await AddPlannedZoneHeaders(Chunk);
    const PlacedSlots = new Set((Chunk.Group?.children || []).map(Object => String(Object?.userData?.LayoutSlot || "")).filter(Boolean));
    const ZonesReady = (Chunk.Layout?.Zones || []).every(Entry => PlacedSlots.has(Entry.Slot));
    const HeadersReady = (Chunk.Layout?.ZoneHeaders || []).every(Entry => PlacedSlots.has(Entry.Slot));
    Chunk.Group.userData.RetailZonesR82 = ZonesReady && HeadersReady;
  } finally {
    Processing.delete(Chunk);
  }
}

export async function PreloadRetailZoneAssets() {
  await Promise.allSettled(Object.keys(Assets).map(Key => LoadTemplate(Key)));
}

function Discover() {
  if (window.__STORE_BOOT_CRITICAL__) return;
  for (const Chunk of Game.PreparedChunks.values()) ProcessChunk(Chunk).catch(Error => console.warn("Prepared retail zone failed", Error));
  for (const Chunk of Game.ActiveChunks.values()) {
    if (!Chunk.Group?.userData?.PresentationReadyR82) ProcessChunk(Chunk).catch(Error => console.warn("Initial retail zone failed", Error));
  }
}

await PreloadRetailZoneAssets();
// Initial discovery only. Runtime zone placement is sequenced by presentation-ready.
Discover();

window.__STORE_RETAIL_ZONES_R82__ = { ProcessChunk, Discover, PreloadRetailZoneAssets };
window.__STORE_RETAIL_ZONES_BUILD__ = "V0.35.50-SIGN-COLLISION";
