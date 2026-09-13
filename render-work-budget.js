export function WaitForWorkSlice(MinimumMs = 6, MaximumWaitMs = 480) {
  const StartedAt = performance.now();

  return new Promise(Resolve => {
    const Check = () => {
      const GameplayActive = window.__STORE_GAMEPLAY_STARTED__ === true;
      const RequiredIdleMs = GameplayActive
        ? Math.min(Math.max(2.25, MinimumMs), 3.25)
        : MinimumMs;

      if (!("requestIdleCallback" in window)) {
        // During gameplay, leave a display frame between heavy background jobs.
        requestAnimationFrame(() => Resolve());
        return;
      }

      requestIdleCallback(Deadline => {
        const Elapsed = performance.now() - StartedAt;
        const HasBudget = Deadline.timeRemaining() >= RequiredIdleMs;

        if (HasBudget) {
          Resolve();
          return;
        }

        // Boot must eventually make progress. Gameplay background work should
        // wait for actual idle time instead of forcing itself into a hot frame.
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
          ? 900
          : Math.max(32, MaximumWaitMs - (performance.now() - StartedAt))
      });
    };

    Check();
  });
}
