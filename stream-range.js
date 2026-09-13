export const STREAM_RANGE = Object.freeze({
  // The live world is intentionally asymmetric: the player needs finished
  // store ahead, not a second fully populated store behind them.
  ActiveRadius: 3,
  ActiveBack: 1,
  ActiveAhead: 3,
  PrefetchRadius: 1,
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
