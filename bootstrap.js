const Cache = "20260906-v03555-loader-architecture1";
const Version = "0.35.55";
const FaviconVersion = "20260824-4";
const FaviconLinks = [
  { rel: "icon", type: "image/png", sizes: "32x32", href: `favicon_io/favicon-32x32.png?v=${FaviconVersion}` },
  { rel: "icon", type: "image/png", sizes: "16x16", href: `favicon_io/favicon-16x16.png?v=${FaviconVersion}` },
  { rel: "apple-touch-icon", sizes: "180x180", href: `favicon_io/apple-touch-icon.png?v=${FaviconVersion}` },
  { rel: "manifest", href: `favicon_io/site.webmanifest?v=${FaviconVersion}` }
];

document.title = "The Infinity Store";
const PromoEyebrow = document.querySelector("#BootScreen .Eyebrow");
if (PromoEyebrow) PromoEyebrow.remove();
const StoreTitle = document.querySelector("#BootScreen h1");
if (StoreTitle) StoreTitle.innerHTML = "THE INFINITY<br>STORE";

document.head.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[data-store-icon="1"]').forEach(Link => Link.remove());
for (const LinkData of FaviconLinks) {
  const Link = document.createElement("link");
  Link.setAttribute("data-store-icon", "1");
  for (const [Property, Value] of Object.entries(LinkData)) Link.setAttribute(Property, Value);
  document.head.appendChild(Link);
}

const BuildVersion = document.getElementById("BuildVersion");
if (BuildVersion) BuildVersion.textContent = `BUILD V${Version}`;
window.__STORE_VERSION__ = Version;
window.__STORE_BOOT_CRITICAL__ = true;

const BootStatus = document.getElementById("BootStatus");
const BootStageLabel = document.getElementById("BootStageLabel");
const BootWorldPercent = document.getElementById("BootWorldPercent");
const BootWorldProgressFill = document.getElementById("BootWorldProgressFill");
const BootWorldCounts = document.getElementById("BootWorldCounts");

const StartGate = {
  Ready: false,
  WorldReady: false,
  AssetsReady: false,
  CoreReady: false,
  Generation: 0,
  Reason: "Loading store"
};

window.__STORE_START_GATE__ = StartGate;

function Clamp(Value, Min, Max) {
  return Math.min(Max, Math.max(Min, Value));
}

function SetBootStage(Text) {
  const Value = String(Text || "");
  if (BootStatus) BootStatus.textContent = Value;
  if (BootStageLabel) BootStageLabel.textContent = Value;
  window.__STORE_BOOT_STAGE__ = Value;
  window.dispatchEvent(new CustomEvent("store-boot-stage", { detail: { stage: Value } }));
}

window.__STORE_SET_BOOT_STAGE__ = SetBootStage;

let LastWorldReady = 0;
let LastWorldTotal = 4;

function SetWorldProgress(Ready, Total, Stage = "", Detail = "") {
  const SafeTotal = Math.max(1, Number(Total) || 1);
  const SafeReady = Clamp(Number(Ready) || 0, 0, SafeTotal);
  const Percent = Math.round((SafeReady / SafeTotal) * 100);
  LastWorldReady = Math.max(0, Math.floor(SafeReady));
  LastWorldTotal = Math.max(1, Math.floor(SafeTotal));

  if (BootWorldPercent) BootWorldPercent.textContent = `${Percent}%`;
  if (BootWorldProgressFill) BootWorldProgressFill.style.width = `${Percent}%`;
  if (BootWorldCounts) {
    BootWorldCounts.textContent =
      `Required aisles: ${Math.floor(SafeReady)}/${SafeTotal} ready` +
      (Detail ? ` • ${Detail}` : "");
  }
  if (Stage) SetBootStage(Stage);
}

window.addEventListener("store-world-buffer-progress", Event => {
  const Detail = Event.detail || {};
  SetWorldProgress(Detail.ready, Detail.total, Detail.stage, Detail.detail);
});

window.__STORE_SET_BOOT_DETAIL__ = Text => {
  if (!BootWorldCounts) return;
  BootWorldCounts.textContent =
    `Required aisles: ${LastWorldReady}/${LastWorldTotal} ready` +
    (Text ? ` • ${String(Text)}` : "");
};

function StartButtonNode() {
  return document.getElementById("StartButton");
}

function CurrentWorldActuallyReady() {
  if (!StartGate.WorldReady) return false;

  const Game = window.__STORE_GAME__;
  const Presentation = window.__STORE_PRESENTATION_READY_R83__;
  if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Presentation?.StrictReadinessReport) return false;

  for (let Index = 0; Index < 4; Index += 1) {
    const Chunk = Game.ActiveChunks.get(Index) || Game.PreparedChunks.get(Index);
    if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return false;
    const Report = Presentation.StrictReadinessReport(Chunk);
    if (!Report?.Ready) return false;
  }

  return true;
}

function RefreshStartGate() {
  const CurrentGeneration = Number(window.__STORE_WORLD_GENERATION__) || 0;
  const WorldReadyNow = CurrentWorldActuallyReady();

  StartGate.Ready = Boolean(
    StartGate.CoreReady &&
    WorldReadyNow &&
    StartGate.Generation === CurrentGeneration
  );

  const Button = StartButtonNode();
  if (Button) {
    const ShouldDisable = !StartGate.Ready;
    const AriaValue = StartGate.Ready ? "false" : "true";
    const ReadyValue = StartGate.Ready ? "1" : "0";

    if (Button.disabled !== ShouldDisable) Button.disabled = ShouldDisable;
    if (Button.getAttribute("aria-disabled") !== AriaValue) Button.setAttribute("aria-disabled", AriaValue);
    if (Button.dataset.storeStartReady !== ReadyValue) Button.dataset.storeStartReady = ReadyValue;
    Button.style.opacity = StartGate.Ready ? "" : "0.42";
    Button.style.cursor = StartGate.Ready ? "" : "not-allowed";
    Button.style.filter = StartGate.Ready ? "" : "grayscale(.35)";
  }

  return StartGate.Ready;
}

function LockStart(Reason = "World is still loading") {
  StartGate.WorldReady = false;
  StartGate.Ready = false;
  StartGate.Generation = Number(window.__STORE_WORLD_GENERATION__) || 0;
  StartGate.Reason = String(Reason || "World is still loading");
  RefreshStartGate();

  const BootScreen = document.getElementById("BootScreen");
  const Hud = document.getElementById("Hud");
  BootScreen?.classList.add("ScreenVisible");
  Hud?.classList.add("Hidden");
}

function MarkWorldReady(Generation) {
  const CurrentGeneration = Number(window.__STORE_WORLD_GENERATION__) || 0;
  if (Number(Generation) !== CurrentGeneration) return false;
  StartGate.Generation = CurrentGeneration;
  StartGate.WorldReady = true;
  StartGate.Reason = "";
  return RefreshStartGate();
}

window.__STORE_LOCK_START__ = LockStart;

document.addEventListener("click", Event => {
  const Target = Event.target?.closest?.("#StartButton");
  if (!Target || StartGate.Ready) return;
  Event.preventDefault();
  Event.stopImmediatePropagation();
  RefreshStartGate();
  SetBootStage(StartGate.Reason || "The store is still generating.");
}, true);

const StartButtonObserver = new MutationObserver(() => {
  if (!StartGate.Ready) RefreshStartGate();
});
const InitialStartButton = StartButtonNode();
if (InitialStartButton) {
  StartButtonObserver.observe(InitialStartButton, {
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled"]
  });
}

LockStart("Generating the playable store before entry.");
SetBootStage("Starting store services...");

async function OptionalImport(Path, Label) {
  try {
    return await import(`${Path}?v=${Cache}`);
  } catch (Error) {
    console.warn(`${Label} unavailable; continuing without it.`, Error);
    return null;
  }
}

function ShowBootError(Error) {
  const Message = String(Error?.message || Error || "Unknown boot error.");
  StartGate.CoreReady = false;
  StartGate.WorldReady = false;
  StartGate.Ready = false;
  StartGate.Reason = "Store loading failed.";
  RefreshStartGate();

  const Panel = document.getElementById("ErrorPanel");
  const Text = document.getElementById("ErrorText");
  if (Text) Text.textContent = Message;
  if (Panel) Panel.classList.remove("Hidden");
  SetBootStage(`Load failed • ${Message}`);
}

let CoreReady = false;
let AccountReadyPromise = null;
let AssetWarmupPromise = null;

async function EnsureCurrentWorldReady() {
  const Game = window.__STORE_GAME__;
  const Presentation = window.__STORE_PRESENTATION_READY_R83__;
  if (!Game?.PrepareBootBuffer || !Presentation?.WaitForPresentationReady) {
    throw new Error("World readiness systems are unavailable.");
  }

  const Generation = Number(window.__STORE_WORLD_GENERATION__) || 0;
  LockStart("Finishing the current world before entry.");

  const BootBufferCount = 4;
  const BootChunks = await Game.PrepareBootBuffer(BootBufferCount);

  for (let Index = 0; Index < BootChunks.length; Index += 1) {
    if ((Number(window.__STORE_WORLD_GENERATION__) || 0) !== Generation) {
      throw new Error("World changed while the start buffer was being prepared.");
    }

    const Chunk = BootChunks[Index];
    SetWorldProgress(
      Index,
      BootBufferCount,
      `Finishing aisle ${Index + 1}/${BootBufferCount}`,
      "Generating actual merchandise, prices, collision, and GPU state"
    );

    const Ready = await Presentation.WaitForPresentationReady(Chunk, 30000);
    if (!Ready) {
      const Failure = Chunk.Group?.userData?.StrictBootFailureR49;
      const Missing = Array.isArray(Failure?.Missing) && Failure.Missing.length
        ? ` Missing: ${Failure.Missing.join(", ")}.`
        : "";
      throw new Error(`Aisle ${Index + 1} did not finish before the boot deadline.${Missing}`);
    }

    const Report = Presentation.StrictReadinessReport?.(Chunk);
    if (!Report?.Ready) {
      throw new Error(`Aisle ${Index + 1} failed strict generation verification.`);
    }

    SetWorldProgress(
      Index + 1,
      BootBufferCount,
      `Aisle ${Index + 1}/${BootBufferCount} complete`,
      `real objects ${Report.Placed}/${Report.Planned} • prices ${Report.Tags}/${Report.Sellable} • GPU ready`
    );
  }

  if ((Number(window.__STORE_WORLD_GENERATION__) || 0) !== Generation) {
    throw new Error("World changed before the start gate could unlock.");
  }

  MarkWorldReady(Generation);
  return true;
}

window.__STORE_ENSURE_START_READY__ = EnsureCurrentWorldReady;

try {
  SetBootStage("Loading account system in background...");
  await import(`./multiplayer.js?v=${Cache}`);

  const Multiplayer = window.__STORE_MULTIPLAYER__;
  if (!Multiplayer?.WaitForAccount) throw new Error("Account system did not initialize.");

  AccountReadyPromise = Promise.resolve(Multiplayer.WaitForAccount());
  window.__STORE_ACCOUNT_READY_PROMISE__ = AccountReadyPromise;
  window.__STORE_ACCOUNT_READY__ = false;

  const HasSavedSession = Boolean(localStorage.getItem("InfinityStoreSessionV1"));
  if (HasSavedSession) {
    const AccountOverlay = document.getElementById("StoreAccountOverlay");
    if (AccountOverlay) AccountOverlay.hidden = true;
  }

  AccountReadyPromise
    .then(() => {
      window.__STORE_ACCOUNT_READY__ = true;
      window.__STORE_ACCOUNT_DEFERRED__ = false;
    })
    .catch(Error => {
      window.__STORE_ACCOUNT_READY__ = false;
      window.__STORE_ACCOUNT_ERROR__ = String(Error?.message || Error || "ACCOUNT_FAILED");
    });

  setTimeout(() => {
    if (!window.__STORE_ACCOUNT_READY__) window.__STORE_ACCOUNT_DEFERRED__ = true;
  }, 3000);

  SetBootStage("Starting asset warm-up now...");
  await import(`./loading-prewarm-r38.js?v=${Cache}`);

  const StartAssetWarmup = window.__STORE_START_ASSET_WARMUP__;
  if (typeof StartAssetWarmup !== "function") {
    throw new Error("Asset warm-up owner is unavailable.");
  }

  AssetWarmupPromise = Promise.resolve(StartAssetWarmup());
  window.__STORE_BACKGROUND_ASSET_WARMUP__ = AssetWarmupPromise;
  AssetWarmupPromise
    .then(Result => {
      const Loaded = Number(Result?.loaded) || 0;
      const Total = Number(Result?.total) || 0;
      const Failed = Number(Result?.failed) || 0;
      StartGate.AssetsReady = Total > 0 && Loaded === Total && Failed === 0;
      window.__STORE_ASSET_WARMUP_READY__ = StartGate.AssetsReady;
      RefreshStartGate();
    })
    .catch(Error => {
      StartGate.AssetsReady = false;
      window.__STORE_ASSET_WARMUP_READY__ = false;
      console.warn("Background asset warm-up did not fully finish", Error);
    });

  SetBootStage("Loading interface and performance systems...");
  await OptionalImport("./three-text-utility-r73.js", "3D text utility");
  await import(`./idle-budget-r72.js?v=${Cache}`);
  await import(`./single-menu-pre-r24.js?v=${Cache}`);
  await OptionalImport("./world-enhancements-r13.js", "World enhancements");
  await OptionalImport("./performance-manager.js", "Settings and performance manager");

  SetBootStage("Loading collision and procedural physics...");
  await import(`./collision-utility.js?v=${Cache}`);
  await import(`./procedural-physics-utility.js?v=${Cache}`);
  await import(`./surface-contact-utility-r17.js?v=${Cache}`);

  SetBootStage("Loading player controller and animation...");
  await import(`./player-controller.js?v=${Cache}`);
  await import(`./player-system-r24.js?v=${Cache}`);
  await OptionalImport("./sprint-animation-rate-r40.js", "Sprint animation cadence");
  await import(`./animation-motion-authority-r18.js?v=${Cache}`);
  await OptionalImport("./first-person-fullbody-r32.js", "First-person full body");

  SetBootStage("Building the first playable aisle...");
  await import(`./game.js?v=${Cache}`);
  window.__STORE_VERSION__ = Version;
  window.__STORE_GAME_BUILD__ = `V${Version}`;

  SetBootStage("Connecting multiplayer systems to the store...");
  await Multiplayer.AttachGame();

  SetBootStage("Loading aisle streaming and showroom systems...");
  await OptionalImport("./forward-generation-r78.js", "Forward-only infinite generation");
  await import(`./pointer-lock-runtime-r19.js?v=${Cache}`);
  await import(`./world-polish-r72.js?v=${Cache}`);
  await OptionalImport("./generator-integrity-r77.js", "Exact generated-object placement");
  await OptionalImport("./store-visual-stable-r83.js", "Stable 3D showroom dressing");
  await OptionalImport("./visible-materials-r77.js", "Targeted near-black material correction");
  await OptionalImport("./render-distance-lighting-r74.js", "Stable long-distance store lighting");
  await OptionalImport("./retail-showroom-r79.js", "Imported retail showroom models and light variation");
  await OptionalImport("./store-finish-r80.js", "Rear closure and merchandising walls");
  await OptionalImport("./retail-zones-r82.js", "Real cart, bag and large-rug retail zones");
  await OptionalImport("./retail-sale-displays-r84.js", "Rug-backed couches and organized sale islands");
  await OptionalImport("./retail-organization-r83.js", "Organized cart and bag bays");
  await OptionalImport("./shelf-stock-r83.js", "Stocked showroom shelves");
  await OptionalImport("./price-tag-authority-r83.js", "Single-version compact item prices");
  await OptionalImport("./surface-step-animation-r87.js", "Dedicated carpet step animation utility");
  await OptionalImport("./core-fix-authority-r86.js", "Exact furniture collision, ghost cleanup and walkable carpets");
  await OptionalImport("./distance-haze-r82.js", "Stable distance haze");
  await OptionalImport("./presentation-ready-r83.js", "Stable off-screen chunk presentation gate");
  await OptionalImport("./stream-loading-cover-r83.js", "Opaque streamed-aisle loading cover");

  await EnsureCurrentWorldReady();

  SetBootStage("Finalizing movement contact and the main menu...");
  await import(`./movement-contact-compat-r25.js?v=${Cache}`);
  await OptionalImport("./final-contact-r19.js", "Final limb contact");
  await OptionalImport("./runtime-main-menu-r83.js", "Start-screen style resumable main menu");

  CoreReady = true;
  StartGate.CoreReady = true;
  window.__STORE_BOOT_CRITICAL__ = false;
  RefreshStartGate();
  Multiplayer.NotifyCoreReady?.();
} catch (Error) {
  window.__STORE_BOOT_CRITICAL__ = false;
  console.error("Core store boot failed.", Error);
  ShowBootError(Error);
}

const ReadyButton = document.getElementById("StartButton");
if (ReadyButton && CoreReady && RefreshStartGate()) {
  ReadyButton.style.opacity = "";
  ReadyButton.style.cursor = "";
  const Seed = Number(window.__STORE_WORLD_SEED__) || 0;
  const Assets = window.__STORE_PRELOAD_PROGRESS__;
  const AssetSummary = Assets
    ? `${Assets.loaded || 0}/${Assets.total || 0} assets warmed in background`
    : "asset warm-up running in background";
  SetWorldProgress(
    4,
    4,
    `Ready to enter • playable world complete • seed ${Seed}`,
    AssetSummary
  );
}

window.__STORE_BOOTSTRAP_BUILD__ = `V${Version}`;
