import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.Camera || !Game?.Renderer) throw new Error("Game must load before distance haze.");

const FogColor = 0x30322b;

function Profile() {
  const Quality = String(window.__STORE_USER_SETTINGS__?.Graphics || "balanced");
  if (Quality === "performance") return { Near: 44, Far: 116, CameraFar: 142 };
  if (Quality === "high") return { Near: 66, Far: 172, CameraFar: 210 };
  return { Near: 56, Far: 146, CameraFar: 178 };
}

function DisableProxyHorizon() {
  const Horizon = Game.Scene.getObjectByName("StoreHorizonForward");
  if (!Horizon) return;
  Horizon.visible = false;
  Horizon.userData.StoreHorizonDisabledR101 = true;
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

  // This should read as store air/haze, not a fake wall. Visibility stays in game.js.
  DisableProxyHorizon();
}

Apply();
addEventListener("store-settings-change", Apply);

window.__STORE_DISTANCE_HAZE_R82__ = { Apply };
window.__STORE_DISTANCE_HAZE_BUILD__ = "V0.35.71-R101-AMBIENT-HORIZON";
