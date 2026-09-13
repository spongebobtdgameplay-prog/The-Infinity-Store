import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.Camera || !Game?.Renderer) throw new Error("Game must load before distance haze.");

const FogColor = 0x24261f;

function Profile() {
  const Quality = String(window.__STORE_USER_SETTINGS__?.Graphics || "balanced");
  if (Quality === "performance") return { Near: 36, Far: 102, CameraFar: 135 };
  if (Quality === "high") return { Near: 56, Far: 150, CameraFar: 195 };
  return { Near: 45, Far: 125, CameraFar: 160 };
}

function DisableProxyHorizon() {
  const Horizon = Game.Scene.getObjectByName("StoreHorizonForward");
  if (!Horizon) return;
  Horizon.visible = false;
  Horizon.userData.StoreHorizonDisabledR99 = true;
}

function Apply() {
  const Current = Profile();

  if (!Game.Scene.fog?.isFog || Game.Scene.fog?.isFogExp2) {
    Game.Scene.fog = new THREE.Fog(FogColor, Current.Near, Current.Far);
  } else {
    Game.Scene.fog.color.setHex(FogColor, THREE.SRGBColorSpace);
    Game.Scene.fog.near = Current.Near;
    Game.Scene.fog.far = Current.Far;
  }

  if (Game.Scene.background?.isColor) {
    Game.Scene.background.setHex(FogColor, THREE.SRGBColorSpace);
  }

  if (Math.abs(Game.Camera.far - Current.CameraFar) > 0.1) {
    Game.Camera.far = Current.CameraFar;
    Game.Camera.updateProjectionMatrix();
  }

  // Visibility belongs to game.js frustum/object streaming. Do not wrap
  // Renderer.render and never force inactive/off-screen chunks visible.
  DisableProxyHorizon();
}

Apply();
addEventListener("store-settings-change", Apply);

window.__STORE_DISTANCE_HAZE_R82__ = { Apply };
window.__STORE_DISTANCE_HAZE_BUILD__ = "V0.35.69-R99-NO-RENDER-WRAPPER";
