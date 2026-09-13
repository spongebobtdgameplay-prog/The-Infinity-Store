export const STREAM_RANGE = Object.freeze({
  // Keep only the traversal neighborhood live. Two finished aisles ahead are
  // enough to hide generation without paying to render a fifth populated aisle.
  ActiveRadius: 2,
  ActiveBack: 1,
  ActiveAhead: 2,
  PrefetchRadius: 1,
  BootCount: 3
});

export function ChunkRange(CurrentIndex) {
  return {
    ActiveMin: Math.max(0, CurrentIndex - STREAM_RANGE.ActiveBack),
    ActiveMax: CurrentIndex + STREAM_RANGE.ActiveAhead,
    PrepareMin: Math.max(0, CurrentIndex - STREAM_RANGE.PrefetchRadius),
    PrepareMax: CurrentIndex + STREAM_RANGE.ActiveAhead
  };
}
