import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { STREAM_RANGE, ChunkRange } from "./stream-range.js?v=20260907-v03558";
import { CreateChunkLayout } from "./store-layout.js?v=20260907-v03557-streaming1";

const Canvas = document.getElementById("GameCanvas");
const StartButton = document.getElementById("StartButton");
const BootScreen = document.getElementById("BootScreen");
const BootStatus = document.getElementById("BootStatus");
const Hud = document.getElementById("Hud");
const ErrorPanel = document.getElementById("ErrorPanel");
const ErrorText = document.getElementById("ErrorText");
const GameClock = document.getElementById("GameClock");
const ObjectiveText = document.getElementById("ObjectiveText");
const InteractPrompt = document.getElementById("InteractPrompt");
const TaskCounter = document.getElementById("TaskCounter");
const AisleCounter = document.getElementById("AisleCounter");

const Scene = new THREE.Scene();
Scene.background = new THREE.Color(0x141613);
Scene.fog = new THREE.FogExp2(0x141613, 0.0069);

const PlayerEyeHeight = 1.68;
const Camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 180);
Camera.position.set(0, PlayerEyeHeight, 8);

const Renderer = new THREE.WebGLRenderer({
  canvas: Canvas,
  antialias: false,
  powerPreference: "high-performance"
});
Renderer.setPixelRatio(Math.min(devicePixelRatio, 1.15));
Renderer.setSize(innerWidth, innerHeight, false);
Renderer.shadowMap.enabled = false;
Renderer.outputColorSpace = THREE.SRGBColorSpace;
Renderer.toneMapping = THREE.ACESFilmicToneMapping;
Renderer.toneMappingExposure = 1.15;

const Controls = new PointerLockControls(Camera, document.body);
const Loader = new GLTFLoader();
const GameTimer = new THREE.Clock();
const KeyState = new Set();
const CollisionBoxes = [];
const ModelCache = new Map();
const RugCanvasCache = new Map();
const ActiveChunks = new Map();
const PreparedChunks = new Map();
const PreparingChunks = new Map();
const Tasks = new Map();
const PlayerApi = window.__STORE_PLAYER__ || null;
const ProceduralPhysics = window.__STORE_PROCEDURAL_PHYSICS__ || null;
if (!ProceduralPhysics?.MoveCharacter) throw new Error("Procedural physics utility must load before the store game.");

window.__STORE_COLLISION_BOXES__ = CollisionBoxes;

const STORE_HALF_WIDTH = 17;
const CEILING_HEIGHT = 3.72;
const CHUNK_LENGTH = 30;
const FIRST_CHUNK_TOP_Z = 10;
const VIEW_KEEP_DISTANCE = 120;
const VIEW_KEEP_HOLD_MS = 2200;
const PREPARED_BACK_CACHE = STREAM_RANGE.PrefetchRadius;
const OBJECT_STREAM_INTERVAL_MS = 120;
const OBJECT_STREAM_NEAR_DISTANCE = 34;
const OBJECT_STREAM_FAR_DISTANCE = 72;
const PRICE_TAG_STREAM_DISTANCE = 28;
const TASK_DISTANCE = 1.85;
const PLACEMENT_CLEARANCE = 0.10;
const RESERVED_CLEARANCE = 0.035;
const STORE_TIME_RATE = 14;
const DAY_SECONDS = 24 * 60 * 60;
let WorldSeed = Number.isFinite(window.__STORE_WORLD_SEED__)
  ? (window.__STORE_WORLD_SEED__ >>> 0)
  : (() => {
      const Values = new Uint32Array(1);
      crypto.getRandomValues(Values);
      return (Values[0] >>> 0) || 1;
    })();

let WorldGeneration = 1;
window.__STORE_WORLD_GENERATION__ = WorldGeneration;

let StoreSeconds = 23 * 60 * 60 + 57 * 60;
let Started = false;
let LoadedDisplays = 0;
let CompletedTasks = 0;
let CurrentTask = null;
let LastChunkIndex = 0;
let LastObjectiveText = "";
let SeedResetFlight = null;
let LastChunkMaintenanceAt = -Infinity;
let LastMaintainedChunkIndex = Number.NaN;
let LastObjectStreamAt = -Infinity;
let HasObjectStreamCameraState = false;
const LastObjectStreamCameraPosition = new THREE.Vector3();
const LastObjectStreamCameraForward = new THREE.Vector3();
const StreamProjectionView = new THREE.Matrix4();
const StreamFrustum = new THREE.Frustum();
const StreamChunkBounds = new THREE.Box3();
const StreamCameraForward = new THREE.Vector3();
const StreamObjectPosition = new THREE.Vector3();
const StreamObjectSize = new THREE.Vector3();
const StreamToObject = new THREE.Vector3();
const StreamWarmScene = new THREE.Scene();
const StreamWarmTextures = new WeakSet();
const StreamWarmAmbient = new THREE.AmbientLight(0xffffff, 0.75);
const StreamWarmDirectional = new THREE.DirectionalLight(0xffffff, 0.45);
StreamWarmDirectional.position.set(4, 8, 5);
StreamWarmScene.add(StreamWarmAmbient, StreamWarmDirectional);

function MixSeed32(Value) {
  let Mixed = Value >>> 0;
  Mixed ^= Mixed >>> 16;
  Mixed = Math.imul(Mixed, 0x7feb352d);
  Mixed ^= Mixed >>> 15;
  Mixed = Math.imul(Mixed, 0x846ca68b);
  Mixed ^= Mixed >>> 16;
  return Mixed >>> 0;
}

function SeededRandom(Seed) {
  const Quantized = Math.trunc(Number(Seed) * 1000) >>> 0;
  return MixSeed32(Quantized) / 4294967296;
}

function ChunkSeed(Index) {
  const Coordinate = Math.imul((Index + 1) | 0, 0x9e3779b1);
  return MixSeed32((WorldSeed ^ Coordinate) >>> 0);
}

function RandomRange(Seed, Min, Max) {
  return Min + SeededRandom(Seed) * (Max - Min);
}

function ChunkCenterZ(Index) {
  return FIRST_CHUNK_TOP_Z - CHUNK_LENGTH * (Index + 0.5);
}

function ChunkTopZ(Index) {
  return FIRST_CHUNK_TOP_Z - CHUNK_LENGTH * Index;
}

function ChunkBottomZ(Index) {
  return FIRST_CHUNK_TOP_Z - CHUNK_LENGTH * (Index + 1);
}

function ChunkIndexForZ(Z) {
  return Math.floor((FIRST_CHUNK_TOP_Z - Z) / CHUNK_LENGTH);
}

function CreateTexture(Size, RepeatX, RepeatY, Draw) {
  const TextureCanvas = document.createElement("canvas");
  TextureCanvas.width = Size;
  TextureCanvas.height = Size;
  const Context = TextureCanvas.getContext("2d", { alpha: false });
  Draw(Context, Size);
  const Texture = new THREE.CanvasTexture(TextureCanvas);
  Texture.wrapS = THREE.RepeatWrapping;
  Texture.wrapT = THREE.RepeatWrapping;
  Texture.repeat.set(RepeatX, RepeatY);
  Texture.colorSpace = THREE.SRGBColorSpace;
  Texture.anisotropy = Math.min(4, Renderer.capabilities.getMaxAnisotropy());
  return Texture;
}

function CreateSurfaceTexture(BaseColor, AccentColor, Pattern) {
  return CreateTexture(192, 3, 3, (Context, Size) => {
    Context.fillStyle = BaseColor;
    Context.fillRect(0, 0, Size, Size);
    if (Pattern === "fabric") {
      Context.strokeStyle = AccentColor;
      Context.globalAlpha = 0.16;
      for (let Axis = 0; Axis < Size; Axis += 4) {
        Context.beginPath();
        Context.moveTo(Axis, 0);
        Context.lineTo(Axis, Size);
        Context.stroke();
        Context.beginPath();
        Context.moveTo(0, Axis);
        Context.lineTo(Size, Axis);
        Context.stroke();
      }
      Context.globalAlpha = 1;
    } else if (Pattern === "wood") {
      for (let Line = 0; Line < 44; Line += 1) {
        const Y = SeededRandom(Line * 7 + 2) * Size;
        Context.strokeStyle = AccentColor;
        Context.globalAlpha = 0.08 + SeededRandom(Line * 7 + 4) * 0.13;
        Context.lineWidth = 1 + SeededRandom(Line * 7 + 3) * 2.2;
        Context.beginPath();
        Context.moveTo(0, Y);
        Context.bezierCurveTo(Size * 0.25, Y + 8, Size * 0.72, Y - 7, Size, Y + 3);
        Context.stroke();
      }
      Context.globalAlpha = 1;
    } else if (Pattern === "metal") {
      Context.globalAlpha = 0.13;
      for (let Line = 0; Line < 120; Line += 1) {
        const Y = SeededRandom(Line * 11 + 5) * Size;
        Context.fillStyle = AccentColor;
        Context.fillRect(0, Y, Size, SeededRandom(Line * 11 + 6) > 0.7 ? 2 : 1);
      }
      Context.globalAlpha = 1;
    } else if (Pattern === "ceramic") {
      for (let Dot = 0; Dot < 320; Dot += 1) {
        const X = SeededRandom(Dot * 5 + 20) * Size;
        const Y = SeededRandom(Dot * 5 + 21) * Size;
        Context.fillStyle = AccentColor;
        Context.globalAlpha = 0.025 + SeededRandom(Dot * 5 + 22) * 0.05;
        Context.fillRect(X, Y, 1, 1);
      }
      Context.globalAlpha = 1;
    }
  });
}

const WallTexture = CreateTexture(256, 4.5, 4.5, (Context, Size) => {
  Context.fillStyle = "#807e76";
  Context.fillRect(0, 0, Size, Size);
  for (let Index = 0; Index < 900; Index += 1) {
    const X = SeededRandom(Index * 3 + 1) * Size;
    const Y = SeededRandom(Index * 3 + 2) * Size;
    const Shade = 86 + Math.floor(SeededRandom(Index * 3 + 3) * 58);
    Context.fillStyle = `rgba(${Shade},${Shade},${Math.max(0, Shade - 5)},0.08)`;
    Context.fillRect(X, Y, 1.2, 1.2);
  }
  const Grime = Context.createLinearGradient(0, 0, 0, Size);
  Grime.addColorStop(0, "rgba(255,255,255,0.025)");
  Grime.addColorStop(0.73, "rgba(40,34,28,0.02)");
  Grime.addColorStop(1, "rgba(28,22,18,0.12)");
  Context.fillStyle = Grime;
  Context.fillRect(0, 0, Size, Size);
});

const FloorTexture = CreateTexture(256, 7.5, 7.5, (Context, Size) => {
  Context.fillStyle = "#5d584f";
  Context.fillRect(0, 0, Size, Size);
  for (let Index = 0; Index < 950; Index += 1) {
    const X = SeededRandom(Index * 4 + 11) * Size;
    const Y = SeededRandom(Index * 4 + 12) * Size;
    const Bright = 54 + Math.floor(SeededRandom(Index * 4 + 13) * 48);
    Context.fillStyle = `rgba(${Bright},${Math.max(0, Bright - 3)},${Math.max(0, Bright - 8)},0.10)`;
    Context.fillRect(X, Y, 1.3, 1.3);
  }
  Context.strokeStyle = "rgba(29,27,24,0.48)";
  Context.lineWidth = 2;
  for (let Axis = 0; Axis <= Size; Axis += 64) {
    Context.beginPath();
    Context.moveTo(Axis, 0);
    Context.lineTo(Axis, Size);
    Context.stroke();
    Context.beginPath();
    Context.moveTo(0, Axis);
    Context.lineTo(Size, Axis);
    Context.stroke();
  }
});

const CeilingTexture = CreateTexture(256, 8, 8, (Context, Size) => {
  Context.fillStyle = "#7f7f7a";
  Context.fillRect(0, 0, Size, Size);
  Context.strokeStyle = "rgba(43,44,42,0.58)";
  Context.lineWidth = 3;
  for (let Axis = 0; Axis <= Size; Axis += 64) {
    Context.beginPath();
    Context.moveTo(Axis, 0);
    Context.lineTo(Axis, Size);
    Context.stroke();
    Context.beginPath();
    Context.moveTo(0, Axis);
    Context.lineTo(Size, Axis);
    Context.stroke();
  }
});

const FabricRustTexture = CreateSurfaceTexture("#713c31", "#d89d7d", "fabric");
const FabricGreenTexture = CreateSurfaceTexture("#34483c", "#91aa8a", "fabric");
const FabricBlueTexture = CreateSurfaceTexture("#394956", "#96a9b7", "fabric");
const FabricGoldTexture = CreateSurfaceTexture("#765b32", "#d0ad69", "fabric");
const OakTexture = CreateSurfaceTexture("#765437", "#d7a26d", "wood");
const DarkWoodTexture = CreateSurfaceTexture("#34271f", "#9d7251", "wood");
const PaintedGreenTexture = CreateSurfaceTexture("#43544b", "#a2b3a7", "wood");
const SteelTexture = CreateSurfaceTexture("#6d7374", "#d8dddc", "metal");
const DarkSteelTexture = CreateSurfaceTexture("#282d30", "#8d999d", "metal");
const CeramicTexture = CreateSurfaceTexture("#d5d0c3", "#857f74", "ceramic");

function Pbr(Map, Color, Roughness, Metalness = 0) {
  return new THREE.MeshStandardMaterial({ map: Map, color: Color, roughness: Roughness, metalness: Metalness });
}

const WallMaterial = Pbr(WallTexture, 0xc1beb4, 0.94, 0.01);
const FloorMaterial = Pbr(FloorTexture, 0x9b9185, 0.97, 0.01);
const CeilingMaterial = Pbr(CeilingTexture, 0xb4b2aa, 0.98, 0);
const TrimMaterial = new THREE.MeshStandardMaterial({ color: 0x2f2c28, roughness: 0.82, metalness: 0.16 });
const LightHousingMaterial = new THREE.MeshStandardMaterial({ color: 0x242628, roughness: 0.68, metalness: 0.62 });
const PanelGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xffe8bd });
const TaskMetalMaterial = new THREE.MeshStandardMaterial({ color: 0x323a3b, roughness: 0.55, metalness: 0.72 });
const TaskGlowMaterial = new THREE.MeshStandardMaterial({ color: 0x5a6a51, emissive: 0x7bc76f, emissiveIntensity: 1.2, roughness: 0.5 });

const MaterialPalettes = {
  Couch_Large1: [Pbr(FabricRustTexture, 0xffc5ae, 0.92), Pbr(DarkWoodTexture, 0x80614f, 0.82)],
  Couch_L: [Pbr(FabricGreenTexture, 0xc3d0c3, 0.94), Pbr(DarkWoodTexture, 0x705446, 0.84)],
  Chair_2: [Pbr(FabricGoldTexture, 0xe0c18a, 0.93), Pbr(DarkWoodTexture, 0x7a5c45, 0.84)],
  Table_RoundLarge: [Pbr(OakTexture, 0xe0bb91, 0.80)],
  Bed_King: [Pbr(FabricBlueTexture, 0xd6e0e5, 0.96), Pbr(DarkWoodTexture, 0x80624d, 0.84)],
  Bed_Single: [Pbr(FabricGoldTexture, 0xe1cfad, 0.96), Pbr(OakTexture, 0xc89d70, 0.84)],
  NightStand_2: [Pbr(OakTexture, 0xd0a275, 0.83)],
  Shelf_Large: [Pbr(DarkWoodTexture, 0x7b604f, 0.84)],
  Bookshelf: [Pbr(OakTexture, 0xcaa06f, 0.84)],
  Kitchen_Cabinet1: [Pbr(PaintedGreenTexture, 0xa9b7ae, 0.78)],
  Kitchen_Fridge: [Pbr(SteelTexture, 0xe7e6dd, 0.45, 0.45)],
  Kitchen_Oven: [Pbr(DarkSteelTexture, 0x9da4a6, 0.48, 0.62)],
  Kitchen_Sink: [Pbr(SteelTexture, 0xd7dcda, 0.38, 0.72)],
  Bathroom_Sink: [Pbr(CeramicTexture, 0xf2eee5, 0.32), Pbr(SteelTexture, 0xcfd5d2, 0.34, 0.58)],
  Bathroom_Bathtub: [Pbr(CeramicTexture, 0xf1ede3, 0.34)],
  Bathroom_Toilet: [Pbr(CeramicTexture, 0xf2eee5, 0.30)],
  Light_Floor1: [Pbr(DarkSteelTexture, 0x777f82, 0.48, 0.64), Pbr(FabricGoldTexture, 0xf2d49c, 0.88)],
  Door_3: [Pbr(DarkWoodTexture, 0x9d7559, 0.80)],
  Window_Large1: [Pbr(DarkSteelTexture, 0x7f898c, 0.46, 0.65)]
};

const IndustrialShelfUrl = "https://raw.githubusercontent.com/danielrosehill/storage-box-3d-models/main/models/SB1/SB1.glb";
const KayKitFurnitureBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/";
const KayKitRestaurantBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Restaurant-Bits-1.0/main/addons/kaykit_restaurant_bits/Assets/gltf/";
const KhronosSampleBase = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/";

const ModelDefinitions = {
  Couch_Large1: { Url: `${KhronosSampleBase}GlamVelvetSofa/glTF-Binary/GlamVelvetSofa.glb`, Axis: "x", Target: 2.45, PreserveMaterials: true },
  Couch_L: { Url: `${KhronosSampleBase}GlamVelvetSofa/glTF-Binary/GlamVelvetSofa.glb`, Axis: "x", Target: 2.80, PreserveMaterials: true },
  Chair_2: { Url: `${KhronosSampleBase}ChairDamaskPurplegold/glTF-Binary/ChairDamaskPurplegold.glb`, Axis: "y", Target: 1.00, PreserveMaterials: true },
  Table_RoundLarge: { Url: `${KayKitFurnitureBase}table_medium.gltf`, Axis: "x", Target: 1.55, PreserveMaterials: true },
  Bed_King: { Url: "Models/Bedroom/GLB/Bed_King.glb", Axis: "z", Target: 2.08 },
  Bed_Single: { Url: "Models/Bedroom/GLB/Bed_Single.glb", Axis: "z", Target: 2.02 },
  NightStand_2: { Url: "Models/Bedroom/GLB/NightStand_2.glb", Axis: "y", Target: 0.58 },
  Shelf_Large: { Url: IndustrialShelfUrl, Axis: "y", Target: 2.08, PreserveMaterials: true },
  Bookshelf: { Url: IndustrialShelfUrl, Axis: "y", Target: 2.02, PreserveMaterials: true },
  Kitchen_Cabinet1: { Url: `${KayKitFurnitureBase}cabinet_medium.gltf`, Axis: "y", Target: 0.91, PreserveMaterials: true },
  Kitchen_Fridge: { Url: "Models/Kitchen/GLB/Kitchen_Fridge.glb", Axis: "y", Target: 1.86 },
  Kitchen_Oven: { Url: `${KayKitRestaurantBase}stove_multi_decorated.gltf`, Axis: "y", Target: 0.94, PreserveMaterials: true },
  Kitchen_Sink: { Url: `${KayKitRestaurantBase}kitchencounter_sink.gltf`, Axis: "y", Target: 0.90, PreserveMaterials: true },
  Bathroom_Sink: { Url: `${KayKitRestaurantBase}kitchentable_sink.gltf`, Axis: "y", Target: 0.84, PreserveMaterials: true },
  Bathroom_Bathtub: { Url: "Models/Bathroom/GLB/Bathroom_Bathtub.glb", Axis: "z", Target: 1.82 },
  Bathroom_Toilet: { Url: "Models/Bathroom/GLB/Bathroom_Toilet.glb", Axis: "y", Target: 0.82 },
  Light_Floor1: { Url: "Models/Lighting/GLB/Light_Floor1.glb", Axis: "y", Target: 1.58 },
  Door_3: { Url: "Models/Architecture/GLB/Door_3.glb", Axis: "y", Target: 2.06 },
  Window_Large1: { Url: "Models/Architecture/GLB/Window_Large1.glb", Axis: "y", Target: 1.38 }
};

const CollisionProfiles = {
  Couch_Large1: [2.25, 0.90], Couch_L: [2.45, 1.65], Chair_2: [0.78, 0.76], Table_RoundLarge: [1.38, 1.38],
  Bed_King: [1.90, 2.02], Bed_Single: [1.02, 1.96], NightStand_2: [0.52, 0.48], Shelf_Large: [1.75, 0.50],
  Bookshelf: [1.45, 0.42], Kitchen_Cabinet1: [1.05, 0.58], Kitchen_Fridge: [0.84, 0.78], Kitchen_Oven: [0.98, 1.14],
  Kitchen_Sink: [1.05, 0.72], Bathroom_Sink: [0.92, 0.68], Bathroom_Bathtub: [0.80, 1.72], Bathroom_Toilet: [0.62, 0.78]
};

const PlacementProfiles = {
  ...CollisionProfiles,
  Light_Floor1: [0.48, 0.48],
  Door_3: [1.0, 0.24],
  Window_Large1: [1.45, 0.22]
};

const Themes = ["LIVING ROOM", "BEDROOMS", "KITCHENS", "BATHROOMS", "WAREHOUSE", "SHOWROOM", "CLEARANCE", "STORAGE"];

const GenerationQueue = [];
let GenerationRunning = false;

function ScheduleGenerationWork(Job) {
  return new Promise((Resolve, Reject) => {
    GenerationQueue.push({ Job, Resolve, Reject });
    PumpGenerationQueue();
  });
}

function PumpGenerationQueue() {
  if (GenerationRunning || !GenerationQueue.length) return;
  GenerationRunning = true;

  const Run = async () => {
    const Entry = GenerationQueue.shift();
    if (!Entry) {
      GenerationRunning = false;
      return;
    }

    try {
      Entry.Resolve(await Entry.Job());
    } catch (Error) {
      Entry.Reject(Error);
    } finally {
      GenerationRunning = false;
      const Continue = () => PumpGenerationQueue();

      // Never chain another generation job into the same frame.
      if (document.visibilityState === "visible") {
        requestAnimationFrame(Continue);
      } else {
        setTimeout(Continue, 32);
      }
    }
  };

  WaitForWorkSlice(5).then(Run);
}

function OverlapsXZ(A, B, Padding = 0) {
  return A.max.x > B.min.x - Padding && A.min.x < B.max.x + Padding && A.max.z > B.min.z - Padding && A.min.z < B.max.z + Padding;
}

function Footprint(Name, X, Z, Rotation = 0, Extra = 0) {
  const [Width, Depth] = PlacementProfiles[Name] || [0.68, 0.68];
  const C = Math.abs(Math.cos(Rotation));
  const S = Math.abs(Math.sin(Rotation));
  const RotatedWidth = Width * C + Depth * S;
  const RotatedDepth = Width * S + Depth * C;
  const HalfX = RotatedWidth * 0.5 + Extra;
  const HalfZ = RotatedDepth * 0.5 + Extra;
  return new THREE.Box3(new THREE.Vector3(X - HalfX, 0, Z - HalfZ), new THREE.Vector3(X + HalfX, 2.5, Z + HalfZ));
}

function IsFootprintClear(Chunk, Bounds, CheckReserved = true) {
  if (Bounds.min.x < -STORE_HALF_WIDTH + 0.28 || Bounds.max.x > STORE_HALF_WIDTH - 0.28) return false;
  if (Bounds.min.z < Chunk.BottomZ + 0.32 || Bounds.max.z > Chunk.TopZ - 0.32) return false;
  for (const Structure of Chunk.StructureBounds) {
    if (OverlapsXZ(Bounds, Structure, PLACEMENT_CLEARANCE)) return false;
  }
  if (CheckReserved) {
    for (const Reserved of Chunk.ReservedBounds) {
      if (OverlapsXZ(Bounds, Reserved, RESERVED_CLEARANCE)) return false;
    }
  }
  return true;
}

function ShapeCastPlacement(Chunk, Name, X, Z, Rotation = 0, Reserve = true) {
  const OriginalSide = Math.abs(X) > 4.5 ? Math.sign(X) : 0;
  const Offsets = [[0, 0]];
  for (const Radius of [0.45, 0.9, 1.35, 1.8, 2.25, 2.7, 3.15]) {
    Offsets.push([0, Radius], [0, -Radius], [Radius, 0], [-Radius, 0]);
    const Diagonal = Radius * 0.70710678;
    Offsets.push([Diagonal, Diagonal], [-Diagonal, Diagonal], [Diagonal, -Diagonal], [-Diagonal, -Diagonal]);
  }
  for (const [OffsetX, OffsetZ] of Offsets) {
    const CandidateX = X + OffsetX;
    const CandidateZ = Z + OffsetZ;
    if (OriginalSide && (Math.sign(CandidateX) !== OriginalSide || Math.abs(CandidateX) < 4.25)) continue;
    const Bounds = Footprint(Name, CandidateX, CandidateZ, Rotation, 0.035);
    if (!IsFootprintClear(Chunk, Bounds, true)) continue;
    if (Reserve) Chunk.ReservedBounds.push(Bounds.clone());
    return { X: CandidateX, Z: CandidateZ, Bounds };
  }
  return null;
}

function ResolveCustomPlacement(Chunk, X, Z, Width, Depth) {
  const Name = `Custom-${Chunk.ReservedBounds.length}`;
  PlacementProfiles[Name] = [Width, Depth];
  const Placement = ShapeCastPlacement(Chunk, Name, X, Z, 0, true);
  delete PlacementProfiles[Name];
  return Placement;
}

function AddChunkCollision(Chunk, Bounds, Type = "world") {
  const Entry = { Box: Bounds, ChunkId: Chunk.Id, Type, Active: false };
  Chunk.CollisionEntries.push(Entry);
  if (/Wall|Partition/i.test(Type)) Chunk.StructureBounds.push(Bounds.clone());
  return Entry;
}

function Box(Name, Size, Position, Material, Chunk, Collidable = false) {
  const Mesh = new THREE.Mesh(new THREE.BoxGeometry(Size.x, Size.y, Size.z), Material);
  Mesh.name = Name;
  Mesh.position.copy(Position);
  Mesh.userData.ChunkId = Chunk.Id;
  Chunk.Group.add(Mesh);
  if (Collidable) {
    const Bounds = new THREE.Box3().setFromCenterAndSize(Position.clone(), Size.clone());
    AddChunkCollision(Chunk, Bounds, Name);
  }
  return Mesh;
}

function AddPartition(Chunk, X, Z, Length = 3.3) {
  Box("ShowroomPartition", new THREE.Vector3(0.15, 2.25, Length), new THREE.Vector3(X, 1.125, Z), WallMaterial, Chunk, true);
  Box("PartitionCap", new THREE.Vector3(0.23, 0.07, Length + 0.08), new THREE.Vector3(X, 2.285, Z), TrimMaterial, Chunk);
  Box("PartitionBase", new THREE.Vector3(0.22, 0.11, Length + 0.06), new THREE.Vector3(X, 0.055, Z), TrimMaterial, Chunk);
}

function AddLightFixture(Chunk, X, Z, Broken = false) {
  Box("LightHousing", new THREE.Vector3(3.4, 0.08, 0.42), new THREE.Vector3(X, 3.56, Z), LightHousingMaterial, Chunk);
  const GlowMaterial = PanelGlowMaterial.clone();
  if (Broken) GlowMaterial.color.setHex(0x3b352e);
  Box("LightGlow", new THREE.Vector3(3.05, 0.018, 0.22), new THREE.Vector3(X, 3.51, Z), GlowMaterial, Chunk);
  if (!Broken && Math.abs(X) < 1) {
    const Light = new THREE.PointLight(0xffe3b1, 1.75, 14, 1.85);
    Light.position.set(X, 3.12, Z);
    Light.userData.BaseIntensity = 1.75;
    Light.userData.ChunkId = Chunk.Id;
    Chunk.Group.add(Light);
    Chunk.Lights.push(Light);
  }
}

function EnsureUvs(Geometry) {
  if (Geometry.attributes.uv || !Geometry.attributes.position) return;
  Geometry.computeBoundingBox();
  const Bounds = Geometry.boundingBox;
  const Size = new THREE.Vector3();
  Bounds.getSize(Size);
  const Position = Geometry.attributes.position;
  const Uvs = new Float32Array(Position.count * 2);
  const Dimensions = [
    { A: "x", B: "y", Area: Size.x * Size.y },
    { A: "x", B: "z", Area: Size.x * Size.z },
    { A: "z", B: "y", Area: Size.z * Size.y }
  ].sort((Left, Right) => Right.Area - Left.Area)[0];
  const MinA = Bounds.min[Dimensions.A];
  const MinB = Bounds.min[Dimensions.B];
  const SizeA = Math.max(Size[Dimensions.A], 0.0001);
  const SizeB = Math.max(Size[Dimensions.B], 0.0001);
  for (let Index = 0; Index < Position.count; Index += 1) {
    const Vertex = new THREE.Vector3().fromBufferAttribute(Position, Index);
    Uvs[Index * 2] = (Vertex[Dimensions.A] - MinA) / SizeA;
    Uvs[Index * 2 + 1] = (Vertex[Dimensions.B] - MinB) / SizeB;
  }
  Geometry.setAttribute("uv", new THREE.BufferAttribute(Uvs, 2));
}

function ApplyModelMaterials(Name, Model) {
  const Palette = MaterialPalettes[Name];
  if (!Palette) return;
  let MeshIndex = 0;
  Model.traverse(Object => {
    if (!Object.isMesh) return;
    EnsureUvs(Object.geometry);
    const Existing = Array.isArray(Object.material) ? Object.material : [Object.material];
    const Replaced = Existing.map((Material, Index) => {
      const Source = Palette[(MeshIndex + Index) % Palette.length];
      const Copy = Source.clone();
      if (Source.map) Copy.map = Source.map;
      Copy.side = THREE.FrontSide;
      return Copy;
    });
    Object.material = Array.isArray(Object.material) ? Replaced : Replaced[0];
    MeshIndex += 1;
  });
}

function PrepareModel(Name, Model) {
  const Definition = ModelDefinitions[Name];

  const EmbeddedLights = [];
  Model.traverse(Object => {
    if (Object?.isLight && Object.parent) EmbeddedLights.push(Object);
    if (Object?.isMesh) {
      Object.frustumCulled = true;
      Object.castShadow = false;
      Object.receiveShadow = false;
      Object.geometry?.computeBoundingSphere?.();
    }
  });
  for (const Light of EmbeddedLights) Light.parent?.remove(Light);

  if (Array.isArray(Definition.RemoveNodes) && Definition.RemoveNodes.length) {
    const Removed = [];
    Model.traverse(Object => {
      if (Definition.RemoveNodes.includes(String(Object?.name || ""))) Removed.push(Object);
    });
    for (const Object of Removed) Object.parent?.remove(Object);
  }

  Model.updateMatrixWorld(true);
  const RawBounds = new THREE.Box3().setFromObject(Model);
  const RawSize = RawBounds.getSize(new THREE.Vector3());
  const AxisSize = Math.max(RawSize[Definition.Axis], 0.0001);
  const Scale = Definition.Target / AxisSize;
  Model.scale.setScalar(Scale);

  if (!Definition.PreserveMaterials) ApplyModelMaterials(Name, Model);

  Model.updateMatrixWorld(true);
  const Bounds = new THREE.Box3().setFromObject(Model);
  const Center = Bounds.getCenter(new THREE.Vector3());
  Model.position.x -= Center.x;
  Model.position.z -= Center.z;
  Model.updateMatrixWorld(true);
  const Grounded = new THREE.Box3().setFromObject(Model);
  Model.position.y -= Grounded.min.y;
  Model.position.y += Number(Definition.FloorOffset) || 0;
  Model.updateMatrixWorld(true);
}

function NormalizeSupportModel(Model, Width, Height, Depth) {
  Model.updateMatrixWorld(true);
  const Bounds = new THREE.Box3().setFromObject(Model);
  const Size = Bounds.getSize(new THREE.Vector3());

  Model.scale.x *= Width / Math.max(Size.x, 0.001);
  Model.scale.y *= Height / Math.max(Size.y, 0.001);
  Model.scale.z *= Depth / Math.max(Size.z, 0.001);
  Model.updateMatrixWorld(true);

  const Grounded = new THREE.Box3().setFromObject(Model);
  const Center = Grounded.getCenter(new THREE.Vector3());
  Model.position.x -= Center.x;
  Model.position.z -= Center.z;
  Model.position.y -= Grounded.min.y;
  Model.updateMatrixWorld(true);
}

function ComposeSupportedFixture(Name, Fixture, SupportTemplate) {
  const Definition = ModelDefinitions[Name];
  if (!Definition?.SupportModel || !SupportTemplate) return Fixture;

  const Group = new THREE.Group();
  Group.name = `${Name}Fixture`;

  const Support = SupportTemplate.clone(true);
  NormalizeSupportModel(
    Support,
    Number(Definition.SupportWidth) || 0.96,
    Number(Definition.SupportHeight) || 0.76,
    Number(Definition.SupportDepth) || 0.56
  );

  Fixture.updateMatrixWorld(true);
  const FixtureBounds = new THREE.Box3().setFromObject(Fixture);
  const SupportBounds = new THREE.Box3().setFromObject(Support);

  Fixture.position.y += SupportBounds.max.y - FixtureBounds.min.y - 0.012;
  Fixture.updateMatrixWorld(true);

  Group.add(Support);
  Group.add(Fixture);
  Group.updateMatrixWorld(true);

  const Combined = new THREE.Box3().setFromObject(Group);
  const Center = Combined.getCenter(new THREE.Vector3());
  Group.position.x -= Center.x;
  Group.position.z -= Center.z;
  Group.position.y -= Combined.min.y;
  Group.updateMatrixWorld(true);

  Group.userData.GroundedFixtureR358 = true;
  return Group;
}

const MODEL_LOAD_TIMEOUT_MS = 10000;

function LoadModelWithTimeout(Name, Definition) {
  const LoadPromise = Loader.loadAsync(Definition.Url);
  let TimeoutId = 0;

  const TimeoutPromise = new Promise((_, Reject) => {
    TimeoutId = setTimeout(() => {
      Reject(new Error(`Model ${Name} exceeded the ${MODEL_LOAD_TIMEOUT_MS}ms load limit.`));
    }, MODEL_LOAD_TIMEOUT_MS);
  });

  return Promise.race([LoadPromise, TimeoutPromise]).finally(() => {
    clearTimeout(TimeoutId);
  });
}

async function GetModelTemplate(Name) {
  const Definition = ModelDefinitions[Name];
  if (!Definition) throw new Error(`Unknown model ${Name}`);

  if (!ModelCache.has(Name)) {
    const Pending = (async () => {
      const Gltf = await LoadModelWithTimeout(Name, Definition);
      const Fixture = Gltf.scene;
      PrepareModel(Name, Fixture);

      if (!Definition.SupportModel) return Fixture;

      const SupportTemplate = await GetModelTemplate(Definition.SupportModel);
      return ComposeSupportedFixture(Name, Fixture, SupportTemplate);
    })().catch(Error => {
      ModelCache.delete(Name);
      throw Error;
    });

    ModelCache.set(Name, Pending);
  }

  return ModelCache.get(Name);
}

function AddModelCollision(Chunk, Entry, Model) {
  if (!Chunk || !Entry || !Model?.isObject3D) return null;

  const Bounds = Footprint(
    Entry.Model,
    Number(Entry.X) || 0,
    Number(Entry.Z) || 0,
    Number(Entry.Rotation) || 0,
    0.02
  );

  const Collision = {
    Box: Bounds.clone(),
    OriginalBox: Bounds.clone(),
    OriginalLegacyBox: Bounds.clone(),
    ChunkId: Chunk.Id,
    Type: `${Entry.Model}SpawnFootprintR44`,
    Active: Boolean(Chunk.Active),
    CollisionObject: Model,
    SourceModel: Model,
    LayoutSlot: Entry.Slot,
    SpawnCollisionR44: true
  };

  Chunk.CollisionEntries.push(Collision);
  if (Chunk.Active && !CollisionBoxes.includes(Collision)) CollisionBoxes.push(Collision);
  return Collision;
}

function RenderBatchYield() {
  return WaitForWorkSlice();
}

function BatchMaterialSignature(Material) {
  if (!Material || Array.isArray(Material)) return "";
  const Color = Material.color?.isColor ? Material.color.getHexString() : "";
  const Emissive = Material.emissive?.isColor ? Material.emissive.getHexString() : "";
  const Map = Material.map?.uuid || "";
  const NormalMap = Material.normalMap?.uuid || "";
  const RoughnessMap = Material.roughnessMap?.uuid || "";
  const MetalnessMap = Material.metalnessMap?.uuid || "";
  return [
    Material.type,
    Color,
    Emissive,
    Number(Material.emissiveIntensity || 0).toFixed(3),
    Number(Material.roughness ?? -1).toFixed(3),
    Number(Material.metalness ?? -1).toFixed(3),
    Number(Material.opacity ?? 1).toFixed(3),
    Number(Material.alphaTest ?? 0).toFixed(3),
    Number(Material.side ?? 0),
    Number(Material.blending ?? 0),
    Map,
    NormalMap,
    RoughnessMap,
    MetalnessMap
  ].join(":");
}

function CanBatchStaticMesh(Mesh) {
  if (!Mesh?.isMesh || Mesh.isInstancedMesh || Mesh.isSkinnedMesh || !Mesh.geometry || !Mesh.material) return false;
  if (Array.isArray(Mesh.material)) return false;
  if (Mesh.morphTargetInfluences?.length) return false;
  if (Mesh.material.transparent && Number(Mesh.material.opacity ?? 1) < 0.995) return false;
  if (Mesh.userData?.NoRenderBatchR104) return false;
  return true;
}

function StaticBatchRoots(Chunk) {
  const Roots = [];
  const Seen = new Set();
  const Add = Root => {
    if (!Root?.isObject3D || !Root.parent || Seen.has(Root)) return;
    if (Root.name === "StoreTask") return;
    Seen.add(Root);
    Roots.push(Root);
  };

  for (const Model of Chunk.Models || []) Add(Model);
  for (const Object of Chunk.Group?.children || []) {
    if (
      Object?.userData?.RetailImportedR79 ||
      Object?.userData?.RetailSellableR84 ||
      Object?.userData?.ShelfStockR83
    ) Add(Object);
  }

  return Roots;
}

function StaticBatchSpatialKey(Root, Chunk) {
  const Side = Number(Root.position?.x || 0) < 0 ? "L" : "R";
  const Depth = Number(Root.position?.z || 0) < Number(Chunk.CenterZ || 0) ? "F" : "B";
  return `${Side}${Depth}`;
}

function FreezeStaticRoot(Root) {
  Root.traverse(Object => {
    if (!Object?.isObject3D) return;
    Object.updateMatrix();
    Object.matrixAutoUpdate = false;
  });
}

async function OptimizeChunkStaticRender(Chunk) {
  if (
    !Chunk?.Group ||
    Chunk.Cancelled ||
    Chunk.Group.userData?.StaticRenderBatchedR104
  ) return false;

  await RenderBatchYield();
  if (!Chunk?.Group || Chunk.Cancelled) return false;

  const Roots = StaticBatchRoots(Chunk);
  if (!Roots.length) {
    Chunk.Group.userData.StaticRenderBatchedR104 = true;
    return true;
  }

  Chunk.Group.updateWorldMatrix(true, true);
  const ChunkInverse = new THREE.Matrix4().copy(Chunk.Group.matrixWorld).invert();
  const Groups = new Map();

  for (let RootIndex = 0; RootIndex < Roots.length; RootIndex += 1) {
    const Root = Roots[RootIndex];
    Root.updateWorldMatrix(true, true);
    Root.traverse(Mesh => {
      if (!CanBatchStaticMesh(Mesh) || Mesh.visible === false) return;
      const SpatialKey = StaticBatchSpatialKey(Root, Chunk);
      const Signature = `${SpatialKey}|${Mesh.geometry.uuid}|${BatchMaterialSignature(Mesh.material)}`;
      let Group = Groups.get(Signature);
      if (!Group) {
        Group = {
          Geometry: Mesh.geometry,
          Material: Mesh.material,
          Meshes: []
        };
        Groups.set(Signature, Group);
      }
      Group.Meshes.push(Mesh);
    });

    if (RootIndex > 0 && RootIndex % 2 === 0) await RenderBatchYield();
  }

  let BatchIndex = 0;
  let SourceMeshCount = 0;
  const LocalMatrix = new THREE.Matrix4();

  let GroupIndex = 0;
  for (const Group of Groups.values()) {
    GroupIndex += 1;
    if (Group.Meshes.length < 2) continue;

    const Batch = new THREE.InstancedMesh(
      Group.Geometry,
      Group.Material,
      Group.Meshes.length
    );
    Batch.name = `StaticFurnitureBatchR104-${Chunk.Index}-${BatchIndex++}`;
    Batch.userData.ChunkId = Chunk.Id;
    Batch.userData.RenderBatchR104 = true;
    Batch.userData.DecorationNoCollision = true;
    Batch.castShadow = false;
    Batch.receiveShadow = false;
    Batch.frustumCulled = true;

    for (let Index = 0; Index < Group.Meshes.length; Index += 1) {
      const Mesh = Group.Meshes[Index];
      Mesh.updateWorldMatrix(true, false);
      LocalMatrix.multiplyMatrices(ChunkInverse, Mesh.matrixWorld);
      Batch.setMatrixAt(Index, LocalMatrix);
      Mesh.visible = false;
      Mesh.userData.RenderBatchedSourceR104 = true;
      SourceMeshCount += 1;
    }

    Batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    Batch.instanceMatrix.needsUpdate = true;
    Batch.computeBoundingBox?.();
    Batch.computeBoundingSphere?.();
    Batch.updateMatrix();
    Batch.matrixAutoUpdate = false;
    Chunk.Group.add(Batch);

    if (GroupIndex % 2 === 0) await RenderBatchYield();
  }

  for (let RootIndex = 0; RootIndex < Roots.length; RootIndex += 1) {
    FreezeStaticRoot(Roots[RootIndex]);
    if (RootIndex > 0 && RootIndex % 4 === 0) await RenderBatchYield();
  }

  Chunk.Group.userData.StaticRenderBatchedR104 = true;
  Chunk.Group.userData.StaticRenderBatchCountR104 = BatchIndex;
  Chunk.Group.userData.StaticRenderSourceMeshCountR104 = SourceMeshCount;
  return BatchIndex > 0;
}

function SpawnLayoutModel(Chunk, Entry) {
  const Pending = GetModelTemplate(Entry.Model)
    .then(Template => ScheduleGenerationWork(() => {
      if (Chunk.Cancelled) return null;

      const Existing = (Chunk.Models || []).find(Model =>
        Model?.parent &&
        String(Model.userData?.LayoutSlot || "") === String(Entry.Slot || "")
      );
      if (Existing) return Existing;

      const Model = Template.clone(true);
      Model.position.x += Entry.X;
      Model.position.z += Entry.Z;
      Model.rotation.y = Number(Entry.Rotation) || 0;
      Model.name = Entry.Model;
      Model.userData.ChunkId = Chunk.Id;
      Model.userData.LayoutSlot = Entry.Slot;
      Model.userData.LayoutAuthority = Chunk.Layout.Authority;
      Model.userData.SpawnShapeChecked = true;
      Chunk.Group.add(Model);
      Chunk.Models.push(Model);
      AddModelCollision(Chunk, Entry, Model);
      LoadedDisplays += 1;
      return Model;
    }))
    .catch(Error => {
      console.warn(`Could not load planned ${Entry.Model} in ${Entry.Slot}`, Error);
      return null;
    });
  Chunk.PendingLoads.push(Pending);
  return Pending;
}

function PlacedLayoutSlots(Chunk) {
  const Slots = new Set();

  Chunk.Group?.traverse?.(Object => {
    const Slot = String(Object?.userData?.LayoutSlot || "");
    if (Slot) Slots.add(Slot);
  });

  for (const Object of Chunk.TaskObjects || []) {
    const Slot = String(Object?.userData?.LayoutSlot || "");
    if (Slot) Slots.add(Slot);
  }

  return Slots;
}

async function EnsureBaseLayoutModels(Chunk, Attempts = 3) {
  if (!Chunk?.Layout || Chunk.Cancelled) return false;

  for (let Attempt = 0; Attempt < Math.max(1, Attempts); Attempt += 1) {
    const Placed = PlacedLayoutSlots(Chunk);
    const Missing = (Chunk.Layout.Base || []).filter(Entry => !Placed.has(String(Entry.Slot || "")));
    if (!Missing.length) return true;

    window.__STORE_SET_BOOT_DETAIL__?.(
      `Aisle ${Chunk.Index + 1} • retrying ${Missing.length} missing base furniture item${Missing.length === 1 ? "" : "s"}`
    );

    const Results = await Promise.all(Missing.map(Entry => SpawnLayoutModel(Chunk, Entry)));
    if (Results.every(Boolean)) {
      const After = PlacedLayoutSlots(Chunk);
      if (Missing.every(Entry => After.has(String(Entry.Slot || "")))) return true;
    }

    await new Promise(Resolve => setTimeout(Resolve, 120));
  }

  return (Chunk.Layout.Base || []).every(Entry =>
    PlacedLayoutSlots(Chunk).has(String(Entry.Slot || ""))
  );
}

function EnsureStaticLayoutObjects(Chunk) {
  if (!Chunk?.Layout || !Chunk.Group || Chunk.Cancelled) return false;

  let Placed = PlacedLayoutSlots(Chunk);

  for (const Entry of Chunk.Layout.Rugs || []) {
    if (Placed.has(String(Entry.Slot || ""))) continue;
    AddPlannedRug(Chunk, Entry);
    Placed.add(String(Entry.Slot || ""));
  }

  for (const Entry of Chunk.Layout.Partitions || []) {
    if (Placed.has(String(Entry.Slot || ""))) continue;

    const Wall = Box(
      "ShowroomPartition",
      new THREE.Vector3(0.15, 2.25, Entry.Length),
      new THREE.Vector3(Entry.X, 1.125, Entry.Z),
      WallMaterial,
      Chunk,
      true
    );
    const Cap = Box(
      "PartitionCap",
      new THREE.Vector3(0.23, 0.07, Entry.Length + 0.08),
      new THREE.Vector3(Entry.X, 2.285, Entry.Z),
      TrimMaterial,
      Chunk
    );
    const Base = Box(
      "PartitionBase",
      new THREE.Vector3(0.22, 0.11, Entry.Length + 0.06),
      new THREE.Vector3(Entry.X, 0.055, Entry.Z),
      TrimMaterial,
      Chunk
    );

    for (const Object of [Wall, Cap, Base]) {
      Object.userData.LayoutSlot = Entry.Slot;
      Object.userData.LayoutAuthority = Chunk.Layout.Authority;
    }

    Placed.add(String(Entry.Slot || ""));
  }

  if (
    Chunk.Layout.Task &&
    !Placed.has(String(Chunk.Layout.Task.Slot || ""))
  ) {
    AddTask(Chunk, Chunk.Layout.Task);
    Placed.add(String(Chunk.Layout.Task.Slot || ""));
  }

  return true;
}

function CreateRugTexture(Chunk, Entry) {
  const Palettes = [
    ["#5b4335", "#d1aa79", "#2e2824"],
    ["#364b4d", "#9fc0b7", "#243033"],
    ["#4b3d50", "#bca0c2", "#302733"],
    ["#4d4938", "#c9b77d", "#302e26"],
    ["#3d4841", "#9fb8a8", "#28302c"],
    ["#4a3b34", "#c59670", "#2d2521"]
  ];

  const Variant = Math.abs(Math.trunc(Number(Entry.Variant) || 0));
  const PaletteIndex = Math.floor(
    SeededRandom(Chunk.Seed + Variant * 17 + 31) * Palettes.length
  );
  const StripeVariant = Variant % 4;
  const CacheKey = `${PaletteIndex}:${StripeVariant}`;

  let TextureCanvas = RugCanvasCache.get(CacheKey);

  if (!TextureCanvas) {
    const [Base, Accent, Dark] = Palettes[PaletteIndex];
    const Size = 256;
    const StripeOffset = StripeVariant * 13;

    TextureCanvas = document.createElement("canvas");
    TextureCanvas.width = Size;
    TextureCanvas.height = Size;
    const Context = TextureCanvas.getContext("2d", { alpha: false });

    Context.fillStyle = Base;
    Context.fillRect(0, 0, Size, Size);

    Context.globalAlpha = 0.24;
    Context.strokeStyle = Accent;
    Context.lineWidth = 1;
    for (let Axis = 0; Axis <= Size; Axis += 5) {
      Context.beginPath();
      Context.moveTo(Axis, 0);
      Context.lineTo(Axis, Size);
      Context.stroke();

      Context.beginPath();
      Context.moveTo(0, Axis);
      Context.lineTo(Size, Axis);
      Context.stroke();
    }

    Context.globalAlpha = 0.34;
    Context.strokeStyle = Dark;
    Context.lineWidth = 5;
    for (let Stripe = -Size; Stripe < Size * 2; Stripe += 54) {
      Context.beginPath();
      Context.moveTo(Stripe + StripeOffset, 0);
      Context.lineTo(Stripe + Size + StripeOffset, Size);
      Context.stroke();
    }

    Context.globalAlpha = 0.18;
    Context.strokeStyle = Accent;
    Context.lineWidth = 2;
    for (let Stripe = -Size; Stripe < Size * 2; Stripe += 54) {
      Context.beginPath();
      Context.moveTo(Stripe + 18 - StripeOffset, Size);
      Context.lineTo(Stripe + Size + 18 - StripeOffset, 0);
      Context.stroke();
    }

    // Fibers are generated once per reusable pattern instead of once per rug.
    const FiberSeed =
      7000 +
      PaletteIndex * 1009 +
      StripeVariant * 313;
    for (let Dot = 0; Dot < 420; Dot += 1) {
      const X = SeededRandom(FiberSeed + Dot * 3 + 1) * Size;
      const Y = SeededRandom(FiberSeed + Dot * 3 + 2) * Size;
      const Alpha =
        0.025 +
        SeededRandom(FiberSeed + Dot * 3 + 3) * 0.055;
      Context.fillStyle =
        `rgba(255,245,225,${Alpha.toFixed(3)})`;
      Context.fillRect(X, Y, 1, 1);
    }

    Context.globalAlpha = 1;
    RugCanvasCache.set(CacheKey, TextureCanvas);
  }

  const Texture = new THREE.CanvasTexture(TextureCanvas);
  Texture.wrapS = THREE.RepeatWrapping;
  Texture.wrapT = THREE.RepeatWrapping;
  Texture.repeat.set(
    Math.max(3, Entry.Width * 1.45),
    Math.max(3, Entry.Depth * 1.45)
  );
  Texture.colorSpace = THREE.SRGBColorSpace;
  Texture.anisotropy = Math.min(
    4,
    Renderer.capabilities.getMaxAnisotropy()
  );

  return Texture;
}

function CreateRugMaterial(Chunk, Entry) {
  const Texture = CreateRugTexture(Chunk, Entry);
  return new THREE.MeshStandardMaterial({
    map: Texture,
    color: 0xffffff,
    roughness: 0.97,
    metalness: 0,
    side: THREE.FrontSide
  });
}

function AddPlannedRug(Chunk, Entry) {
  const Thickness = 0.078;
  const Material = CreateRugMaterial(Chunk, Entry);
  const Rug = Box(
    `ShowroomRug-${Entry.Slot}`,
    new THREE.Vector3(Entry.Width, Thickness, Entry.Depth),
    new THREE.Vector3(Entry.X, Thickness * 0.5 + 0.003, Entry.Z),
    Material,
    Chunk
  );

  Rug.userData.LayoutSlot = Entry.Slot;
  Rug.userData.LayoutAuthority = Chunk.Layout.Authority;
  Rug.userData.DecorationKind = "Rug";
  Rug.userData.DecorationNoCollision = true;
  Rug.userData.WalkableCarpetR87 = true;
  Rug.userData.RugThickness = Thickness;
  return Rug;
}

function AddTask(Chunk, Entry) {
  if (!Entry) return null;
  const Group = new THREE.Group();
  Group.name = "StoreTask";
  Group.position.set(Entry.X, 0, Entry.Z);
  Group.rotation.y = Number(Entry.Rotation) || 0;
  Group.userData.ChunkId = Chunk.Id;
  Group.userData.LayoutSlot = Entry.Slot;
  Group.userData.LayoutAuthority = Chunk.Layout.Authority;
  const Base = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.92, 0.28), TaskMetalMaterial);
  Base.position.y = 0.46;
  Group.add(Base);
  const Screen = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.035), TaskGlowMaterial.clone());
  Screen.position.set(0, 0.62, 0.16);
  Group.add(Screen);
  const Handle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 0.06), TrimMaterial);
  Handle.position.set(0.16, 0.32, 0.17);
  Group.add(Handle);
  Chunk.Group.add(Group);
  Chunk.TaskObjects.push(Group);
  const Labels = { breaker: "Reset the breaker", manifest: "Check the stock manifest", scanner: "Scan the damaged inventory" };
  const Task = {
    Id: `${Chunk.Id}:${Entry.Type}`,
    ChunkId: Chunk.Id,
    ChunkIndex: Chunk.Index,
    Type: Entry.Type,
    Label: Labels[Entry.Type],
    Object: Group,
    Screen,
    Completed: false
  };
  Chunk.TaskRecords.push(Task);
  Chunk.Tasks.push(Task.Id);
  return Task;
}

function ApplyLayoutReservations(Chunk) {
  Chunk.ReservedBounds.length = 0;
  for (const Reservation of Chunk.Layout?.Reservations || []) {
    const Bounds = Reservation.Bounds;
    if (!Bounds) continue;
    const Box = new THREE.Box3(
      new THREE.Vector3(Bounds.MinX, 0, Bounds.MinZ),
      new THREE.Vector3(Bounds.MaxX, 2.6, Bounds.MaxZ)
    );
    Box.userData = { LayoutSlot: Reservation.Slot, LayoutKind: Reservation.Kind };
    Chunk.ReservedBounds.push(Box);
  }
}

function PopulateFromLayout(Chunk) {
  for (const Rug of Chunk.Layout?.Rugs || []) AddPlannedRug(Chunk, Rug);
  for (const Entry of Chunk.Layout?.Base || []) SpawnLayoutModel(Chunk, Entry);
  if (Chunk.Layout?.Task) AddTask(Chunk, Chunk.Layout.Task);
}

function CreatePreparedChunk(Index) {
  const Id = `Chunk-${Index}`;
  const CenterZ = ChunkCenterZ(Index);
  const TopZ = ChunkTopZ(Index);
  const BottomZ = ChunkBottomZ(Index);
  const Seed = ChunkSeed(Index);
  const Theme = Themes[Math.floor(SeededRandom(Seed + 11.17) * Themes.length)];
  const Layout = CreateChunkLayout({ Index, Seed, Theme, CenterZ, TopZ, BottomZ });
  const Group = new THREE.Group();
  Group.name = Id;
  Group.userData.ChunkId = Id;
  Group.userData.LayoutTemplate = Layout.Template;
  Group.userData.LayoutAuthority = Layout.Authority;
  const Chunk = {
    Id, Index, Theme, Seed, CenterZ, TopZ, BottomZ, Layout, Group,
    Models: [], Lights: [], Tasks: [], TaskObjects: [], TaskRecords: [], ExternalObjects: [],
    CollisionEntries: [], StructureBounds: [], ReservedBounds: [], PendingLoads: [],
    Ready: false, Active: false, Cancelled: false
  };

  Box("Floor", new THREE.Vector3(34, 0.16, CHUNK_LENGTH + 0.25), new THREE.Vector3(0, -0.08, CenterZ), FloorMaterial, Chunk);
  Box("Ceiling", new THREE.Vector3(34, 0.14, CHUNK_LENGTH + 0.25), new THREE.Vector3(0, CEILING_HEIGHT, CenterZ), CeilingMaterial, Chunk);
  Box("WallLeft", new THREE.Vector3(0.20, 3.8, CHUNK_LENGTH + 0.25), new THREE.Vector3(-STORE_HALF_WIDTH, 1.86, CenterZ), WallMaterial, Chunk, true);
  Box("WallRight", new THREE.Vector3(0.20, 3.8, CHUNK_LENGTH + 0.25), new THREE.Vector3(STORE_HALF_WIDTH, 1.86, CenterZ), WallMaterial, Chunk, true);
  Box("BaseboardLeft", new THREE.Vector3(0.25, 0.18, CHUNK_LENGTH + 0.25), new THREE.Vector3(-16.87, 0.09, CenterZ), TrimMaterial, Chunk);
  Box("BaseboardRight", new THREE.Vector3(0.25, 0.18, CHUNK_LENGTH + 0.25), new THREE.Vector3(16.87, 0.09, CenterZ), TrimMaterial, Chunk);

  ApplyLayoutReservations(Chunk);
  for (const Entry of Layout.Partitions || []) {
    const Wall = Box("ShowroomPartition", new THREE.Vector3(0.15, 2.25, Entry.Length), new THREE.Vector3(Entry.X, 1.125, Entry.Z), WallMaterial, Chunk, true);
    const Cap = Box("PartitionCap", new THREE.Vector3(0.23, 0.07, Entry.Length + 0.08), new THREE.Vector3(Entry.X, 2.285, Entry.Z), TrimMaterial, Chunk);
    const Base = Box("PartitionBase", new THREE.Vector3(0.22, 0.11, Entry.Length + 0.06), new THREE.Vector3(Entry.X, 0.055, Entry.Z), TrimMaterial, Chunk);
    for (const Object of [Wall, Cap, Base]) {
      Object.userData.LayoutSlot = Entry.Slot;
      Object.userData.LayoutAuthority = Layout.Authority;
    }
  }

  for (const Offset of [-9.0, 0, 9.0]) AddLightFixture(Chunk, 0, CenterZ + Offset, SeededRandom(Seed + Offset * 3) > 0.88);
  for (const Offset of [-7.5, 7.5]) {
    AddLightFixture(Chunk, -9.0, CenterZ + Offset, SeededRandom(Seed + Offset * 4) > 0.84);
    AddLightFixture(Chunk, 9.0, CenterZ - Offset, SeededRandom(Seed + Offset * 5) > 0.84);
  }

  PopulateFromLayout(Chunk);

  if (Layout.ValidationErrors.length) {
    console.warn(`Layout ${Layout.Template} for ${Id} skipped invalid slots`, Layout.ValidationErrors);
  }
  return Chunk;
}

function PrepareChunk(Index) {
  const Active = ActiveChunks.get(Index);
  if (Active?.Ready && !Active.Cancelled) return Promise.resolve(Active);

  const InFlight = PreparingChunks.get(Index);
  if (InFlight) return InFlight;

  const Prepared = PreparedChunks.get(Index);
  if (Prepared?.Ready && !Prepared.Cancelled) return Promise.resolve(Prepared);

  if (Prepared && (!Prepared.Ready || Prepared.Cancelled)) {
    PreparedChunks.delete(Index);
    if (Prepared.Cancelled) ReleaseChunkReferences(Prepared);
  }

  const PromiseValue = ScheduleGenerationWork(() => CreatePreparedChunk(Index))
    .then(async Chunk => {
      if (!Chunk || Chunk.Cancelled) return null;

      const Results = await Promise.allSettled(Chunk.PendingLoads);
      if (Chunk.Cancelled) return null;

      Chunk.LoadFailures = Results.filter(Result => Result.status === "rejected").length;
      Chunk.Ready = true;
      PreparedChunks.set(Index, Chunk);

      if (!window.__STORE_BOOT_CRITICAL__) {
        queueMicrotask(() => {
          window.__STORE_PRESENTATION_READY_R83__?.FinalizeChunk?.(Chunk);
        });
      }

      return Chunk;
    })
    .catch(Error => {
      const Stale = PreparedChunks.get(Index);
      if (Stale && !Stale.Ready) {
        PreparedChunks.delete(Index);
        ReleaseChunkReferences(Stale);
      }
      throw Error;
    })
    .finally(() => PreparingChunks.delete(Index));

  PreparingChunks.set(Index, PromiseValue);
  return PromiseValue;
}

function CollectMaterialTextures(Material, Output) {
  if (!Material) return;

  for (const Key of [
    "map",
    "alphaMap",
    "aoMap",
    "bumpMap",
    "normalMap",
    "displacementMap",
    "roughnessMap",
    "metalnessMap",
    "emissiveMap",
    "lightMap"
  ]) {
    const Texture = Material[Key];
    if (!Texture?.isTexture || StreamWarmTextures.has(Texture)) continue;
    StreamWarmTextures.add(Texture);
    Output.push(Texture);
  }
}

function WaitForGpuWarmBudget(MinimumMs = 7) {
  return new Promise(Resolve => {
    if (!("requestIdleCallback" in window)) {
      requestAnimationFrame(() => Resolve());
      return;
    }

    const TryIdle = () => {
      requestIdleCallback(Deadline => {
        if (Deadline.didTimeout || Deadline.timeRemaining() >= MinimumMs) {
          Resolve();
          return;
        }
        TryIdle();
      }, { timeout: 900 });
    };

    TryIdle();
  });
}

async function WarmChunkTextures(Chunk) {
  const Textures = [];

  Chunk.Group.traverse(Object => {
    if (!Object?.isMesh || !Object.material) return;
    const Materials = Array.isArray(Object.material)
      ? Object.material
      : [Object.material];

    for (const Material of Materials) {
      CollectMaterialTextures(Material, Textures);
    }
  });

  // Upload only a couple of textures per idle slice. GPU texture upload can be
  // synchronous on some browsers/drivers and was still capable of a frame hitch.
  for (let Index = 0; Index < Textures.length; Index += 2) {
    await WaitForGpuWarmBudget(7);

    for (
      let BatchIndex = Index;
      BatchIndex < Math.min(Index + 2, Textures.length);
      BatchIndex += 1
    ) {
      try {
        Renderer.initTexture?.(Textures[BatchIndex]);
      } catch {}
    }
  }
}

async function WarmChunkGpu(Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled) return false;
  if (Chunk.Group.userData?.GpuWarmReadyR92) return true;
  if (Chunk.GpuWarmPromise) return Chunk.GpuWarmPromise;

  // Boot chunks may already be visible by the time presentation loads.
  if (Chunk.Active || Chunk.Group.parent === Scene) {
    Chunk.Group.userData.GpuWarmReadyR92 = true;
    return true;
  }

  Chunk.GpuWarmPromise = (async () => {
    await WaitForGpuWarmBudget();
    if (Chunk.Cancelled || !Chunk.Group) return false;

    await WarmChunkTextures(Chunk);

    await WaitForGpuWarmBudget(8);
    if (Chunk.Cancelled || !Chunk.Group) return false;

    const PreviousParent = Chunk.Group.parent;
    try {
      StreamWarmScene.add(Chunk.Group);

      if (typeof Renderer.compileAsync === "function") {
        await Renderer.compileAsync(StreamWarmScene, Camera);
      } else {
        Renderer.compile(StreamWarmScene, Camera);
      }
    } catch (Error) {
      console.warn(`GPU warm-up skipped for ${Chunk.Id}`, Error);
    } finally {
      StreamWarmScene.remove(Chunk.Group);
      if (
        PreviousParent &&
        PreviousParent !== StreamWarmScene &&
        !Chunk.Cancelled
      ) {
        PreviousParent.add(Chunk.Group);
      }
    }

    if (!Chunk.Cancelled && Chunk.Group) {
      Chunk.Group.userData.GpuWarmReadyR92 = true;
      Chunk.Group.userData.GpuWarmReadyAt = performance.now();
    }

    return !Chunk.Cancelled;
  })().finally(() => {
    Chunk.GpuWarmPromise = null;
  });

  return Chunk.GpuWarmPromise;
}

function ActivateChunk(Chunk) {
  if (!Chunk || Chunk.Cancelled || !Chunk.Ready || Chunk.Active) return false;

  const TraversalGateEnabled =
    window.__STORE_REQUIRE_TRAVERSAL_READY__ === true;
  const TraversalReady = Boolean(
    Chunk.Group?.userData?.TraversalReadyR83 ||
    Chunk.Group?.userData?.PresentationReadyR83
  );

  if (TraversalGateEnabled && (!TraversalReady || !Chunk.Group?.userData?.PresentationReadyR83)) return false;

  const GpuWarmRequired =
    TraversalGateEnabled &&
    typeof Renderer.compileAsync === "function";
  if (
    GpuWarmRequired &&
    !Chunk.Group?.userData?.GpuWarmReadyR92
  ) {
    WarmChunkGpu(Chunk).catch(() => {});
    return false;
  }

  PreparedChunks.delete(Chunk.Index);
  Chunk.Active = true;
  Scene.add(Chunk.Group);
  for (const Object of Chunk.ExternalObjects) Scene.add(Object);
  for (const Entry of Chunk.CollisionEntries) {
    if (Entry.Active) continue;
    Entry.Active = true;
    CollisionBoxes.push(Entry);
  }
  for (const Task of Chunk.TaskRecords) Tasks.set(Task.Id, Task);
  ActiveChunks.set(Chunk.Index, Chunk);
  return true;
}

function ReleaseChunkReferences(Chunk) {
  if (!Chunk) return;

  Chunk.Group?.traverse?.(Object => {
    if (Object?.isInstancedMesh && Object.userData?.RenderBatchR104) {
      Object.dispose?.();
    }
  });

  // Geometry/material resources are shared with ModelCache, so do not dispose
  // them here. Remove scene/object references so old aisles can be collected.
  Chunk.Group?.clear?.();
  for (const Object of Chunk.ExternalObjects || []) Object?.parent?.remove?.(Object);

  for (const Key of [
    "Models",
    "Lights",
    "Tasks",
    "TaskObjects",
    "TaskRecords",
    "ExternalObjects",
    "CollisionEntries",
    "StructureBounds",
    "ReservedBounds",
    "PendingLoads"
  ]) {
    if (Array.isArray(Chunk[Key])) Chunk[Key].length = 0;
  }

  Chunk.Layout = null;
  Chunk.Cancelled = true;
  Chunk.Ready = false;
}

function DeactivateChunk(Index, KeepPrepared = true) {
  const Chunk = ActiveChunks.get(Index);
  if (!Chunk) return;

  Scene.remove(Chunk.Group);
  for (const Object of Chunk.ExternalObjects || []) Scene.remove(Object);
  for (const Task of Chunk.TaskRecords || []) Tasks.delete(Task.Id);

  for (let CollisionIndex = CollisionBoxes.length - 1; CollisionIndex >= 0; CollisionIndex -= 1) {
    if (CollisionBoxes[CollisionIndex].ChunkId === Chunk.Id) CollisionBoxes.splice(CollisionIndex, 1);
  }
  for (const Entry of Chunk.CollisionEntries || []) Entry.Active = false;

  for (let ChildIndex = Scene.children.length - 1; ChildIndex >= 0; ChildIndex -= 1) {
    const Child = Scene.children[ChildIndex];
    if (
      Child.userData?.ChunkId === Chunk.Id &&
      Child !== Chunk.Group &&
      !(Chunk.ExternalObjects || []).includes(Child)
    ) {
      Scene.remove(Child);
    }
  }

  Chunk.Active = false;
  ActiveChunks.delete(Index);

  if (KeepPrepared && !Chunk.Cancelled) {
    PreparedChunks.set(Index, Chunk);
  } else {
    PreparedChunks.delete(Index);
    ReleaseChunkReferences(Chunk);
  }
}

function DropPreparedChunk(Index) {
  const Chunk = PreparedChunks.get(Index);
  if (!Chunk) return;
  PreparedChunks.delete(Index);
  ReleaseChunkReferences(Chunk);
}

function RequestChunk(Index) {
  const Prepared = PreparedChunks.get(Index);
  if (Prepared?.Ready) return Promise.resolve(Prepared);
  return PrepareChunk(Index);
}

function TryActivateIndex(Index) {
  if (ActiveChunks.has(Index)) return true;
  const Prepared = PreparedChunks.get(Index);
  return Prepared?.Ready ? ActivateChunk(Prepared) : false;
}

function UpdateStreamFrustum() {
  Camera.updateMatrixWorld(true);
  StreamProjectionView.multiplyMatrices(
    Camera.projectionMatrix,
    Camera.matrixWorldInverse
  );
  StreamFrustum.setFromProjectionMatrix(StreamProjectionView);
  Camera.getWorldDirection(StreamCameraForward);
  StreamCameraForward.y = 0;
  if (StreamCameraForward.lengthSq() <= 0.000001) {
    StreamCameraForward.set(0, 0, -1);
  } else {
    StreamCameraForward.normalize();
  }
}

function ChunkDistance(Chunk) {
  if (!Chunk) return Infinity;
  return Math.abs((Number(Chunk.CenterZ) || 0) - Camera.position.z);
}

function ChunkIntersectsView(Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled) return false;
  StreamChunkBounds.min.set(
    -STORE_HALF_WIDTH - 1.2,
    -0.5,
    Chunk.BottomZ - 0.6
  );
  StreamChunkBounds.max.set(
    STORE_HALF_WIDTH + 1.2,
    CEILING_HEIGHT + 0.8,
    Chunk.TopZ + 0.6
  );
  return StreamFrustum.intersectsBox(StreamChunkBounds);
}

function MarkViewedChunks(Now) {
  UpdateStreamFrustum();
  for (const Chunk of ActiveChunks.values()) {
    if (!Chunk?.Group || Chunk.Cancelled) continue;
    if (ChunkDistance(Chunk) > VIEW_KEEP_DISTANCE) continue;
    if (!ChunkIntersectsView(Chunk)) continue;
    Chunk.StreamViewedAt = Now;
  }
}

function IsChunkViewProtected(Chunk, Now) {
  if (!Chunk?.Group || Chunk.Cancelled) return false;
  if (
    ChunkDistance(Chunk) <= VIEW_KEEP_DISTANCE &&
    ChunkIntersectsView(Chunk)
  ) {
    Chunk.StreamViewedAt = Now;
    return true;
  }
  const LastViewedAt = Number(Chunk.StreamViewedAt) || -Infinity;
  return Now - LastViewedAt <= VIEW_KEEP_HOLD_MS;
}

function IsStructuralStreamObject(Object) {
  if (!Object) return true;
  if (Object.isLight) return true;
  if (Object.userData?.WalkableCarpetR87) return true;
  if (Object.userData?.StreamLoadingR83) return true;
  if (Object.userData?.RenderBatchedSourceR104) return true;

  const Name = String(Object.name || "");
  return /^(Floor|Ceiling|WallLeft|WallRight|Baseboard|ShowroomPartition|PartitionCap|PartitionBase|RearStoreClosureR80|RearStoreWallR80|RearStoreBaseboardR80)/i.test(Name);
}

function IsPersistentCollisionRenderRoot(Object) {
  if (!Object) return true;
  if (Object.name === "StoreTask") return true;

  const Data = Object.userData || {};
  return Boolean(
    Data.StreamAmbientR101 ||
    Data.StreamLoadingR83
  );
}

function StreamableRoots(Chunk) {
  const Children = Chunk?.Group?.children || [];
  const Stamp = Children.length;
  if (
    Array.isArray(Chunk.StreamableRootsR101) &&
    Chunk.StreamableRootsStampR101 === Stamp
  ) {
    return Chunk.StreamableRootsR101;
  }

  const Roots = [];
  for (const Object of Children) {
    if (IsStructuralStreamObject(Object)) continue;
    if (IsPersistentCollisionRenderRoot(Object)) continue;
    Roots.push(Object);
  }

  Chunk.StreamableRootsR101 = Roots;
  Chunk.StreamableRootsStampR101 = Stamp;
  return Roots;
}

function SetObjectStreamCulled(Object, Culled) {
  if (!Object) return;
  const Next = Boolean(Culled);
  const Current = Boolean(Object.userData?.ObjectStreamCulledR101);
  if (Current === Next) return;

  Object.userData.ObjectStreamCulledR101 = Next;
  if (Next) {
    Object.userData.ObjectStreamWasVisibleR101 = Object.visible !== false;
    Object.visible = false;
  } else if (Object.userData.ObjectStreamWasVisibleR101 !== false) {
    Object.visible = true;
  }
}

function ObjectStreamBounds(Object) {
  let Bounds = Object.userData?.ObjectStreamBoundsR103;
  if (Bounds?.isBox3) return Bounds;

  Object.updateWorldMatrix(true, true);
  Bounds = new THREE.Box3().setFromObject(Object);

  if (Bounds.isEmpty()) {
    Object.getWorldPosition(StreamObjectPosition);
    Bounds.setFromCenterAndSize(
      StreamObjectPosition,
      StreamObjectSize.set(1.2, 1.2, 1.2)
    );
  } else {
    Bounds.getSize(StreamObjectSize);
    const Padding = THREE.MathUtils.clamp(
      StreamObjectSize.length() * 0.08,
      0.65,
      2.4
    );
    Bounds.expandByScalar(Padding);
  }

  Object.userData.ObjectStreamBoundsR103 = Bounds;
  return Bounds;
}

function ObjectIntersectsView(Object) {
  const Bounds = ObjectStreamBounds(Object);
  return Bounds?.isBox3 ? StreamFrustum.intersectsBox(Bounds) : false;
}

function UpdateObjectStreaming(Now = performance.now(), Force = false) {
  if (!Force && Now - LastObjectStreamAt < OBJECT_STREAM_INTERVAL_MS) return;

  UpdateStreamFrustum();

  if (!Force && HasObjectStreamCameraState) {
    const PositionMoved = LastObjectStreamCameraPosition.distanceToSquared(Camera.position);
    const DirectionChanged = LastObjectStreamCameraForward.dot(StreamCameraForward);
    if (PositionMoved < 0.18 && DirectionChanged > 0.994) {
      LastObjectStreamAt = Now;
      return;
    }
  }

  LastObjectStreamAt = Now;
  HasObjectStreamCameraState = true;
  LastObjectStreamCameraPosition.copy(Camera.position);
  LastObjectStreamCameraForward.copy(StreamCameraForward);

  for (const Chunk of ActiveChunks.values()) {
    if (!Chunk?.Group || Chunk.Cancelled || Chunk.Group.parent !== Scene) continue;
    if (!Chunk.Group.userData?.PresentationReadyR83) continue;

    for (const Object of StreamableRoots(Chunk)) {
      if (!Object?.parent) continue;

      const Bounds = ObjectStreamBounds(Object);
      Bounds.getCenter(StreamObjectPosition);

      StreamToObject.copy(StreamObjectPosition).sub(Camera.position);
      StreamToObject.y = 0;
      const DistanceSq = StreamToObject.lengthSq();
      const IsPriceTag = Boolean(Object.userData?.CompactPriceAuthorityR83);

      if (
        IsPriceTag &&
        DistanceSq > PRICE_TAG_STREAM_DISTANCE * PRICE_TAG_STREAM_DISTANCE
      ) {
        SetObjectStreamCulled(Object, true);
        continue;
      }

      const VisibleNow = StreamFrustum.intersectsBox(Bounds);

      if (
        VisibleNow ||
        DistanceSq <= OBJECT_STREAM_NEAR_DISTANCE * OBJECT_STREAM_NEAR_DISTANCE
      ) {
        SetObjectStreamCulled(Object, false);
        continue;
      }

      const Distance = Math.sqrt(Math.max(0.000001, DistanceSq));
      const Dot = (
        StreamToObject.x * StreamCameraForward.x +
        StreamToObject.z * StreamCameraForward.z
      ) / Distance;

      const Culled = Boolean(Object.userData?.ObjectStreamCulledR101);
      if (Culled) {
        const PreView =
          Dot > -0.28 ||
          Distance <= OBJECT_STREAM_NEAR_DISTANCE + 12;

        if (PreView) SetObjectStreamCulled(Object, false);
        continue;
      }

      const DeepBehind =
        Distance > OBJECT_STREAM_NEAR_DISTANCE + 12 &&
        Dot < -0.48;
      const FarOutsideView =
        Distance > OBJECT_STREAM_FAR_DISTANCE &&
        Dot < 0.06;

      if (DeepBehind || FarOutsideView) {
        SetObjectStreamCulled(Object, true);
      }
    }
  }
}

function RestoreChunkStreamObjects(Chunk) {
  for (const Object of StreamableRoots(Chunk)) {
    if (Object?.userData?.ObjectStreamCulledR101) {
      SetObjectStreamCulled(Object, false);
    }
  }
}

function UpdateChunkVisibility() {
  for (const Chunk of ActiveChunks.values()) {
    if (!Chunk?.Group) continue;
    const InView = ChunkIntersectsView(Chunk);
    const NearestZ = THREE.MathUtils.clamp(Camera.position.z, Chunk.BottomZ, Chunk.TopZ);
    const InRange = Math.abs(Camera.position.z - NearestZ) <= (Scene.fog?.far || Camera.far);
    const Visible = InView && InRange;
    Chunk.Group.visible = Visible;
    for (const Object of Chunk.ExternalObjects || []) {
      if (Object && !Object.userData?.StreamAmbientR101 && !Object.isLight) Object.visible = Visible;
    }
  }
}

function EnsureChunksAroundPlayer() {
  const CurrentIndex = Math.max(0, ChunkIndexForZ(Camera.position.z));
  const Now = performance.now();

  MarkViewedChunks(Now);
  UpdateObjectStreaming(Now);

  if (CurrentIndex === LastMaintainedChunkIndex && Now - LastChunkMaintenanceAt < 120) {
    UpdateChunkVisibility();
    return;
  }

  LastMaintainedChunkIndex = CurrentIndex;
  LastChunkMaintenanceAt = Now;
  LastChunkIndex = CurrentIndex;

  const { ActiveMin: MinIndex, ActiveMax: MaxIndex, PrepareMin, PrepareMax: PrefetchMax } = ChunkRange(CurrentIndex);
  const WantedActive = new Set();

  for (let Index = MinIndex; Index <= MaxIndex; Index += 1) {
    WantedActive.add(Index);
    if (!TryActivateIndex(Index)) {
      RequestChunk(Index).catch(Error => {
        console.warn(`Chunk ${Index} preparation failed`, Error);
      });
    }
  }

  // Prepare every index in both directions; requesting only the farthest
  // index left holes in the buffer and discarded useful returning aisles.
  for (let Offset = 1; Offset <= STREAM_RANGE.PrefetchRadius; Offset += 1) {
    for (const Index of [CurrentIndex + Offset, CurrentIndex - Offset]) {
      if (Index < PrepareMin || Index > PrefetchMax || WantedActive.has(Index)) continue;
      RequestChunk(Index).catch(() => {});
    }
  }

  for (const Index of [...ActiveChunks.keys()]) {
    if (WantedActive.has(Index)) continue;
    const Chunk = ActiveChunks.get(Index);

    const KeepPrepared =
      Index >= Math.max(0, CurrentIndex - PREPARED_BACK_CACHE) &&
      Index <= PrefetchMax;

    if (Chunk) RestoreChunkStreamObjects(Chunk);
    DeactivateChunk(Index, KeepPrepared);
  }

  for (const Index of [...PreparedChunks.keys()]) {
    const Chunk = PreparedChunks.get(Index);
    const LastViewedAt = Number(Chunk?.StreamViewedAt) || -Infinity;
    const KeepByRange =
      Index >= Math.max(0, CurrentIndex - PREPARED_BACK_CACHE) &&
      Index <= PrefetchMax;
    const KeepByRecentView = Now - LastViewedAt <= VIEW_KEEP_HOLD_MS * 2;
    if (!KeepByRange && !KeepByRecentView) DropPreparedChunk(Index);
  }

  UpdateChunkVisibility();
  UpdateObjectStreaming(Now, true);

  if (AisleCounter) {
    AisleCounter.textContent = CurrentIndex >= 0
      ? `${CurrentIndex + 1}`
      : `B${Math.abs(CurrentIndex)}`;
  }
}


let BackgroundChunkBufferToken = 0;

function ReportWorldBuffer(Ready, Total, Stage, Detail = "") {
  window.dispatchEvent(new CustomEvent("store-world-buffer-progress", {
    detail: {
      ready: Math.max(0, Number(Ready) || 0),
      total: Math.max(1, Number(Total) || 1),
      stage: String(Stage || ""),
      detail: String(Detail || "")
    }
  }));
}

async function PrepareBootBuffer(Count = STREAM_RANGE.BootCount) {
  const Total = THREE.MathUtils.clamp(Math.trunc(Number(Count) || STREAM_RANGE.BootCount), 1, STREAM_RANGE.BootCount);
  const Chunks = [];
  const Token = ++BackgroundChunkBufferToken;

  for (let Index = 0; Index < Total; Index += 1) {
    if (Token !== BackgroundChunkBufferToken) throw new Error("Boot buffer was replaced by a newer world.");

    ReportWorldBuffer(
      Index,
      Total,
      `Building aisle ${Index + 1} of ${Total}`,
      "Loading geometry and required furniture"
    );
    window.__STORE_SET_BOOT_STAGE__?.(`Building aisle ${Index + 1}/${Total} geometry and furniture • seed ${WorldSeed}`);

    const Chunk = await RequestChunk(Index);
    if (!Chunk?.Ready || Chunk.Cancelled) {
      throw new Error(`Aisle ${Index + 1} could not be prepared.`);
    }
    Chunks.push(Chunk);

    ReportWorldBuffer(
      Index,
      Total,
      `Aisle ${Index + 1} geometry ready`,
      "Waiting for showroom, collision, prices, and GPU preparation"
    );
  }

  return Chunks;
}

async function PrepareInitialWorld() {
  window.__STORE_SET_BOOT_STAGE__?.(`Building aisle 1 geometry and furniture • seed ${WorldSeed}`);

  const FirstChunk = await PrepareChunk(0);
  if (!FirstChunk) throw new Error("The first store aisle could not be prepared.");
  ActivateChunk(FirstChunk);

  ReportWorldBuffer(0, STREAM_RANGE.BootCount, "Aisle 1 geometry ready", "Finishing required nearby aisles before entry");
}

function NormalizeWorldSeed(Value) {
  const NumberValue = Number(Value);
  if (!Number.isFinite(NumberValue)) return null;
  const Seed = Math.trunc(NumberValue) >>> 0;
  return Seed || 1;
}

async function SetWorldSeed(Value) {
  const NextSeed = NormalizeWorldSeed(Value);
  if (NextSeed === null) return false;
  if (NextSeed === WorldSeed) return true;

  if (SeedResetFlight) {
    await SeedResetFlight;
    if (NextSeed === WorldSeed) return true;
  }

  SeedResetFlight = (async () => {
    const WasStarted = Started;
    Started = false;
    WorldGeneration += 1;
    window.__STORE_WORLD_GENERATION__ = WorldGeneration;
    window.__STORE_LOCK_START__?.(`Synchronizing world seed ${NextSeed} before entry.`);
    try {
      await Promise.allSettled([...PreparingChunks.values()]);

      for (const Index of [...ActiveChunks.keys()]) DeactivateChunk(Index, false);
      for (const Index of [...PreparedChunks.keys()]) DropPreparedChunk(Index);

      PreparingChunks.clear();
      CollisionBoxes.length = 0;
      Tasks.clear();
      LoadedDisplays = 0;
      CompletedTasks = 0;
      CurrentTask = null;
      LastChunkIndex = 0;
      LastObjectiveText = "";

      WorldSeed = NextSeed;
      window.__STORE_WORLD_SEED__ = WorldSeed;
      if (window.__STORE_GAME__) window.__STORE_GAME__.WorldSeed = WorldSeed;

      Camera.position.set(0, PlayerEyeHeight, 8);
      ProceduralPhysics.ResetVerticalState?.();
      window.__STORE_STRICT_MOVEMENT_VERIFIER__?.ResetLastSafe?.();
      await PrepareInitialWorld();
      ResetTaskProgress();
      window.__STORE_VISUAL_REDESIGN_R73__?.Discover?.();
      window.__STORE_RETAIL_SHOWROOM_R79__?.Discover?.();
      window.__STORE_PRESENTATION_READY_R83__?.Discover?.();

      if (typeof window.__STORE_ENSURE_START_READY__ === "function") {
        const Ready = await window.__STORE_ENSURE_START_READY__();
        if (!Ready || window.__STORE_START_GATE__?.Ready !== true) return false;
      }

      if (BootStatus) BootStatus.textContent = `Store ready — synchronized seed ${WorldSeed}.`;
      return true;
    } finally {
      Started = Boolean(WasStarted && window.__STORE_START_GATE__?.Ready);
    }
  })().finally(() => {
    SeedResetFlight = null;
  });

  return SeedResetFlight;
}

function RenderClock() {
  let Hours = Math.floor(StoreSeconds / 3600);
  const Minutes = Math.floor((StoreSeconds % 3600) / 60);
  const Suffix = Hours >= 12 ? "PM" : "AM";
  Hours %= 12;
  if (Hours === 0) Hours = 12;
  GameClock.textContent = `${Hours}:${String(Minutes).padStart(2, "0")} ${Suffix}`;
}

function UpdateClock(Delta) {
  StoreSeconds = (StoreSeconds + Delta * STORE_TIME_RATE) % DAY_SECONDS;
  RenderClock();
}

function SetStoreSeconds(Value) {
  const Seconds = Number(Value);
  if (!Number.isFinite(Seconds)) return false;
  StoreSeconds = ((Seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  RenderClock();
  return true;
}

function FindNearestPendingTask() {
  let Best = null;
  let BestDistance = Infinity;
  for (const Task of Tasks.values()) {
    if (Task.Completed || Task.ChunkIndex < LastChunkIndex - 1) continue;
    const Distance = Camera.position.distanceTo(Task.Object.getWorldPosition(new THREE.Vector3()));
    if (Distance < BestDistance) {
      Best = Task;
      BestDistance = Distance;
    }
  }
  return { Task: Best, Distance: BestDistance };
}

function UpdateObjective() {
  const { Task, Distance } = FindNearestPendingTask();
  CurrentTask = Task;
  let Text;
  if (Task) {
    const DistanceText = Number.isFinite(Distance) ? ` • ${Math.max(1, Math.round(Distance))}m` : "";
    Text = `${Task.Label}${DistanceText}`;
  } else Text = "Keep moving deeper. More aisles are already buffered ahead.";
  if (Text !== LastObjectiveText) {
    LastObjectiveText = Text;
    ObjectiveText.textContent = Text;
  }
  if (TaskCounter) TaskCounter.textContent = `${CompletedTasks}`;
}

function TaskWorldPosition(Task, Target = new THREE.Vector3()) {
  return Task.Object.getWorldPosition(Target);
}

function UpdateInteractionPrompt() {
  if (!InteractPrompt) return;
  if (!CurrentTask || CurrentTask.Completed) {
    InteractPrompt.classList.remove("Show");
    return;
  }
  const Distance = Camera.position.distanceTo(TaskWorldPosition(CurrentTask));
  if (Distance <= TASK_DISTANCE) {
    InteractPrompt.textContent = `[ E ] ${CurrentTask.Label.toUpperCase()}`;
    InteractPrompt.classList.add("Show");
  } else InteractPrompt.classList.remove("Show");
}

function ApplyTaskCompletionVisuals(Task) {
  if (!Task || Task.Completed) return false;
  Task.Completed = true;
  Task.Screen.material = Task.Screen.material.clone();
  Task.Screen.material.color.setHex(0x23522c);
  Task.Screen.material.emissive.setHex(0x36d45b);
  Task.Screen.material.emissiveIntensity = 1.9;
  const Chunk = ActiveChunks.get(Task.ChunkIndex);
  if (Task.Type === "breaker" && Chunk) {
    for (const Light of Chunk.Lights) {
      if (!Number.isFinite(Light.userData.TaskBaseIntensity)) Light.userData.TaskBaseIntensity = Light.userData.BaseIntensity;
      Light.userData.BaseIntensity = Math.max(Light.userData.BaseIntensity, 2.0);
    }
  }
  if (Task.Type === "scanner") Task.Object.rotation.y += Math.PI * 2;
  return true;
}

function SetCompletedTaskCount(Value) {
  const Count = Number(Value);
  if (!Number.isFinite(Count)) return false;
  CompletedTasks = Math.max(0, Math.floor(Count));
  if (TaskCounter) TaskCounter.textContent = `${CompletedTasks}`;
  return true;
}

function CompleteSharedTask(TaskId, TotalCompleted = CompletedTasks) {
  SetCompletedTaskCount(TotalCompleted);
  const Task = Tasks.get(String(TaskId || ""));
  if (!Task) return false;
  ApplyTaskCompletionVisuals(Task);
  if (CurrentTask === Task) CurrentTask = null;
  UpdateObjective();
  return true;
}

function ResetTaskProgress() {
  SetCompletedTaskCount(0);
  CurrentTask = null;
  const SeenChunks = new Set();
  const ResetChunk = Chunk => {
    if (!Chunk || SeenChunks.has(Chunk)) return;
    SeenChunks.add(Chunk);
    for (const Task of Chunk.TaskRecords || []) {
      Task.Completed = false;
      if (Task.Screen?.material) {
        Task.Screen.material.dispose?.();
        Task.Screen.material = TaskGlowMaterial.clone();
      }
      if (Task.Type === "breaker") {
        for (const Light of Chunk.Lights || []) {
          if (!Number.isFinite(Light.userData.TaskBaseIntensity)) continue;
          Light.userData.BaseIntensity = Light.userData.TaskBaseIntensity;
          delete Light.userData.TaskBaseIntensity;
        }
      }
      if (Task.Type === "scanner") Task.Object.rotation.y = 0;
    }
  };
  for (const Chunk of ActiveChunks.values()) ResetChunk(Chunk);
  for (const Chunk of PreparedChunks.values()) ResetChunk(Chunk);
  UpdateObjective();
  UpdateInteractionPrompt();
  return true;
}

function CompleteTask(Task) {
  if (!Task || Task.Completed) return;
  ApplyTaskCompletionVisuals(Task);
  SetCompletedTaskCount(CompletedTasks + 1);
  CurrentTask = null;
  UpdateObjective();
}

function TryInteract() {
  if (!Started || !Controls.isLocked || !CurrentTask || CurrentTask.Completed) return;
  if (Camera.position.distanceTo(TaskWorldPosition(CurrentTask)) <= TASK_DISTANCE) CompleteTask(CurrentTask);
}

function UpdateMovement(Delta) {
  if (!Controls.isLocked) return;
  let Forward = 0;
  let Right = 0;
  if (KeyState.has("KeyW")) Forward += 1;
  if (KeyState.has("KeyS")) Forward -= 1;
  if (KeyState.has("KeyD")) Right += 1;
  if (KeyState.has("KeyA")) Right -= 1;

  const Moving = Forward !== 0 || Right !== 0;
  const WantsSprint = KeyState.has("ShiftLeft") || KeyState.has("ShiftRight");
  const Speed = PlayerApi?.GetMovementSpeed?.(WantsSprint, Moving) ?? (WantsSprint && Moving ? 5.6 : 3.55);
  const Length = Math.hypot(Forward, Right) || 1;
  Forward /= Length;
  Right /= Length;

  ProceduralPhysics.MoveCharacter(
    Camera,
    Forward,
    Right,
    Moving ? Speed * Delta : 0,
    Delta,
    CollisionBoxes,
    PlayerApi?.GetPlayerRadius?.() || 0.255
  );
}

function ShowError(Message) {
  ErrorText.textContent = Message;
  ErrorPanel.classList.remove("Hidden");
}

const Ambient = new THREE.AmbientLight(0xd9d2c5, 0.82);
Scene.add(Ambient);
const Hemisphere = new THREE.HemisphereLight(0xc7d0d1, 0x30281f, 0.72);
Scene.add(Hemisphere);
const FillLight = new THREE.DirectionalLight(0xffe6c2, 0.40);
FillLight.position.set(-7, 9, 6);
Scene.add(FillLight);

window.__STORE_SET_BOOT_STAGE__?.("Building the first playable aisle...");
await PrepareInitialWorld();
window.__STORE_SET_BOOT_STAGE__?.("Attaching player controls to the world...");
PlayerApi?.Attach?.({ Scene, Camera, Renderer, CollisionBoxes });
window.__STORE_APPLY_PERFORMANCE__?.();
window.__STORE_SET_BOOT_STAGE__?.(`First aisle playable • finalizing store systems • seed ${WorldSeed}`);

let LastBootRenderAt = -Infinity;
const BOOT_RENDER_INTERVAL_MS = 125;

function Animate(Now = performance.now()) {
  requestAnimationFrame(Animate);

  if (!Started) {
    // Keep the existing loading backdrop, but don't repeatedly render an
    // unchanged camera while the GPU is needed for initial world preparation.
    if (window.__STORE_BOOT_CRITICAL__ && Number.isFinite(LastBootRenderAt)) return;
    if (Now - LastBootRenderAt < BOOT_RENDER_INTERVAL_MS) return;
    LastBootRenderAt = Now;
    UpdateStreamFrustum();
    UpdateChunkVisibility();
    Renderer.render(Scene, Camera);
    return;
  }

  const Delta = Math.min(GameTimer.getDelta(), 0.05);
  UpdateMovement(Delta);
  EnsureChunksAroundPlayer();
  UpdateChunkVisibility();
  UpdateClock(Delta);
  UpdateObjective();
  UpdateInteractionPrompt();

  if (PlayerApi?.Render) PlayerApi.Render(Renderer, Scene, Camera);
  else Renderer.render(Scene, Camera);
}

StartButton.addEventListener("click", Event => {
  if (window.__STORE_START_GATE__?.Ready !== true) {
    Event.preventDefault();
    Event.stopImmediatePropagation();
    window.__STORE_SET_BOOT_STAGE__?.(
      window.__STORE_START_GATE__?.Reason || "The current world is still generating."
    );
    return;
  }

  Started = true;
  window.__STORE_GAMEPLAY_STARTED__ = true;
  window.dispatchEvent(new CustomEvent("store-gameplay-started"));
  BootScreen.classList.remove("ScreenVisible");
  Hud.classList.remove("Hidden");
  Controls.lock();
});

Canvas.addEventListener("click", () => {
  if (Started && !Controls.isLocked) Controls.lock();
});

addEventListener("keydown", Event => {
  KeyState.add(Event.code);
  if (Event.code === "KeyE" && !Event.repeat) TryInteract();
});
addEventListener("keyup", Event => KeyState.delete(Event.code));
addEventListener("blur", () => KeyState.clear());
addEventListener("resize", () => {
  Camera.aspect = innerWidth / innerHeight;
  Camera.updateProjectionMatrix();

  if (window.__STORE_APPLY_PERFORMANCE__) {
    window.__STORE_APPLY_PERFORMANCE__();
  } else {
    Renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    Renderer.setSize(innerWidth, innerHeight, false);
  }
});
addEventListener("error", Event => ShowError(Event.message || "Unknown runtime error."));
addEventListener("unhandledrejection", Event => {
  const Reason = Event.reason;
  const Name = String(Reason?.name || "");
  const Message = String(Reason?.message || Reason || "");

  if (Name === "NotAllowedError" && /pointer\s*lock|requestPointerLock/i.test(Message)) {
    Event.preventDefault();
    return;
  }

  ShowError(Message || "Unknown loading error.");
});

const PlacementApi = {
  IsCircleSafe(X, Z, Radius, ChunkId = null) {
    for (const Entry of CollisionBoxes) {
      if (ChunkId && Entry.ChunkId !== ChunkId) continue;
      if (!/Wall|Partition/i.test(Entry.Type || "")) continue;
      const Bounds = Entry.OriginalStructureBox || Entry.OriginalBox || Entry.Box || Entry;
      if (!Bounds?.min || !Bounds?.max) continue;
      if (X + Radius > Bounds.min.x && X - Radius < Bounds.max.x && Z + Radius > Bounds.min.z && Z - Radius < Bounds.max.z) return false;
    }
    return Math.abs(X) + Radius < STORE_HALF_WIDTH - 0.18;
  },
  ShapeCastPlacement
};

window.__STORE_GAME_BUILD__ = "V0.35.49";
window.__STORE_VERSION__ = "0.35.49";
window.__STORE_GAME__ = {
  Scene,
  Camera,
  Renderer,
  CollisionBoxes,
  ActiveChunks,
  PreparedChunks,
  Tasks,
  WorldSeed,
  ChunkSeed,
  ChunkIndexForZ,
  ChunkLength: CHUNK_LENGTH,
  StreamRange: STREAM_RANGE,
  PrepareChunk,
  PrepareBootBuffer,
  EnsureBaseLayoutModels,
  EnsureStaticLayoutObjects,
  TryActivateIndex,
  UpdateObjectStreaming,
  OptimizeChunkStaticRender,
  WarmChunkGpu,
  SetStoreSeconds,
  SetCompletedTaskCount,
  CompleteSharedTask,
  ResetTaskProgress,
  SetWorldSeed,
  Placement: PlacementApi,
  RayCollisionMode: true,
  Version: "0.35.49"
};
Animate();