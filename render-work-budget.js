// Prefer spare frame time, but never starve world generation on a busy GPU.
// The elapsed deadline survives low-budget callbacks; re-queueing must not reset it.
export function WaitForWorkSlice(MinimumMs = 4, MaximumWaitMs = 120) {
  const StartedAt = performance.now();
  return new Promise(Resolve => {
    const Check = () => {
      if (!("requestIdleCallback" in window)) {
        setTimeout(Resolve, 0);
        return;
      }
      requestIdleCallback(Deadline => {
        if (Deadline.didTimeout || Deadline.timeRemaining() >= MinimumMs ||
            performance.now() - StartedAt >= MaximumWaitMs) {
          Resolve();
        } else if (document.visibilityState === "hidden") {
          setTimeout(Check, 16);
        } else {
          requestAnimationFrame(Check);
        }
      }, { timeout: Math.max(1, MaximumWaitMs - (performance.now() - StartedAt)) });
    };
    Check();
  });
}
