const Game = window.__STORE_GAME__;
if (!Game?.PreparedChunks || !Game?.ActiveChunks) throw new Error("Game must load before presentation gating.");

const Finalizing = new WeakSet();
const Stability = new WeakMap();
const PendingFinalization = new WeakMap();
const PolishPending = new WeakSet();
const FinalizationQueue = [];
let FinalizationRunning = false;
let DiscoverFlight = null;
const FurnitureNames = new Set([
  "Couch_Large1", "Couch_L", "Chair_2", "Table_RoundLarge", "Bed_King", "Bed_Single",
  "NightStand_2", "Shelf_Large", "Bookshelf", "Kitchen_Cabinet1", "Kitchen_Fridge",
  "Kitchen_Oven", "Kitchen_Sink", "Bathroom_Sink", "Bathroom_Bathtub", "Bathroom_Toilet", "Light_Floor1"
]);
const RetailNames = new Set([
  "RetailArmchairR79", "RetailLivingShelfR79", "RetailBedroomCabinetR79", "RetailBedroomChairR79",
  "RetailStorageShelfR79", "RetailStorageCabinetR79", "RetailDisplayCabinetR79"
]);

function SellableCount(Chunk) {
  const AuthorityCount = window.__STORE_COMPACT_PRICE_TAGS_R83__?.CountSellable?.(Chunk);
  if (Number.isFinite(AuthorityCount)) return AuthorityCount;
  let Count = 0;
  for (const Model of Chunk.Models || []) if (Model?.parent && FurnitureNames.has(Model.name)) Count += 1;
  for (const Object of Chunk.Group?.children || []) {
    if (Object?.parent !== Chunk.Group) continue;
    if (Object.userData?.RetailSellableR84) Count += 1;
    else if (Object.userData?.RetailImportedR79 && RetailNames.has(Object.name)) Count += 1;
  }
  return Count;
}

function UpdateStability(Chunk) {
  const Count = SellableCount(Chunk);
  const Now = performance.now();
  let State = Stability.get(Chunk);
  if (!State) {
    State = { Count, ChangedAt: Now };
    Stability.set(Chunk, State);
  } else if (State.Count !== Count) {
    State.Count = Count;
    State.ChangedAt = Now;
  }
  return { Count, StableFor: Now - State.ChangedAt };
}

function CompactTagCount(Chunk) {
  return window.__STORE_COMPACT_PRICE_TAGS_R83__?.CountTags?.(Chunk) ?? 0;
}

function HasVisibleLegacyPriceSign(Chunk) {
  let Found = false;
  Chunk.Group?.traverse?.(Object => {
    if (Found || !Object?.visible) return;
    const Name = String(Object.name || "");
    if (Name.startsWith("FurniturePriceSignR72") || Name.startsWith("FurniturePriceSignR73")) Found = true;
    if (Name.startsWith("FurnitureItemSignR74-") || Name.startsWith("FurnitureItemSignR80-")) Found = true;
  });
  return Found;
}

function PartitionsFinished(Chunk) {
  let Total = 0;
  let Finished = 0;
  Chunk.Group?.traverse?.(Object => {
    if (Object?.name !== "ShowroomPartition") return;
    Total += 1;
    if (Object.userData?.MerchandisingWallR80) Finished += 1;
  });
  return Total === Finished;
}

function RearFinished(Chunk) {
  if (Chunk.Index !== 0) return true;
  return Boolean(
    !Chunk.Group.getObjectByName("RearStoreWallR80") &&
    !Chunk.Group.getObjectByName("RearStoreBaseboardR80")
  );
}

function RemoveTerminalBeacons(Chunk) {
  for (const Task of Chunk.TaskRecords || []) {
    const Root = Task?.Object;
    if (!Root?.traverse) continue;
    const Remove = [];
    Root.traverse(Object => {
      if (!Object?.isMesh) return;
      if (String(Object.geometry?.type || "") === "SphereGeometry") Remove.push(Object);
    });
    for (const Object of Remove) Object.parent?.remove(Object);
    Root.userData.NoBeaconR83 = true;
  }
}

function DirectChildForSlot(Chunk, Slot, Predicate) {
  return (Chunk.Group?.children || []).some(Object =>
    Object?.parent === Chunk.Group &&
    String(Object.userData?.LayoutSlot || "") === String(Slot || "") &&
    Predicate(Object)
  );
}

function EntryPresent(Chunk, GroupName, Entry) {
  const Slot = String(Entry?.Slot || "");
  if (!Slot) return false;

  if (GroupName === "Base") {
    return (Chunk.Models || []).some(Model =>
      Model?.parent &&
      String(Model.userData?.LayoutSlot || "") === Slot
    );
  }

  if (GroupName === "Rugs") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      Object.userData?.WalkableCarpetR87 === true ||
      Object.userData?.DecorationKind === "Rug" ||
      String(Object.name || "").startsWith("ShowroomRug-")
    );
  }

  if (GroupName === "Retail") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      Object.userData?.RetailImportedR79 === true
    );
  }

  if (GroupName === "Sale") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      Object.userData?.RetailImportedR84 === true
    );
  }

  if (GroupName === "Zones") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      Object.userData?.RetailZoneR82 === true &&
      Object.userData?.WallMountedR82 !== true
    );
  }

  if (GroupName === "ZoneHeaders") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      Object.userData?.RetailZoneR82 === true &&
      (
        Object.userData?.WallMountedR82 === true ||
        String(Object.name || "").startsWith("RetailZoneHeaderR82-")
      )
    );
  }

  if (GroupName === "Partitions") {
    return DirectChildForSlot(Chunk, Slot, Object =>
      String(Object.name || "") === "ShowroomPartition"
    );
  }

  if (GroupName === "Task") {
    return (Chunk.TaskObjects || []).some(Object =>
      Object?.parent &&
      String(Object.userData?.LayoutSlot || "") === Slot
    );
  }

  return false;
}

function PlannedLayoutEntries(Chunk) {
  const Entries = [];
  for (const GroupName of ["Base", "Rugs", "Retail", "Sale", "Zones", "ZoneHeaders", "Partitions"]) {
    for (const Entry of Chunk.Layout?.[GroupName] || []) {
      Entries.push({ GroupName, Entry });
    }
  }
  if (Chunk.Layout?.Task) Entries.push({ GroupName: "Task", Entry: Chunk.Layout.Task });
  return Entries;
}

function LayoutOccupancyReady(Chunk) {
  return PlannedLayoutEntries(Chunk).every(({ GroupName, Entry }) =>
    Entry?.Required === false || EntryPresent(Chunk, GroupName, Entry)
  );
}

function FullLayoutOccupancyReady(Chunk) {
  return PlannedLayoutEntries(Chunk).every(({ GroupName, Entry }) =>
    EntryPresent(Chunk, GroupName, Entry)
  );
}

function StrictReadinessReport(Chunk) {
  const Planned = PlannedLayoutEntries(Chunk);
  const MissingEntries = Planned.filter(
    ({ GroupName, Entry }) => !EntryPresent(Chunk, GroupName, Entry)
  );
  const Missing = MissingEntries.map(
    ({ GroupName, Entry }) =>
      `${GroupName}:${String(Entry?.Slot || Entry?.Model || "unknown")}`
  );
  const MissingGroups = [...new Set(
    MissingEntries.map(({ GroupName }) => GroupName)
  )];

  const Sellable = SellableCount(Chunk);
  const Tags = CompactTagCount(Chunk);
  const Core = CoreReady(Chunk);
  const Gpu = Boolean(Chunk.Group?.userData?.GpuWarmReadyR92);
  const Degraded = Boolean(Chunk.Group?.userData?.PresentationDegradedR83);
  const Presentation = Boolean(Chunk.Group?.userData?.PresentationReadyR83);

  return {
    Planned: Planned.length,
    Placed: Planned.length - Missing.length,
    Missing,
    MissingGroups,
    Sellable,
    Tags,
    Core,
    Gpu,
    Degraded,
    Presentation,
    Ready: Boolean(
      !Missing.length &&
      Core &&
      Gpu &&
      Presentation &&
      !Degraded
    )
  };
}

function TraversalReady(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return false;
  if (!Chunk.Layout?.Authority || Chunk.Layout.Authority !== "StoreLayoutV1") return false;
  if (Chunk.Group.userData?.LayoutAuthority !== Chunk.Layout.Authority) return false;
  if (!LayoutOccupancyReady(Chunk)) return false;

  const ShelfStocked =
    window.__STORE_SHELF_STOCK_R83__?.IsStocked?.(Chunk) ??
    Boolean(Chunk.Group.userData?.ShelfStockR83);
  const SaleDisplaysReady =
    window.__STORE_RETAIL_SALE_DISPLAYS_R84__?.Ready?.(Chunk) ??
    Boolean(Chunk.Group.userData?.RetailSaleDisplaysR84);

  return Boolean(
    Chunk.Group.userData?.WorldPolishR72 &&
    Chunk.Group.userData?.VisualRedesignR76 &&
    Chunk.Group.userData?.RetailShowroomR79 &&
    Chunk.Group.userData?.RetailZonesR82 &&
    Chunk.Group.userData?.RetailOrganizationR83 &&
    Chunk.Group.userData?.CoreFixR86 &&
    ShelfStocked &&
    SaleDisplaysReady &&
    PartitionsFinished(Chunk) &&
    RearFinished(Chunk)
  );
}

function CoreReady(Chunk) {
  if (!TraversalReady(Chunk)) return false;

  const Stable = UpdateStability(Chunk);
  return Boolean(
    Chunk.Group.userData?.PriceTagsR83 &&
    CompactTagCount(Chunk) >= Stable.Count &&
    !HasVisibleLegacyPriceSign(Chunk)
  );
}

function Delay(Milliseconds) {
  return new Promise(Resolve => setTimeout(Resolve, Milliseconds));
}

function IdleYield() {
  return new Promise(Resolve => {
    if ("requestIdleCallback" in window) requestIdleCallback(() => Resolve(), { timeout: 320 });
    else setTimeout(Resolve, 10);
  });
}

async function RunContentPasses(Chunk) {
  const Visual = window.__STORE_VISUAL_REDESIGN_R73__;
  const Retail = window.__STORE_RETAIL_SHOWROOM_R79__;
  const Finish = window.__STORE_FINISH_R80__;
  const Zones = window.__STORE_RETAIL_ZONES_R82__;
  const Organize = window.__STORE_RETAIL_ORGANIZATION_R83__;
  const ShelfStock = window.__STORE_SHELF_STOCK_R83__;
  const SaleDisplays = window.__STORE_RETAIL_SALE_DISPLAYS_R84__;
  const Materials = window.__STORE_VISIBLE_MATERIALS_R77__;
  const Integrity = window.__STORE_GENERATOR_INTEGRITY_R77__;
  const CoreFix = window.__STORE_CORE_FIX_R86__;

  if (Visual?.ProcessChunk) await Visual.ProcessChunk(Chunk);
  await IdleYield();

  if (Retail?.ProcessChunk) await Retail.ProcessChunk(Chunk);
  if (Zones?.ProcessChunk) await Zones.ProcessChunk(Chunk);
  await IdleYield();

  if (SaleDisplays?.ProcessChunk) await SaleDisplays.ProcessChunk(Chunk);
  if (Organize?.ProcessChunk) await Organize.ProcessChunk(Chunk);
  await IdleYield();

  if (ShelfStock?.ProcessChunk) await ShelfStock.ProcessChunk(Chunk);
  await IdleYield();

  await Finish?.ProcessChunk?.(Chunk);
  if (Chunk.Index === 0) await Finish?.EnsureRearClosure?.();
  await IdleYield();

  Integrity?.ProcessChunk?.(Chunk);
  RemoveTerminalBeacons(Chunk);
  if (CoreFix?.ProcessChunkAsync) {
    await CoreFix.ProcessChunkAsync(Chunk, true);
  } else {
    CoreFix?.ProcessChunk?.(Chunk, true);
  }
  Materials?.ProcessChunk?.(Chunk);
  await Game.OptimizeChunkStaticRender?.(Chunk);
  window.__STORE_APPLY_TEXTURE_BUDGET_TO_CHUNK__?.(Chunk);
  window.__STORE_RENDER_DISTANCE_LIGHTING__?.ProcessChunk?.(Chunk);
}

async function RunPolishPasses(Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled) return;

  const Tags = window.__STORE_COMPACT_PRICE_TAGS_R83__;
  const Materials = window.__STORE_VISIBLE_MATERIALS_R77__;
  const CoreFix = window.__STORE_CORE_FIX_R86__;

  await IdleYield();
  await Tags?.RebuildChunk?.(Chunk);
  RemoveTerminalBeacons(Chunk);

  // Per-chunk only. Never rescan the full world just because one aisle finished.
  Materials?.ProcessChunk?.(Chunk);
  if (CoreFix?.ProcessChunkAsync) {
    await CoreFix.ProcessChunkAsync(Chunk);
  } else {
    CoreFix?.ProcessChunk?.(Chunk);
  }

  const Ready = CoreReady(Chunk) && FullLayoutOccupancyReady(Chunk);

  if (!Ready) {
    delete Chunk.Group.userData.PresentationReadyR83;
    delete Chunk.Group.userData.PresentationReadyR82;
    delete Chunk.Group.userData.PresentationReadyAt;
    Chunk.Group.userData.PresentationDegradedR83 = true;
    Chunk.Group.userData.PresentationRetryAfter = performance.now() + 220;
    return false;
  }

  Chunk.Group.userData.PresentationReadyR83 = true;
  Chunk.Group.userData.PresentationReadyR82 = true;
  Chunk.Group.userData.PresentationReadyAt = performance.now();
  delete Chunk.Group.userData.PresentationDegradedR83;
  delete Chunk.Group.userData.PresentationRetryAfter;
  return true;
}

function SchedulePolish(Chunk) {
  if (
    !Chunk?.Group ||
    Chunk.Cancelled ||
    (
      Chunk.Group.userData?.PresentationReadyR83 &&
      !Chunk.Group.userData?.PresentationDegradedR83
    ) ||
    PolishPending.has(Chunk)
  ) return;

  PolishPending.add(Chunk);
  setTimeout(async () => {
    try {
      if (!Chunk.Cancelled && Chunk.Group) await RunPolishPasses(Chunk);
    } catch (Error) {
      console.warn("Deferred showroom polish failed", Error);
      if (Chunk?.Group && !Chunk.Cancelled) {
        delete Chunk.Group.userData.PresentationReadyR83;
        delete Chunk.Group.userData.PresentationReadyR82;
        Chunk.Group.userData.PresentationDegradedR83 = true;
        Chunk.Group.userData.PresentationRetryAfter = performance.now() + 450;
      }
    } finally {
      PolishPending.delete(Chunk);
    }
  }, 180);
}


async function FinalizeChunkNow(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return false;

  if (Chunk.Group.userData?.TraversalReadyR83) {
    SchedulePolish(Chunk);
    return true;
  }

  Finalizing.add(Chunk);
  try {
    await RunContentPasses(Chunk);

    if (!TraversalReady(Chunk)) {
      await IdleYield();
      await RunContentPasses(Chunk);
    }

    const Ready = TraversalReady(Chunk);

    if (!Ready) {
      Chunk.Group.userData.TraversalRetryAfter = performance.now() + 360;
      return false;
    }

    // Warm materials/textures while the chunk is still detached from the live
    // scene. This prevents the first visible frame from paying shader/upload cost.
    await Game.WarmChunkGpu?.(Chunk);

    Chunk.Group.userData.TraversalReadyR83 = true;
    Chunk.Group.userData.TraversalReadyAt = performance.now();
    delete Chunk.Group.userData.TraversalRetryAfter;

    SchedulePolish(Chunk);
    return true;
  } finally {
    Finalizing.delete(Chunk);
  }
}

function PumpFinalizationQueue() {
  if (FinalizationRunning) return;

  while (FinalizationQueue.length) {
    FinalizationQueue.sort((A, B) => DistanceFromPlayer(A.Chunk) - DistanceFromPlayer(B.Chunk));
    const Entry = FinalizationQueue.shift();
    const Chunk = Entry?.Chunk;

    if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) {
      PendingFinalization.delete(Chunk);
      Entry?.Resolve?.(false);
      continue;
    }

    FinalizationRunning = true;

    Promise.resolve()
      .then(() => IdleYield())
      .then(() => FinalizeChunkNow(Chunk))
      .then(Result => Entry.Resolve(Boolean(Result)))
      .catch(Error => {
        console.warn(`Chunk ${Chunk.Index} finalization failed`, Error);
        Entry.Resolve(false);
      })
      .finally(() => {
        PendingFinalization.delete(Chunk);
        FinalizationRunning = false;
        queueMicrotask(PumpFinalizationQueue);
      });

    return;
  }
}

export function FinalizeChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) {
    return Promise.resolve(false);
  }

  if (Chunk.Group.userData?.TraversalReadyR83) {
    SchedulePolish(Chunk);
    return Promise.resolve(true);
  }

  const RetryAfter = Number(Chunk.Group.userData?.TraversalRetryAfter) || 0;
  if (RetryAfter > performance.now()) return Promise.resolve(false);

  const Existing = PendingFinalization.get(Chunk);
  if (Existing) return Existing;

  let ResolveJob = null;
  const Job = new Promise(Resolve => {
    ResolveJob = Resolve;
  });

  PendingFinalization.set(Chunk, Job);
  FinalizationQueue.push({
    Chunk,
    Resolve: ResolveJob
  });
  PumpFinalizationQueue();
  return Job;
}

async function PrimeBootWorld() {
  const Chunks = [];
  for (const Chunk of Game.ActiveChunks.values()) if (Chunk?.Ready && !Chunk.Cancelled) Chunks.push(Chunk);
  for (const Chunk of Game.PreparedChunks.values()) if (Chunk?.Ready && !Chunk.Cancelled && !Chunks.includes(Chunk)) Chunks.push(Chunk);
  Chunks.sort((A, B) => Math.abs(A.Index) - Math.abs(B.Index));
  for (const Chunk of Chunks) await FinalizeChunk(Chunk);
}

await PrimeBootWorld();
window.__STORE_REQUIRE_PRESENTATION_READY__ = false;
window.__STORE_REQUIRE_TRAVERSAL_READY__ = true;


function DistanceFromPlayer(Chunk) {
  const CenterZ = Number.isFinite(Chunk?.CenterZ)
    ? Chunk.CenterZ
    : ((Number(Chunk?.TopZ) || 0) + (Number(Chunk?.BottomZ) || 0)) * 0.5;
  return Math.abs(CenterZ - (Number(Game.Camera?.position?.z) || 0));
}

function NextFinalizeCandidate() {
  const Now = performance.now();
  const Candidates = [];
  for (const Chunk of Game.PreparedChunks.values()) {
    if (
      !Chunk?.Ready ||
      Chunk.Cancelled ||
      Chunk.Group?.userData?.PresentationReadyR83
    ) continue;
    if (PendingFinalization.has(Chunk) || Finalizing.has(Chunk)) continue;
    const RetryAfter = Number(Chunk.Group.userData?.PresentationRetryAfter) || 0;
    if (RetryAfter > Now) continue;
    Candidates.push(Chunk);
  }
  Candidates.sort((A, B) => DistanceFromPlayer(A) - DistanceFromPlayer(B));
  return Candidates[0] || null;
}

function Discover() {
  if (window.__STORE_BOOT_CRITICAL__) return null;
  if (DiscoverFlight) return DiscoverFlight;
  const Chunk = NextFinalizeCandidate();
  if (!Chunk) return null;

  DiscoverFlight = FinalizeChunk(Chunk)
    .catch(Error => console.warn("Prepared chunk presentation failed", Error))
    .finally(() => {
      DiscoverFlight = null;
    });
  return DiscoverFlight;
}

export async function WaitForPresentationReady(Chunk, TimeoutMs = 30000) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return false;
  const StartedAt = performance.now();
  let LastRepairAt = -Infinity;

  while (!Chunk.Cancelled && Chunk.Group) {
    let Report = StrictReadinessReport(Chunk);

    window.__STORE_SET_BOOT_DETAIL__?.(
      `Aisle ${Chunk.Index + 1} • objects ${Report.Placed}/${Report.Planned} • prices ${Report.Tags}/${Report.Sellable} • ${Report.Gpu ? "GPU ready" : "GPU preparing"}`
    );

    if (Report.Ready) return true;

    const Now = performance.now();
    if (Now - StartedAt >= Math.max(3000, Number(TimeoutMs) || 30000)) {
      console.error(`Strict aisle readiness timed out for ${Chunk.Id}`, Report);
      Chunk.Group.userData.StrictBootFailureR49 = {
        Missing: [...Report.Missing],
        MissingGroups: [...Report.MissingGroups],
        Placed: Report.Placed,
        Planned: Report.Planned,
        Tags: Report.Tags,
        Sellable: Report.Sellable
      };
      return false;
    }

    if (Now - LastRepairAt >= 220) {
      LastRepairAt = Now;

      const MissingSummary = Report.Missing.length
        ? Report.Missing.join(", ")
        : "presentation state";
      window.__STORE_SET_BOOT_DETAIL__?.(
        `Aisle ${Chunk.Index + 1} • repairing ${MissingSummary}`
      );

      await Game.EnsureBaseLayoutModels?.(Chunk, 2);
      Game.EnsureStaticLayoutObjects?.(Chunk);

      if (
        Report.MissingGroups.includes("Retail") ||
        !Chunk.Group.userData?.RetailShowroomR79
      ) {
        await window.__STORE_RETAIL_SHOWROOM_R79__?.ProcessChunk?.(Chunk);
      }

      if (
        Report.MissingGroups.includes("Zones") ||
        Report.MissingGroups.includes("ZoneHeaders") ||
        !Chunk.Group.userData?.RetailZonesR82
      ) {
        delete Chunk.Group.userData.RetailZonesR82;
        await window.__STORE_RETAIL_ZONES_R82__?.ProcessChunk?.(Chunk);
      }

      if (
        Report.MissingGroups.includes("Sale") ||
        !window.__STORE_RETAIL_SALE_DISPLAYS_R84__?.Ready?.(Chunk)
      ) {
        await window.__STORE_RETAIL_SALE_DISPLAYS_R84__?.ProcessChunk?.(Chunk);
      }

      if (!TraversalReady(Chunk) || !FullLayoutOccupancyReady(Chunk)) {
        await RunContentPasses(Chunk);
      }

      if (!Chunk.Group.userData?.GpuWarmReadyR92) {
        await Game.WarmChunkGpu?.(Chunk);
      }

      await RunPolishPasses(Chunk);
      Report = StrictReadinessReport(Chunk);
      if (Report.Ready) return true;
    }

    await Delay(55);
  }

  return false;
}

Discover();
const Interval = setInterval(Discover, 1800);
addEventListener("pagehide", () => clearInterval(Interval), { once: true });

window.__STORE_PRESENTATION_READY_R83__ = {
  FinalizeChunk,
  WaitForPresentationReady,
  StrictReadinessReport,
  TraversalReady,
  CoreReady,
  Discover
};
window.__STORE_PRESENTATION_READY_BUILD__ = "V0.35.58-NO-REAR-WALL-GATE";
