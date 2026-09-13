export function WaitForWorkSlice(MinimumMs = 6, MaximumWaitMs = 480) {
  const StartedAt = performance.now();

  return new Promise(Resolve => {
    const Check = () => {
      const GameplayActive = window.__STORE_GAMEPLAY_STARTED__ === true;
      const RequiredIdleMs = GameplayActive
        ? Math.min(Math.max(1.5, MinimumMs), 2.5)
        : MinimumMs;

      if (!("requestIdleCallback" in window)) {
        // During gameplay, yield at least one full frame before background work.
        requestAnimationFrame(() => {
          if (GameplayActive) requestAnimationFrame(() => Resolve());
          else Resolve();
        });
        return;
      }

      requestIdleCallback(Deadline => {
        const Elapsed = performance.now() - StartedAt;
        const HasBudget = Deadline.timeRemaining() >= RequiredIdleMs;

        if (HasBudget) {
          Resolve();
          return;
        }

        // Boot must eventually make progress. Gameplay background generation is
        // different: never cash in a timeout by stealing a visibly busy frame.
        if (!GameplayActive && Elapsed >= MaximumWaitMs) {
          Resolve();
          return;
        }

        if (document.visibilityState === "hidden") {
          setTimeout(Check, 48);
          return;
        }

        requestAnimationFrame(Check);
      }, {
        timeout: GameplayActive
          ? 1200
          : Math.max(32, MaximumWaitMs - (performance.now() - StartedAt))
      });
    };

    Check();
  });
}
