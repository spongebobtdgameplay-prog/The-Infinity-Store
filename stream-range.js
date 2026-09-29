export const STREAM_RANGE = Object.freeze({
  // Keep a real finished horizon ahead. Two ahead made the cutoff/fog feel fake
  // and made chunk turnover too obvious while moving through the store.
  ActiveRadius: 3,
  ActiveBack: 1,
  ActiveAhead: 3,
  // Prefetch through the full active horizon so the next new aisle is built
  // while the player is still one aisle or more away from reaching it.
  PrefetchRadius: 3,
  BootCount: 4
});

export function ChunkRange(CurrentIndex) {
  return {
    ActiveMin: Math.max(0, CurrentIndex - STREAM_RANGE.ActiveBack),
    ActiveMax: CurrentIndex + STREAM_RANGE.ActiveAhead,
    PrepareMin: Math.max(0, CurrentIndex - STREAM_RANGE.PrefetchRadius),
    PrepareMax: CurrentIndex + STREAM_RANGE.ActiveAhead
  };
}
