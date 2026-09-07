const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.StreamRange) {
  throw new Error("Game must load before aisle prefetching.");
}

const PriorityFlights = new Map();
function FindChunk(Index) {
  return Game.ActiveChunks.get(Index) || Game.PreparedChunks.get(Index);
}
function IsTraversalReady(Chunk) {
  return Boolean(Chunk?.Ready && !Chunk.Cancelled &&
    Chunk.Group?.userData?.PresentationReadyR83 && Chunk.Group?.userData?.GpuWarmReadyR92);
}
function IsAlreadyVisible(Chunk) {
  // Frustum culling must not be confused with an unloaded section.
  return Boolean(Chunk?.Active && !Chunk.Cancelled && Chunk.Group?.parent === Game.Scene);
}
function PrioritizeIndex(Index) {
  if (!Number.isInteger(Index) || Index < 0) return Promise.resolve(false);
  const Existing = FindChunk(Index);
  if (IsTraversalReady(Existing)) return Promise.resolve(true);
  if (PriorityFlights.has(Index)) return PriorityFlights.get(Index);
  const Flight = Promise.resolve(Existing || Game.PrepareChunk(Index))
    .then(Chunk => window.__STORE_PRESENTATION_READY_R83__?.FinalizeChunk(Chunk))
    .catch(Error => { console.warn(`Aisle ${Index + 1} preparation failed`, Error); return false; })
    .finally(() => PriorityFlights.delete(Index));
  PriorityFlights.set(Index, Flight);
  return Flight;
}
function EnsureStrictBuffer(CurrentIndex) {
  for (let Offset = 0; Offset <= Game.StreamRange.PrefetchRadius; Offset += 1) {
    const Indices = Offset === 0 ? [CurrentIndex] : [CurrentIndex + Offset, CurrentIndex - Offset];
    for (const Index of Indices) {
      if (Index < 0) continue;
      if (!IsTraversalReady(FindChunk(Index))) PrioritizeIndex(Index);
      else if (Offset <= Game.StreamRange.ActiveRadius) Game.TryActivateIndex(Index);
    }
  }
}
function Hide() { window.__STORE_STREAM_LOADING__ = false; }
function Show() { window.__STORE_STREAM_LOADING__ = true; }
function Tick() {
  if (window.__STORE_BOOT_CRITICAL__ || window.__STORE_GAMEPLAY_STARTED__ !== true) return;
  const Index = Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z));
  EnsureStrictBuffer(Index);
  window.__STORE_STREAM_LOADING__ = !IsTraversalReady(FindChunk(Index + 1));
}
const Interval = setInterval(Tick, 250);
addEventListener("pagehide", () => { clearInterval(Interval); Hide(); }, { once: true });
window.__STORE_STREAM_LOADING_R83__ = {
  Show, Hide, PrioritizeNext: PrioritizeIndex, PrioritizeIndex,
  EnsureStrictBuffer, IsTraversalReady, IsAlreadyVisible
};
window.__STORE_STREAM_LOADING_BUILD__ = "V0.35.58-REAL-AISLE-BUFFER";
