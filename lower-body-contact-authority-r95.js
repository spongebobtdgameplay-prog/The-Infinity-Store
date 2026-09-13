import * as THREE from "three";

const Build = "V0.35.66-R95-LOWER-BODY-CONTACT";
const PlayerEyeHeight = 1.68;
const LowerBodyHeight = 0.82;
const InstallIntervalMs = 50;
const MaxAttempts = 240;

let Installed = false;
let Attempts = 0;

function EmptyResult(Target) {
  const Separation = Target?.isVector3 ? Target : new THREE.Vector3();
  Separation.set(0, 0, 0);
  return {
    Hit: false,
    Depth: 0,
    Separation,
    UpperBodyVisualOnlyR95: true
  };
}

function Install() {
  if (Installed) return true;

  const SurfaceStep = window.__STORE_SURFACE_STEP_ANIMATION_R87__;
  const Game = window.__STORE_GAME__;
  if (!SurfaceStep || typeof SurfaceStep.ResolveBodyPartCurbForce !== "function" || !Game?.Camera) return false;
  if (SurfaceStep.__LowerBodyContactAuthorityR95) {
    Installed = true;
    return true;
  }

  const OriginalResolveBodyPartCurbForce = SurfaceStep.ResolveBodyPartCurbForce.bind(SurfaceStep);

  SurfaceStep.ResolveBodyPartCurbForce = function ResolveLowerBodyOnlyCurbForce(
    Position,
    Radius = 0.10,
    Target = null,
    Clearance = 0.010
  ) {
    if (!Position?.isVector3) return EmptyResult(Target);

    const FeetY = Number(Game.Camera.position.y) - PlayerEyeHeight;
    const LowerBodyCeiling = FeetY + LowerBodyHeight;

    // Whole-player movement is owned by the capsule, feet and legs. Arms,
    // wrists, shoulders, chest and head are allowed to bend/retract visually,
    // but they may not push the camera/root backward or make walking feel slow.
    if (Position.y - Math.max(0, Number(Radius) || 0) > LowerBodyCeiling) {
      return EmptyResult(Target);
    }

    return OriginalResolveBodyPartCurbForce(Position, Radius, Target, Clearance);
  };

  Object.defineProperty(SurfaceStep, "__LowerBodyContactAuthorityR95", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  window.__STORE_ROOT_CONTACT_POLICY_R95__ = Object.freeze({
    Build,
    Mode: "LOWER_BODY_ONLY",
    PlayerEyeHeight,
    LowerBodyHeight,
    UpperBodyContact: "POSE_ONLY",
    RootBlocking: "CAPSULE_FEET_LEGS"
  });
  window.__STORE_LOWER_BODY_CONTACT_BUILD__ = Build;
  Installed = true;
  return true;
}

if (!Install()) {
  const Timer = setInterval(() => {
    Attempts += 1;
    if (Install() || Attempts >= MaxAttempts) clearInterval(Timer);
  }, InstallIntervalMs);
  addEventListener("pagehide", () => clearInterval(Timer), { once: true });
}

export { Install };
