import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Scene || !Game?.Camera || !Game?.Renderer) throw new Error("Game must load before distance haze.");

const FogColor = 0x24261f;
const ProcessedHorizonObjects = new WeakSet();

function Profile() {
  const Quality = String(window.__STORE_USER_SETTINGS__?.Graphics || "balanced");
  if (Quality === "performance") return { Near: 42, Far: 105, CameraFar: 190 };
  if (Quality === "high") return { Near: 58, Far: 148, CameraFar: 250 };
  return { Near: 50, Far: 128, CameraFar: 220 };
}

function StabilizeHorizon() {
  const Horizon = Game.Scene.getObjectByName("StoreHorizonForward");
  if (!Horizon) return;
  Horizon.traverse(Object => {
    if ((!Object?.isMesh && !Object?.isInstancedMesh) || ProcessedHorizonObjects.has(Object)) return;
    ProcessedHorizonObjects.add(Object);
    Object.frustumCulled = false;
    if (!Object.material) return;
    if (/HorizonLightGlow/i.test(String(Object.name || ""))) {
      Object.material = Object.material.clone();
      Object.material.color?.setHex(0xcdb88e);
      Object.material.opacity = 0.78;
      Object.material.transparent = true;
      Object.material.depthWrite = false;
      Object.material.needsUpdate = true;
    }
  });
}

function Apply() {
  const Current = Profile();
  if (!Game.Scene.fog?.isFog || Game.Scene.fog?.isFogExp2) {
    Game.Scene.fog = new THREE.Fog(FogColor, Current.Near, Current.Far);
  } else {
    Game.Scene.fog.color.setHex(FogColor);
    Game.Scene.fog.near = Current.Near;
    Game.Scene.fog.far = Current.Far;
  }
  if (Game.Scene.background?.isColor) Game.Scene.background.setHex(FogColor);
  if (Math.abs(Game.Camera.far - Current.CameraFar) > 0.1) {
    Game.Camera.far = Current.CameraFar;
    Game.Camera.updateProjectionMatrix();
  }
  StabilizeHorizon();
}

Apply();
addEventListener("store-settings-change", Apply);
const Interval = setInterval(Apply, 1200);
addEventListener("pagehide", () => clearInterval(Interval), { once: true });

window.__STORE_DISTANCE_HAZE_R82__ = { Apply };
window.__STORE_DISTANCE_HAZE_BUILD__ = "V0.21.1-R82";
