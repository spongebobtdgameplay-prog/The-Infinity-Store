export function WaitForWorkSlice(MinimumMs = 6, MaximumWaitMs = 480) {
  const StartedAt = performance.now();
  return new Promise(Resolve => {
    const Check = () => {
      if (!("requestIdleCallback" in window)) {
        requestAnimationFrame(() => Resolve());
        return;
      }

      requestIdleCallback(Deadline => {
        const Elapsed = performance.now() - StartedAt;
        if (Deadline.timeRemaining() >= MinimumMs || Elapsed >= MaximumWaitMs) {
          Resolve();
          return;
        }

        if (document.visibilityState === "hidden") {
          setTimeout(Check, 32);
          return;
        }

        requestAnimationFrame(Check);
      }, { timeout: Math.max(32, MaximumWaitMs - (performance.now() - StartedAt)) });
    };

    Check();
  });
}
