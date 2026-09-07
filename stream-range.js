export const STREAM_RANGE = Object.freeze({
  // Original high-quality fog reaches 148m. Six 30m aisles leave a full margin
  // at either end of the current aisle; preload three more for sprinting/turning.
  ActiveRadius: 6,
  PrefetchRadius: 9,
  BootCount: 7
});

export function ChunkRange(CurrentIndex) {
  return {
    ActiveMin: Math.max(0, CurrentIndex - STREAM_RANGE.ActiveRadius),
    ActiveMax: CurrentIndex + STREAM_RANGE.ActiveRadius,
    PrepareMin: Math.max(0, CurrentIndex - STREAM_RANGE.PrefetchRadius),
    PrepareMax: CurrentIndex + STREAM_RANGE.PrefetchRadius
  };
}
