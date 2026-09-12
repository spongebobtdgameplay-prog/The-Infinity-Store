const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.StreamRange) {
  throw new Error("Game must load before aisle prefetching.");
}

const PriorityFlights = new Map();
const MaximumConcurrentFlights = 2;

function FindChunk(Index) {
  return Game.ActiveChunks.get(Index) || Game.PreparedChunks.get(Index);
}

function IsTraversalReady(Chunk) {
  return Boolean(Chunk?.Ready && !Chunk.Cancelled &&
    Chunk.Group?.userData?.PresentationReadyR83 && Chunk.Group?.userData?.GpuWarmReadyR92);
}

function IsAlreadyVisible(Chunk) {
  return Boolean(Chunk?.Active && !Chunk.Cancelled && Chunk.Group?.parent === Game.Scene);
}

function PrioritizeIndex(Index) {
  if (!Number.isInteger(Index) || Index < 0) return Promise.resolve(false);
  const Existing = FindChunk(Index);
  if (IsTraversalReady(Existing)) return Promise.resolve(true);
  if (PriorityFlights.has(Index)) return PriorityFlights.get(Index);
  const Flight = Promise.resolve(Existing || Game.PrepareChunk(Index))
    .then(Chunk => window.__STORE_PRESENTATION_READY_R83__?.FinalizeChunk(Chunk))
    .catch(Error => {
      console.warn(`Aisle ${Index + 1} preparation failed`, Error);
      return false;
    })
    .finally(() => PriorityFlights.delete(Index));
  PriorityFlights.set(Index, Flight);
  return Flight;
}

function CandidateIndices(CurrentIndex) {
  const Candidates = [{ Index: CurrentIndex, Offset: 0 }];
  for (let Offset = 1; Offset <= Game.StreamRange.PrefetchRadius; Offset += 1) {
    Candidates.push({ Index: CurrentIndex + Offset, Offset });
    if (CurrentIndex - Offset >= 0) Candidates.push({ Index: CurrentIndex - Offset, Offset });
  }
  return Candidates;
}

function EnsureStrictBuffer(CurrentIndex) {
  const Candidates = CandidateIndices(CurrentIndex);

  for (const Candidate of Candidates) {
    const Chunk = FindChunk(Candidate.Index);
    if (IsTraversalReady(Chunk)) {
      if (Candidate.Offset <= Game.StreamRange.ActiveRadius) Game.TryActivateIndex(Candidate.Index);
      continue;
    }

    if (PriorityFlights.has(Candidate.Index)) continue;
    if (PriorityFlights.size >= MaximumConcurrentFlights) break;
    PrioritizeIndex(Candidate.Index);
  }
}

function Hide() {
  window.__STORE_STREAM_LOADING__ = false;
}

function Show() {
  window.__STORE_STREAM_LOADING__ = true;
}

function Tick() {
  if (window.__STORE_BOOT_CRITICAL__ || window.__STORE_GAMEPLAY_STARTED__ !== true) return;
  const Index = Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z));
  EnsureStrictBuffer(Index);
  window.__STORE_STREAM_LOADING__ = !IsTraversalReady(FindChunk(Index + 1));
}

const Interval = setInterval(Tick, 320);
addEventListener("pagehide", () => {
  clearInterval(Interval);
  Hide();
}, { once: true });

window.__STORE_STREAM_LOADING_R83__ = {
  Show,
  Hide,
  PrioritizeNext: PrioritizeIndex,
  PrioritizeIndex,
  EnsureStrictBuffer,
  IsTraversalReady,
  IsAlreadyVisible
};
window.__STORE_STREAM_LOADING_BUILD__ = "V0.35.60-R90-THROTTLED-PREFETCH";
