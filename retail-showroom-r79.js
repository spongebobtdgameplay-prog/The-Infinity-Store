import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Create3DText } from "./three-text-utility-r73.js";

const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.CollisionBoxes) {
  throw new Error("The Infinity Store game must load before retail showroom polish.");
}

const KayKitBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/";
const KayKitSource = "https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0";
const IndustrialShelfUrl = "https://raw.githubusercontent.com/danielrosehill/storage-box-3d-models/main/models/SB1/SB1.glb";
const IndustrialShelfSource = "https://github.com/danielrosehill/storage-box-3d-models";
const Loader = new GLTFLoader();
const Templates = new Map();
const RunningChunks = new WeakSet();
const BreakerTasks = new WeakSet();
const LightChunks = new WeakSet();
const DecoratedChunks = new WeakSet();

const AssetFiles = Object.freeze({
  ShelfLargeDecorated: IndustrialShelfUrl,
  ShelfLargeOpen: IndustrialShelfUrl,
  ShelfSmallDecorated: IndustrialShelfUrl,
  CabinetMedium: "cabinet_medium.gltf",
  CabinetSmallDecorated: "cabinet_small_decorated.gltf",
  ArmchairPillows: "armchair_pillows.gltf"
});

const BreakerLabelMaterial = new THREE.MeshStandardMaterial({
  color: 0xf2e5c8,
  roughness: 0.48,
  metalness: 0.02,
  emissive: 0x3a2d18,
  emissiveIntensity: 0.08
});
const BreakerSwitchMaterial = new THREE.MeshStandardMaterial({ color: 0xbfc7c1, roughness: 0.52, metalness: 0.45 });
const BreakerLeverMaterial = new THREE.MeshStandardMaterial({ color: 0xb8513f, roughness: 0.46, metalness: 0.08 });
const BreakerReadyMaterial = new THREE.MeshStandardMaterial({
  color: 0x87ca8f,
  emissive: 0x2f7940,
  emissiveIntensity: 1.05,
  roughness: 0.34,
  metalness: 0.02
});

function CloneMaterials(Root) {
  Root.traverse(Object => {
    if (!Object?.isMesh || !Object.material) return;
    const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
    const Replaced = Materials.map(Material => {
      const Copy = Material.clone();
      if (Copy.color?.isColor) {
        const Hex = Copy.color.getHex(THREE.SRGBColorSpace);
        const Red = (Hex >> 16) & 255;
        const Green = (Hex >> 8) & 255;
        const Blue = Hex & 255;
        if (Math.max(Red, Green, Blue) < 34) Copy.color.setHex(0x66736f, THREE.SRGBColorSpace);
      }
      if ("roughness" in Copy) Copy.roughness = Math.max(0.48, Copy.roughness ?? 0.7);
      Copy.needsUpdate = true;
      return Copy;
    });
    Object.material = Array.isArray(Object.material) ? Replaced : Replaced[0];
    Object.castShadow = false;
    Object.receiveShadow = false;
    Object.frustumCulled = true;
    Object.geometry?.computeBoundingSphere?.();
  });
}

async function LoadTemplate(Key) {
  const File = AssetFiles[Key];
  if (!File) throw new Error(`Unknown retail asset ${Key}`);
  if (!Templates.has(Key)) {
    const External = /^https?:\/\//i.test(File);
    const Url = External ? File : `${KayKitBase}${File}`;
    const Source = External ? IndustrialShelfSource : KayKitSource;
    const License = External ? "CC-BY-4.0" : "CC0-1.0";

    Templates.set(Key, Loader.loadAsync(Url).then(Gltf => {
      const Root = Gltf.scene;
      Root.name = `RetailTemplate-${Key}`;
      CloneMaterials(Root);
      Root.userData.Source = Source;
      Root.userData.License = License;
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
  Clone.name = `RetailImported-${Key}`;
  Clone.userData.RetailImportedR79 = true;
  Clone.userData.Source = Template.userData.Source || KayKitSource;
  Clone.userData.License = Template.userData.License || "CC0-1.0";
  return Clone;
}

function BoundsOf(Object) {
  Object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(Object);
}

function NormalizeLocalAsset(Object, TargetHeight, MaximumWidth = Infinity, MaximumDepth = Infinity) {
  Object.updateWorldMatrix(true, true);
  let Bounds = BoundsOf(Object);
  if (Bounds.isEmpty()) return false;
  const Size = Bounds.getSize(new THREE.Vector3());
  const HeightScale = TargetHeight / Math.max(Size.y, 0.001);
  const WidthScale = MaximumWidth / Math.max(Size.x, 0.001);
  const DepthScale = MaximumDepth / Math.max(Size.z, 0.001);
  const Scale = Math.min(HeightScale, WidthScale, DepthScale);
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

function NearestCollisionEntry(Chunk, Type, Center) {
  let Best = null;
  let BestDistance = Infinity;
  for (const Entry of Chunk.CollisionEntries || []) {
    if (Entry?.Type !== Type) continue;
    const Box = Entry.OriginalLegacyBox || Entry.OriginalBox || Entry.Box;
    if (!Box?.min || !Box?.max) continue;
    const X = (Box.min.x + Box.max.x) * 0.5;
    const Z = (Box.min.z + Box.max.z) * 0.5;
    const Distance = (X - Center.x) ** 2 + (Z - Center.z) ** 2;
    if (Distance < BestDistance) {
      Best = Entry;
      BestDistance = Distance;
    }
  }
  return Best;
}

function ApplySolidBounds(Chunk, Entry, Bounds, Type = null) {
  void Chunk;
  void Entry;
  void Bounds;
  void Type;
  return null;
}

function TightenExistingCollision(Chunk, Model) {
  const Bounds = BoundsOf(Model);
  if (Bounds.isEmpty()) return;
  const Center = Bounds.getCenter(new THREE.Vector3());
  const Size = Bounds.getSize(new THREE.Vector3());
  const HalfX = Math.max(0.11, Size.x * 0.485);
  const HalfZ = Math.max(0.11, Size.z * 0.485);
  const TightBounds = new THREE.Box3(
    new THREE.Vector3(Center.x - HalfX, Math.max(0, Bounds.min.y), Center.z - HalfZ),
    new THREE.Vector3(Center.x + HalfX, Bounds.max.y, Center.z + HalfZ)
  );
  ApplySolidBounds(Chunk, NearestCollisionEntry(Chunk, Model.name, Center), TightBounds, Model.name);
}

function MakeBreakerIndicator() {
  const Indicator = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.075, 0.028), BreakerReadyMaterial.clone());
  Indicator.name = "BreakerReadyIndicatorR79";
  return Indicator;
}

function ReplaceTaskCollision(Chunk, Task) {
  const Group = Task?.Object;
  if (!Group?.isObject3D) return;
  const Bounds = BoundsOf(Group);
  if (Bounds.isEmpty()) return;
  const Center = Bounds.getCenter(new THREE.Vector3());
  let Best = null;
  let BestDistance = Infinity;
  for (const Entry of Chunk.CollisionEntries || []) {
    if (!/StoreTask|TaskTerminal|Breaker/i.test(String(Entry?.Type || ""))) continue;
    const Box = Entry.OriginalLegacyBox || Entry.OriginalBox || Entry.Box;
    if (!Box?.min || !Box?.max) continue;
    const X = (Box.min.x + Box.max.x) * 0.5;
    const Z = (Box.min.z + Box.max.z) * 0.5;
    const Distance = (X - Center.x) ** 2 + (Z - Center.z) ** 2;
    if (Distance < BestDistance) {
      BestDistance = Distance;
      Best = Entry;
    }
  }
  ApplySolidBounds(Chunk, Best, Bounds, "StoreTaskTerminalR79");
}

async function BuildImportedBreaker(Chunk, Task) {
  if (!Task?.Object?.isObject3D || BreakerTasks.has(Task.Object)) return;
  BreakerTasks.add(Task.Object);
  try {
    const Group = Task.Object;
    const Imported = await CloneAsset("CabinetMedium");
    if (!NormalizeLocalAsset(Imported, 1.34, 0.82, 0.42)) return;
    while (Group.children.length) Group.remove(Group.children[0]);
    Imported.position.y = 0.12;
    Imported.name = "ImportedBreakerCabinetR79";
    Group.add(Imported);

    const Title = await Create3DText("BREAKER", {
      MaxWidth: 0.54,
      MaxHeight: 0.105,
      Depth: 0.022,
      Material: BreakerLabelMaterial
    });
    Title.name = "BreakerTitleR79";
    Title.position.set(0, 1.26, 0.235);
    Group.add(Title);

    const Rail = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.045, 0.035), BreakerSwitchMaterial);
    Rail.name = "BreakerRailR79";
    Rail.position.set(0, 0.98, 0.235);
    Group.add(Rail);

    const ToggleGeometry = new THREE.BoxGeometry(0.064, 0.13, 0.055);
    for (let Index = 0; Index < 5; Index += 1) {
      const Toggle = new THREE.Mesh(ToggleGeometry, BreakerSwitchMaterial);
      Toggle.name = `BreakerToggleR79-${Index}`;
      Toggle.position.set(-0.22 + Index * 0.11, 0.98, 0.272);
      Toggle.rotation.x = Index === 3 ? 0.20 : -0.12;
      Group.add(Toggle);
    }

    const Lever = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.30, 0.08), BreakerLeverMaterial);
    Lever.name = "BreakerResetLeverR79";
    Lever.position.set(0.27, 0.76, 0.267);
    Lever.rotation.z = -0.30;
    Group.add(Lever);

    const Reset = await Create3DText("RESET", {
      MaxWidth: 0.30,
      MaxHeight: 0.065,
      Depth: 0.018,
      Material: BreakerLabelMaterial
    });
    Reset.name = "BreakerResetTextR79";
    Reset.position.set(-0.08, 0.70, 0.238);
    Group.add(Reset);

    const Indicator = MakeBreakerIndicator();
    Indicator.position.set(-0.14, 0.82, 0.242);
    Group.add(Indicator);
    Task.Screen = Indicator;
    Group.userData.ImportedBreakerR79 = true;
    Group.userData.RetailSource = KayKitSource;
    Group.updateWorldMatrix(true, true);
    ReplaceTaskCollision(Chunk, Task);
  } catch (Error) {
    BreakerTasks.delete(Task.Object);
    console.warn("Imported breaker enclosure unavailable", Error);
  }
}

async function ReplaceBreakers(Chunk) {
  for (const Task of Chunk.TaskRecords || []) {
    if (Task?.Type === "breaker") await BuildImportedBreaker(Chunk, Task);
  }
}

function LightKey(Chunk, Object, Index) {
  const X = Math.round((Object.position?.x || 0) * 10);
  const Z = Math.round((Object.position?.z || 0) * 10);
  let Value = ((Chunk.Index + 37) * 73856093) ^ (X * 19349663) ^ (Z * 83492791) ^ (Index * 2654435761);
  Value ^= Value >>> 16;
  return Value >>> 0;
}

function ConfigureLightVariation(Chunk) {
  if (LightChunks.has(Chunk)) return;
  LightChunks.add(Chunk);
  const Glows = [];
  Chunk.Group?.traverse?.(Object => {
    if (Object?.name === "LightGlow" && Object.isMesh) Glows.push(Object);
  });
  Glows.sort((A, B) => A.position.z - B.position.z || A.position.x - B.position.x);

  for (let Index = 0; Index < Glows.length; Index += 1) {
    const Glow = Glows[Index];
    const Off = LightKey(Chunk, Glow, Index) % 100 < 28;
    Glow.userData.PermanentLightOffR79 = Off;
    if (!Glow.material) continue;
    Glow.material = Glow.material.clone();
    if (Off) {
      Glow.material.color?.setHex(0x444840, THREE.SRGBColorSpace);
      Glow.material.toneMapped = true;
      Glow.material.depthWrite = true;
      Glow.material.polygonOffset = false;
    } else {
      Glow.material.color?.setHex(0xffe4b3, THREE.SRGBColorSpace);
      Glow.material.toneMapped = false;
      Glow.material.depthWrite = false;
    }
    Glow.material.needsUpdate = true;
  }

  for (const Light of Chunk.Lights || []) {
    let Nearest = null;
    let Distance = Infinity;
    for (const Glow of Glows) {
      const DX = (Glow.position?.x || 0) - (Light.position?.x || 0);
      const DZ = (Glow.position?.z || 0) - (Light.position?.z || 0);
      const D = DX * DX + DZ * DZ;
      if (D < Distance) {
        Nearest = Glow;
        Distance = D;
      }
    }
    if (Nearest?.userData?.PermanentLightOffR79) {
      Light.intensity = 0;
      Light.userData.PermanentOffR79 = true;
    }
  }
}

async function PlacePlannedRetailAsset(Chunk, Entry) {
  const Existing = (Chunk.Group?.children || []).find(Object => Object?.userData?.LayoutSlot === Entry.Slot);
  if (Existing) return true;
  const Object = await CloneAsset(Entry.AssetKey);
  if (!Object) return false;
  if (!NormalizeLocalAsset(
    Object,
    Number(Entry.TargetHeight) || 1.2,
    Number(Entry.MaximumWidth) || 2.20,
    Number(Entry.MaximumDepth) || 1.10
  )) return false;

  Object.position.set(Entry.X, 0, Entry.Z);
  Object.rotation.y = Number(Entry.Rotation) || 0;
  Object.name = Entry.Name;
  Object.userData.ChunkId = Chunk.Id;
  Object.userData.LayoutSlot = Entry.Slot;
  Object.userData.LayoutAuthority = Chunk.Layout?.Authority;
  Object.userData.DecorationNoCollision = false;
  Object.userData.RetailImportedR79 = true;
  Chunk.Group.add(Object);
  Object.updateWorldMatrix(true, true);
  return true;
}

function PlacementYield() {
  return WaitForWorkSlice();
}

async function AddRealShowroomPieces(Chunk) {
  if (DecoratedChunks.has(Chunk)) return true;
  const Planned = Chunk.Layout?.Retail || [];
  for (let Index = 0; Index < Planned.length; Index += 1) {
    const Entry = Planned[Index];
    try {
      await PlacePlannedRetailAsset(Chunk, Entry);
    } catch (Error) {
      console.warn(`Planned retail asset unavailable for ${Entry.Slot}`, Error);
    }

    // Cached GLTF clones can resolve synchronously; force a real scheduling
    // boundary so a whole showroom cannot clone in one frame.
    if (Index < Planned.length - 1) await PlacementYield();
  }
  const PlacedSlots = new Set((Chunk.Group?.children || []).map(Object => String(Object?.userData?.LayoutSlot || "")).filter(Boolean));
  const Ready = Planned.every(Entry => PlacedSlots.has(Entry.Slot));
  if (Ready) DecoratedChunks.add(Chunk);
  return Ready;
}

async function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group || RunningChunks.has(Chunk)) return;
  RunningChunks.add(Chunk);
  try {
    await ReplaceBreakers(Chunk);
    ConfigureLightVariation(Chunk);
    const PlannedRetailReady = await AddRealShowroomPieces(Chunk);
    Chunk.Group.userData.RetailShowroomR79 = PlannedRetailReady !== false;
  } finally {
    RunningChunks.delete(Chunk);
  }
}

function Discover() {
  if (window.__STORE_BOOT_CRITICAL__) return;
  for (const Chunk of Game.ActiveChunks.values()) ProcessChunk(Chunk);
  for (const Chunk of Game.PreparedChunks.values()) ProcessChunk(Chunk);
}

// Templates are warmed once. Chunk processing is owned by the single
// presentation pipeline; do not poll every aisle independently.
await Promise.allSettled(Object.keys(AssetFiles).map(Key => LoadTemplate(Key)));
Discover();

window.__STORE_RETAIL_SHOWROOM_R79__ = { Discover, ProcessChunk };
window.__STORE_RETAIL_SHOWROOM_BUILD__ = "V0.35.47-BOOT-OWNER";
