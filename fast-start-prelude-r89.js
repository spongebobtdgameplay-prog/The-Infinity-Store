(() => {
  const BuildVersion = "0.35.53";
  const SessionKey = "InfinityStoreSessionV1";
  const ServerUrl = "https://the-infinity-store-vh88.onrender.com";
  const FastAccountWindowMs = 3000;
  const StartedAt = performance.now();
  const HasSavedSession = Boolean(localStorage.getItem(SessionKey));

  let MultiplayerValue = null;
  let ActualWarmup = null;
  let ActualWarmupPromise = null;
  let WarmupWrapper = null;
  let ActualPreloadProgress = null;
  let PlayableAssetGate = false;
  let GameplayStarted = false;

  const ApplyBuildVersion = () => {
    const Node = document.getElementById("BuildVersion");
    if (Node && Node.textContent !== `BUILD V${BuildVersion}`) Node.textContent = `BUILD V${BuildVersion}`;
  };

  const ShowBootLoading = () => {
    if (GameplayStarted || window.__STORE_GAMEPLAY_STARTED__) return;
    const BootScreen = document.getElementById("BootScreen");
    const Panel = document.getElementById("BootLoadPanel");
    const Stage = document.getElementById("BootStageLabel");
    BootScreen?.classList.add("ScreenVisible");
    Panel?.classList.remove("Hidden");
    Panel?.removeAttribute("hidden");
    if (Stage && !Stage.textContent.trim()) Stage.textContent = "Loading the store now...";
    ApplyBuildVersion();
  };

  ShowBootLoading();

  const BuildObserver = new MutationObserver(() => {
    ApplyBuildVersion();
    ShowBootLoading();
  });
  BuildObserver.observe(document.body, { childList: true, subtree: true });

  addEventListener("store-gameplay-started", () => {
    GameplayStarted = true;
    BuildObserver.disconnect();
  }, { once: true });

  Object.defineProperty(window, "__STORE_VERSION__", {
    configurable: true,
    get() {
      return BuildVersion;
    },
    set() {
      ApplyBuildVersion();
    }
  });

  Object.defineProperty(window, "__STORE_PRELOAD_PROGRESS__", {
    configurable: true,
    get() {
      if (!ActualPreloadProgress) return null;
      if (!PlayableAssetGate) return ActualPreloadProgress;
      return {
        ...ActualPreloadProgress,
        loaded: Math.max(1, Number(ActualPreloadProgress.total) || 1),
        failed: 0,
        settled: Math.max(1, Number(ActualPreloadProgress.total) || 1),
        percent: 100,
        playableGateOnly: true
      };
    },
    set(Value) {
      ActualPreloadProgress = Value;
      window.__STORE_ACTUAL_PRELOAD_PROGRESS_R89__ = Value;
    }
  });

  Object.defineProperty(window, "__STORE_START_ASSET_WARMUP__", {
    configurable: true,
    get() {
      return WarmupWrapper;
    },
    set(Value) {
      ActualWarmup = typeof Value === "function" ? Value : null;
      if (!ActualWarmup) {
        WarmupWrapper = Value;
        return;
      }

      const StartActualWarmup = () => {
        if (!ActualWarmupPromise) {
          ActualWarmupPromise = Promise.resolve()
            .then(() => ActualWarmup())
            .catch(Error => {
              console.warn("Background asset warm-up failed", Error);
              return null;
            });
          window.__STORE_ACTUAL_PRELOAD_COMPLETE_R89__ = ActualWarmupPromise;
        }
        return ActualWarmupPromise;
      };

      WarmupWrapper = () => {
        StartActualWarmup();
        PlayableAssetGate = true;
        window.__STORE_FAST_PLAYABLE_ASSETS_R89__ = true;
        return Promise.resolve({ loaded: 1, total: 1, failed: 0, background: true, playable: true });
      };

      queueMicrotask(StartActualWarmup);
    }
  });

  Object.defineProperty(window, "__STORE_MULTIPLAYER__", {
    configurable: true,
    get() {
      return MultiplayerValue;
    },
    set(Value) {
      MultiplayerValue = Value;
      if (!Value || Value.__FastStartPatchedR89) return;
      Object.defineProperty(Value, "__FastStartPatchedR89", { value: true });

      const OriginalWaitForAccount = typeof Value.WaitForAccount === "function"
        ? Value.WaitForAccount.bind(Value)
        : null;

      if (OriginalWaitForAccount) {
        let AccountPromise = null;
        Value.WaitForAccount = () => {
          AccountPromise ||= Promise.resolve().then(() => OriginalWaitForAccount());
          if (!HasSavedSession) return AccountPromise;

          return Promise.race([
            AccountPromise,
            new Promise(Resolve => {
              const Remaining = Math.max(0, FastAccountWindowMs - (performance.now() - StartedAt));
              setTimeout(() => Resolve({ ok: true, deferred: true }), Remaining);
            })
          ]);
        };
      }
    }
  });

  if (HasSavedSession) {
    let AccountWatchDone = false;

    const UpdateRestoreOverlay = () => {
      if (AccountWatchDone || GameplayStarted) return;
      const Overlay = document.getElementById("StoreAccountOverlay");
      if (!Overlay) return;
      const State = MultiplayerValue?.GetState?.();

      if (State?.account) {
        Overlay.hidden = true;
        AccountWatchDone = true;
        return;
      }

      if (window.__STORE_BOOT_CRITICAL__ !== false) {
        Overlay.hidden = true;
        return;
      }

      Overlay.hidden = false;
      AccountWatchDone = true;
    };

    const AccountObserver = new MutationObserver(UpdateRestoreOverlay);
    AccountObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    const RestoreInterval = setInterval(() => {
      UpdateRestoreOverlay();
      if (AccountWatchDone || GameplayStarted) {
        clearInterval(RestoreInterval);
        AccountObserver.disconnect();
      }
    }, 60);
  }

  try {
    fetch(`${ServerUrl}/api/client-info`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      credentials: "omit"
    }).catch(() => {});
  } catch {}

  window.__STORE_FAST_START_R89__ = {
    BuildVersion,
    FastAccountWindowMs,
    GetActualPreloadProgress: () => ActualPreloadProgress,
    GetActualWarmupPromise: () => ActualWarmupPromise
  };
})();