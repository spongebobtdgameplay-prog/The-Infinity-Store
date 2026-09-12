import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (!Game?.Camera || !Game?.Scene || !Game?.ActiveChunks || !Game?.PreparedChunks || !Game?.Renderer) throw new Error("Game must load before render distance lighting.");

const WarmGlow = 0xffe2ad;
const HousingColor = 0x66706d;

function EnsureOwnedMaterial(Object, Key) {
  if (!Object?.material) return null;
  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  const Signature = Materials.map(Material => Material?.uuid || "").join(":");
  if (Object.userData?.[Key] !== Signature) {
    const Cloned = Materials.map(Material => Material?.clone ? Material.clone() : Material);
    Object.material = Array.isArray(Object.material) ? Cloned : Cloned[0];
    const Updated = Array.isArray(Object.material) ? Object.material : [Object.material];
    Object.userData[Key] = Updated.map(Material => Material?.uuid || "").join(":");
  }
  return Object.material;
}

function ConfigureGlowMaterial(Material) {
  if (!Material) return;
  if (Array.isArray(Material)) {
    for (const Entry of Material) ConfigureGlowMaterial(Entry);
    return;
  }
  Material.color?.setHex(WarmGlow, THREE.SRGBColorSpace);
  if (Material.emissive?.isColor) {
    Material.emissive.setHex(0xffd18a, THREE.SRGBColorSpace);
    Material.emissiveIntensity = Math.max(0.34, Number(Material.emissiveIntensity) || 0);
  }
  Material.toneMapped = false;
  Material.transparent = false;
  Material.opacity = 1;
  Material.depthTest = true;
  Material.depthWrite = true;
  Material.polygonOffset = false;
  Material.needsUpdate = true;
}

function StabilizeGlow(Object) {
  if (!Object?.isMesh) return;
  Object.userData.StreamAmbientR101 = true;
  Object.userData.PermanentLightOffR79 = false;
  Object.userData.StoreFixtureForcedStableR89 = true;
  Object.frustumCulled = true;
  Object.renderOrder = 0;
  Object.geometry?.computeBoundingSphere?.();
  ConfigureGlowMaterial(EnsureOwnedMaterial(Object, "StoreLightGlowMaterialR89"));
}

function StabilizeHousing(Object) {
  if (!Object?.isMesh) return;
  Object.userData.StreamAmbientR101 = true;
  Object.frustumCulled = true;
  Object.geometry?.computeBoundingSphere?.();

  const Material = EnsureOwnedMaterial(Object, "StoreLightHousingMaterialR89");
  const Materials = Array.isArray(Material) ? Material : [Material];
  for (const Entry of Materials) {
    if (!Entry) continue;
    Entry.color?.setHex(HousingColor, THREE.SRGBColorSpace);
    if ("roughness" in Entry) Entry.roughness = 0.58;
    if ("metalness" in Entry) Entry.metalness = Math.min(0.42, Number(Entry.metalness) || 0.32);
    Entry.needsUpdate = true;
  }
}

function StabilizePointLight(Object) {
  if (!Object?.isPointLight || !Number.isFinite(Object.userData?.BaseIntensity)) return;
  Object.userData.PermanentOffR79 = false;
  Object.distance = 13.5;
  Object.decay = 2;
  Object.intensity = Math.min(1.45, Math.max(1.15, Number(Object.userData.BaseIntensity) || 1.35));
}

function DisableProxyHorizon() {
  const Horizon = Game.Scene.getObjectByName("StoreHorizonForward");
  if (!Horizon) return;
  Horizon.visible = false;
  Horizon.userData.StoreHorizonDisabledR89 = true;
}

function StabilizeSceneFill() {
  for (const Object of Game.Scene.children || []) {
    if (Object?.isAmbientLight) Object.intensity = Math.max(Number(Object.intensity) || 0, 0.90);
    else if (Object?.isHemisphereLight) Object.intensity = Math.max(Number(Object.intensity) || 0, 0.78);
  }
}

function ProcessRoot(Root) {
  Root?.traverse?.(Object => {
    if (Object.name === "LightGlow") StabilizeGlow(Object);
    else if (Object.name === "LightHousing") StabilizeHousing(Object);
    else if (Object.isPointLight) StabilizePointLight(Object);
  });
}

function ProcessChunk(Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled) return;
  ProcessRoot(Chunk.Group);
  for (const Object of Chunk.ExternalObjects || []) ProcessRoot(Object);
}

function ProcessAll() {
  DisableProxyHorizon();
  StabilizeSceneFill();
  const Seen = new Set();
  for (const Chunk of Game.ActiveChunks.values()) {
    if (!Chunk || Seen.has(Chunk)) continue;
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
  for (const Chunk of Game.PreparedChunks.values()) {
    if (!Chunk || Seen.has(Chunk)) continue;
    Seen.add(Chunk);
    ProcessChunk(Chunk);
  }
}

ProcessAll();
addEventListener("store-settings-change", () => {
  DisableProxyHorizon();
  StabilizeSceneFill();
});

window.__STORE_RENDER_DISTANCE_LIGHTING__ = { ProcessAll, ProcessChunk };
window.__STORE_RENDER_DISTANCE_LIGHTING_BUILD__ = "V0.35.59-R89-LIGHT-STABILITY";
