export const STREAM_RANGE = Object.freeze({
  // Keep enough finished store ahead to hide generation, but do not retain a
  // dozen full furniture aisles behind/around the player. game.js frustum
  // streaming decides what is actually rendered inside this small live window.
  ActiveRadius: 3,
  PrefetchRadius: 3,
  BootCount: 4
});

export function ChunkRange(CurrentIndex) {
  return {
    ActiveMin: Math.max(0, CurrentIndex - STREAM_RANGE.ActiveRadius),
    ActiveMax: CurrentIndex + STREAM_RANGE.ActiveRadius,
    PrepareMin: Math.max(0, CurrentIndex - STREAM_RANGE.PrefetchRadius),
    PrepareMax: CurrentIndex + STREAM_RANGE.PrefetchRadius
  };
}
