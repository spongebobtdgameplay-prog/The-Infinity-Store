import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const OriginalLoadAsync = GLTFLoader.prototype.loadAsync;
const SharedAssetPromises = window.__STORE_SHARED_GLTF_PROMISES__ ||= new Map();
THREE.Cache.enabled = true;

function CanonicalAssetUrl(Url) {
  try {
    return new URL(String(Url), location.href).href;
  } catch {
    return String(Url);
  }
}

function LoadSharedAsset(Loader, Url, Args = []) {
  const Key = CanonicalAssetUrl(Url);
  const Existing = SharedAssetPromises.get(Key);
  if (Existing) return Existing;

  const PromiseValue = OriginalLoadAsync.call(Loader, Url, ...Args).catch(Error => {
    SharedAssetPromises.delete(Key);
    throw Error;
  });
  SharedAssetPromises.set(Key, PromiseValue);
  return PromiseValue;
}
const AssetTimeoutMs = 9000;
const AssetRetryCount = 2;

const KayKitBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/";
const KayKitRestaurantBase = "https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Restaurant-Bits-1.0/main/addons/kaykit_restaurant_bits/Assets/gltf/";
const KhronosSampleBase = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/";
const KenneyBase = "https://raw.githubusercontent.com/dennisorlando/junction-2025/f78a38d01f3a47697ff144bfed0301df7f25c784/models/mini-market/GLB%20format/";
const IndustrialShelfUrl = "https://raw.githubusercontent.com/danielrosehill/storage-box-3d-models/main/models/SB1/SB1.glb";

const AssetUrls = [
  "https://raw.githubusercontent.com/euuuuuuan/fatal-funnel-public/main/packages/renderer/assets/models/quaternius-men/worker.glb",
  `${KhronosSampleBase}GlamVelvetSofa/glTF-Binary/GlamVelvetSofa.glb`,
  `${KhronosSampleBase}ChairDamaskPurplegold/glTF-Binary/ChairDamaskPurplegold.glb`,
  `${KayKitBase}table_medium.gltf`,
  "Models/Bedroom/GLB/Bed_King.glb",
  "Models/Bedroom/GLB/Bed_Single.glb",
  "Models/Bedroom/GLB/NightStand_2.glb",
  `${KayKitRestaurantBase}stove_multi_decorated.gltf`,
  `${KayKitRestaurantBase}kitchencounter_sink.gltf`,
  `${KayKitRestaurantBase}kitchentable_sink.gltf`,
  "Models/Bathroom/GLB/Bathroom_Bathtub.glb",
  "Models/Bathroom/GLB/Bathroom_Toilet.glb",
  "Models/Lighting/GLB/Light_Floor1.glb",
  "Models/Architecture/GLB/Door_3.glb",
  "Models/Architecture/GLB/Window_Large1.glb",
  IndustrialShelfUrl,
  `${KayKitBase}cabinet_medium.gltf`,
  `${KayKitBase}armchair_pillows.gltf`,
  `${KayKitBase}table_low.gltf`,
  `${KayKitBase}table_small.gltf`,
  `${KayKitBase}table_medium_long.gltf`,
  `${KayKitBase}rug_rectangle_stripes_A.gltf`,
  `${KayKitBase}rug_oval_A.gltf`,
  `${KayKitBase}book_set.gltf`,
  `${KayKitBase}book_single.gltf`,
  `${KayKitBase}pillow_A.gltf`,
  `${KayKitBase}pillow_B.gltf`,
  `${KayKitBase}lamp_standing.gltf`,
  `${KayKitBase}cabinet_small_decorated.gltf`,
  `${KenneyBase}shopping-cart.glb`,
  `${KenneyBase}shopping-basket.glb`,
  `${KenneyBase}shelf-bags.glb`,
  `${KenneyBase}shelf-boxes.glb`
];

const TrackedAssets = new Set(AssetUrls);
const AssetPromises = new Map();
const AssetStates = new Map();
const ActiveAssets = new Set();
let NextAssetIndex = 0;
let LastAssetUrl = "";

function Mix32(Value) {
  let NumberValue = Value >>> 0;
  NumberValue ^= NumberValue >>> 16;
  NumberValue = Math.imul(NumberValue, 0x7feb352d);
  NumberValue ^= NumberValue >>> 15;
  NumberValue = Math.imul(NumberValue, 0x846ca68b);
  NumberValue ^= NumberValue >>> 16;
  return NumberValue >>> 0;
}

function HashText(Text) {
  let Hash = 2166136261 >>> 0;
  for (let Index = 0; Index < Text.length; Index += 1) {
    Hash ^= Text.charCodeAt(Index);
    Hash = Math.imul(Hash, 16777619);
  }
  return Mix32(Hash);
}

function ResolveWorldSeed() {
  const Parameters = new URLSearchParams(location.search);
  const RequestedSeed = Parameters.get("seed");

  if (RequestedSeed !== null && RequestedSeed.trim() !== "") {
    const Trimmed = RequestedSeed.trim();
    const Numeric = Number(Trimmed);
    const Seed = Number.isSafeInteger(Numeric) ? Mix32(Numeric) : HashText(Trimmed);
    return { Seed: Seed || 1, Source: "URL" };
  }

  const Preset = Number(window.__STORE_WORLD_SEED__);
  if (Number.isSafeInteger(Preset) && Preset > 0) {
    return {
      Seed: Preset >>> 0,
      Source: String(window.__STORE_WORLD_SEED_SOURCE__ || "PRESET")
    };
  }

  const Values = new Uint32Array(1);
  crypto.getRandomValues(Values);
  return { Seed: (Values[0] >>> 0) || 1, Source: "SOLO_RANDOM" };
}

const World = ResolveWorldSeed();
window.__STORE_WORLD_SEED__ = World.Seed;
window.__STORE_WORLD_SEED_SOURCE__ = World.Source;
window.__STORE_WORLD_SEED_BUILD__ = "V0.35.36-SEED";

function AssetLabel(Url) {
  if (!Url) return "";
  let FileName = String(Url);
  try {
    const Parsed = new URL(Url, location.href);
    FileName = decodeURIComponent(Parsed.pathname.split("/").pop() || Url);
  } catch {
    FileName = String(Url).split("/").pop() || String(Url);
  }

  const Value = String(Url);
  if (/\/Bedroom\//i.test(Value)) return `Bedroom • ${FileName}`;
  if (/\/Kitchen\//i.test(Value) || /Restaurant-Bits/i.test(Value)) return `Kitchen • ${FileName}`;
  if (/\/Bathroom\//i.test(Value)) return `Bathroom • ${FileName}`;
  if (/\/Lighting\//i.test(Value)) return `Lighting • ${FileName}`;
  if (/\/Architecture\//i.test(Value)) return `Architecture • ${FileName}`;
  if (/GlamVelvetSofa|ChairDamaskPurplegold|Furniture-Bits/i.test(Value)) return `Furniture • ${FileName}`;
  if (/mini-market/i.test(Value)) return `Store fixture • ${FileName}`;
  if (/worker\.glb/i.test(Value)) return `Player model • ${FileName}`;
  if (/SB1\.glb/i.test(Value)) return `Storage shelf • ${FileName}`;
  return FileName;
}

function DispatchProgress() {
  let Loaded = 0;
  let Failed = 0;
  // Count only the declared warm-up manifest. Runtime-only assets must not
  // inflate the boot percentage above 100%.
  for (const Url of AssetUrls) {
    const State = AssetStates.get(Url);
    if (State === "loaded") Loaded += 1;
    else if (State === "failed") Failed += 1;
  }

  const Settled = Loaded + Failed;
  const Total = AssetUrls.length;
  const Percent = Total > 0 ? Math.round((Loaded / Total) * 100) : 100;
  const ActiveList = [...ActiveAssets];
  const CurrentAsset = ActiveList.length ? ActiveList[ActiveList.length - 1] : "";
  const FailedAssetLabels = [];
  for (const [Url, State] of AssetStates) {
    if (State === "failed") FailedAssetLabels.push(AssetLabel(Url));
  }

  const Detail = {
    loaded: Loaded,
    failed: Failed,
    settled: Settled,
    total: Total,
    percent: Percent,
    currentAsset: CurrentAsset,
    currentAssetLabel: AssetLabel(CurrentAsset),
    lastAssetLabel: AssetLabel(LastAssetUrl),
    failedAssetLabels: FailedAssetLabels,
    background: true
  };

  const PercentNode = document.getElementById("BootAssetPercent");
  const FillNode = document.getElementById("BootAssetProgressFill");
  const AssetNode = document.getElementById("BootAssetName");
  const CountNode = document.getElementById("BootAssetCounts");

  if (PercentNode) PercentNode.textContent = `${Percent}%`;
  if (FillNode) FillNode.style.width = `${Percent}%`;

  if (AssetNode) {
    if (Detail.currentAssetLabel) AssetNode.textContent = `Loading: ${Detail.currentAssetLabel}`;
    else if (Failed > 0 && Settled >= Total) {
      AssetNode.textContent = `Asset warm-up failed: ${Detail.failedAssetLabels.join(", ")}`;
    } else if (Settled >= Total) AssetNode.textContent = "Asset warm-up complete";
    else AssetNode.textContent = LastAssetUrl ? `Processed: ${Detail.lastAssetLabel}` : "Preparing first asset...";
  }

  if (CountNode) {
    CountNode.textContent =
      `${Settled}/${Total} checked • ${Loaded} loaded` +
      (Failed ? ` • ${Failed} skipped` : "");
  }

  window.__STORE_PRELOAD_PROGRESS__ = Detail;
  window.dispatchEvent(new CustomEvent("store-preload-progress", { detail: Detail }));
}

function LoadWithTimeout(Url, Loader, Args) {
  const SourcePromise = LoadSharedAsset(Loader, Url, Args);
  let TimeoutId = 0;

  const TimeoutPromise = new Promise((_, Reject) => {
    TimeoutId = setTimeout(() => {
      Reject(new Error(`Asset load timed out after ${AssetTimeoutMs}ms: ${Url}`));
    }, AssetTimeoutMs);
  });

  return Promise.race([SourcePromise, TimeoutPromise]).finally(() => {
    clearTimeout(TimeoutId);
  });
}

function GetOrStartAsset(Url, Loader, Args = []) {
  if (AssetPromises.has(Url)) return AssetPromises.get(Url);

  ActiveAssets.add(Url);
  LastAssetUrl = Url;
  if (!AssetStates.has(Url)) AssetStates.set(Url, "loading");
  DispatchProgress();

  const PromiseValue = LoadWithTimeout(Url, Loader, Args)
    .then(Result => {
      AssetStates.set(Url, "loaded");
      return Result;
    })
    .catch(Error => {
      AssetStates.set(Url, "failed");
      AssetPromises.delete(Url);
      console.warn("Background warm-up skipped " + Url, Error);
      throw Error;
    })
    .finally(() => {
      ActiveAssets.delete(Url);
      DispatchProgress();
    });

  AssetPromises.set(Url, PromiseValue);
  return PromiseValue;
}

GLTFLoader.prototype.loadAsync = function(Url, ...Args) {
  return GetOrStartAsset(Url, this, Args);
};

function BackgroundYield() {
  return new Promise(Resolve => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => Resolve(), { timeout: 350 });
    } else {
      setTimeout(Resolve, 40);
    }
  });
}

function RetryDelay(Milliseconds) {
  return new Promise(Resolve => setTimeout(Resolve, Milliseconds));
}

async function WarmAsset(Url, Loader) {
  for (let Attempt = 0; Attempt <= AssetRetryCount; Attempt += 1) {
    try {
      await GetOrStartAsset(Url, Loader);
      return true;
    } catch (Error) {
      if (Attempt >= AssetRetryCount) return false;
      AssetStates.set(Url, "retrying");
      DispatchProgress();
      await RetryDelay(140 * (Attempt + 1));
    }
  }

  return false;
}

async function BackgroundWorker() {
  const Loader = new GLTFLoader();

  while (NextAssetIndex < AssetUrls.length) {
    await BackgroundYield();
    const AssetIndex = NextAssetIndex;
    NextAssetIndex += 1;
    if (AssetIndex >= AssetUrls.length) break;
    await WarmAsset(AssetUrls[AssetIndex], Loader);
  }
}

let PreloadCompletion = null;

function StartAssetWarmup() {
  if (PreloadCompletion) return PreloadCompletion;

  window.__STORE_PRELOAD_RESULT__ = "warming";
  PreloadCompletion = BackgroundWorker().then(() => {
    DispatchProgress();
    const Detail = window.__STORE_PRELOAD_PROGRESS__ || {};
    const Success = Detail.loaded === Detail.total && Detail.failed === 0;
    window.__STORE_PRELOAD_RESULT__ = Success ? "finished" : "failed";
    window.dispatchEvent(new CustomEvent("store-preload-complete", { detail: Detail }));
    return Detail;
  });

  window.__STORE_PRELOAD_COMPLETE__ = PreloadCompletion;
  return PreloadCompletion;
}

window.__STORE_PRELOAD_PROMISES__ = AssetPromises;
window.__STORE_PRELOAD_RESULT__ = "tracking";
window.__STORE_PRELOAD_BUILD__ = "V0.35.75-SHARED-ASSET-CACHE";
window.__STORE_START_ASSET_WARMUP__ = StartAssetWarmup;
window.__STORE_PRELOAD_COMPLETE__ = null;
DispatchProgress();
