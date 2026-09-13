import * as THREE from "three";

const Build = "V0.35.66-R96-VIEW-DEPENDENT-RENDERING";
const FullDetailDistance = 44;
const MidDetailDistance = 76;
const FarDetailDistance = 104;
const PriceTagDistance = 30;
const BehindCullDot = -0.22;
const BehindCullDistance = 34;
const BoundsCache = new WeakMap();
const SavedVisibility = [];
const ProjectionView = new THREE.Matrix4();
const Frustum = new THREE.Frustum();
const CameraForward = new THREE.Vector3();
const ObjectCenter = new THREE.Vector3();
const ToObject = new THREE.Vector3();

let Installed = false;
let Attempts = 0;

function GraphicsLightLimit() {
  const Mode = String(window.__STORE_USER_SETTINGS__?.Graphics || "balanced");
  if (Mode === "performance") return 2;
  if (Mode === "high") return 4;
  return 3;
}

function SaveVisibility(Object, Visible) {
  if (!Object || Object.visible === Visible) return;
  SavedVisibility.push([Object, Object.visible]);
  Object.visible = Visible;
}

function RestoreVisibility() {
  for (let Index = SavedVisibility.length - 1; Index >= 0; Index -= 1) {
    const [Object, Visible] = SavedVisibility[Index];
    if (Object) Object.visible = Visible;
  }
  SavedVisibility.length = 0;
}

function UpdateFrustum(Camera) {
  Camera.updateMatrixWorld(true);
  ProjectionView.multiplyMatrices(Camera.projectionMatrix, Camera.matrixWorldInverse);
  Frustum.setFromProjectionMatrix(ProjectionView);
  Camera.getWorldDirection(CameraForward);
  CameraForward.y = 0;
  if (CameraForward.lengthSq() <= 0.000001) CameraForward.set(0, 0, -1);
  else CameraForward.normalize();
}

function IsStructural(Object) {
  const Name = String(Object?.name || "");
  const Data = Object?.userData || {};
  return Boolean(
    Data.StreamAmbientR101 === true ||
    Data.StreamLoadingR83 === true ||
    Data.WalkableCarpetR87 === true ||
    Object?.name === "StoreTask" ||
    /^(Floor|Ceiling|WallLeft|WallRight|Baseboard|ShowroomPartition|PartitionCap|PartitionBase|RearStoreClosureR80|RearStoreWallR80|RearStoreBaseboardR80)/i.test(Name)
  );
}

function IsPriceTag(Object) {
  const Name = String(Object?.name || "");
  return Boolean(
    Object?.userData?.CompactPriceAuthorityR83 === true ||
    /PriceTag|PriceSign|PricePlacard|FurnitureItemSign|CompactPrice/i.test(Name)
  );
}

function BoundsFor(Object) {
  const Existing = BoundsCache.get(Object);
  if (Existing?.isBox3) return Existing;

  Object.updateWorldMatrix(true, true);
  const Bounds = new THREE.Box3().setFromObject(Object);
  if (!Bounds.isEmpty()) BoundsCache.set(Object, Bounds);
  return Bounds;
}

function RootDistanceSquared(Object, Camera) {
  const Bounds = BoundsFor(Object);
  if (Bounds?.isBox3 && !Bounds.isEmpty()) Bounds.getCenter(ObjectCenter);
  else Object.getWorldPosition(ObjectCenter);
  return ObjectCenter.distanceToSquared(Camera.position);
}

function RootShouldRender(Object, Camera) {
  if (!Object?.isObject3D || Object.visible === false) return false;
  if (IsStructural(Object)) return true;

  const Bounds = BoundsFor(Object);
  if (!Bounds?.isBox3 || Bounds.isEmpty()) return true;
  Bounds.getCenter(ObjectCenter);

  ToObject.copy(ObjectCenter).sub(Camera.position);
  ToObject.y = 0;
  const DistanceSquared = ToObject.lengthSq();
  const Distance = Math.sqrt(Math.max(0.000001, DistanceSquared));

  if (IsPriceTag(Object) && Distance > PriceTagDistance) return false;
  if (Distance > FarDetailDistance) return false;

  const InView = Frustum.intersectsBox(Bounds);
  if (Distance > MidDetailDistance && !InView) return false;

  if (Distance > BehindCullDistance) {
    const Dot = (
      ToObject.x * CameraForward.x +
      ToObject.z * CameraForward.z
    ) / Distance;
    if (Dot < BehindCullDot) return false;
  }

  if (Distance <= FullDetailDistance) return true;
  return InView || Distance <= MidDetailDistance;
}

function CollectPointLights(Game, Camera) {
  const Lights = [];
  const Seen = new Set();

  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    if (!Chunk?.Group || Chunk.Group.visible === false) continue;
    for (const Light of Chunk.Lights || []) {
      if (!Light?.isPointLight || Seen.has(Light)) continue;
      Seen.add(Light);
      Light.getWorldPosition(ObjectCenter);
      Lights.push({ Light, DistanceSquared: ObjectCenter.distanceToSquared(Camera.position) });
    }
  }

  for (const Object of Game.Scene.children || []) {
    if (!Object?.isPointLight || Seen.has(Object)) continue;
    Seen.add(Object);
    Object.getWorldPosition(ObjectCenter);
    Lights.push({ Light: Object, DistanceSquared: ObjectCenter.distanceToSquared(Camera.position) });
  }

  Lights.sort((A, B) => A.DistanceSquared - B.DistanceSquared);
  return Lights;
}

function ApplyLightBudget(Game, Camera) {
  const Lights = CollectPointLights(Game, Camera);
  const Limit = GraphicsLightLimit();

  for (let Index = 0; Index < Lights.length; Index += 1) {
    const Light = Lights[Index].Light;
    SaveVisibility(Light, Index < Limit);
  }
}

function ApplyDetailBudget(Game, Camera) {
  for (const Chunk of Game.ActiveChunks?.values?.() || []) {
    if (!Chunk?.Group || Chunk.Cancelled || Chunk.Group.visible === false) continue;

    for (const Object of Chunk.Group.children || []) {
      if (!Object?.isObject3D || Object.isLight || Object.visible === false) continue;
      if (!RootShouldRender(Object, Camera)) SaveVisibility(Object, false);
    }

    for (const Object of Chunk.ExternalObjects || []) {
      if (!Object?.isObject3D || Object.isLight || Object.visible === false) continue;
      if (!RootShouldRender(Object, Camera)) SaveVisibility(Object, false);
    }
  }
}

function Install() {
  if (Installed) return true;

  const Game = window.__STORE_GAME__;
  if (!Game?.Renderer || !Game?.Scene || !Game?.Camera || !Game?.ActiveChunks) return false;
  if (Game.Renderer.__R96RenderBudgetInstalled) {
    Installed = true;
    return true;
  }

  const Renderer = Game.Renderer;
  const OriginalRender = Renderer.render.bind(Renderer);

  Renderer.render = function RenderWithStoreBudget(Scene, Camera) {
    if (!Scene || !Camera) return OriginalRender(Scene, Camera);

    UpdateFrustum(Camera);
    try {
      ApplyDetailBudget(Game, Camera);
      ApplyLightBudget(Game, Camera);
      return OriginalRender(Scene, Camera);
    } finally {
      RestoreVisibility();
    }
  };

  Object.defineProperty(Renderer, "__R96RenderBudgetInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  window.__STORE_RENDER_BUDGET_R96__ = Object.freeze({
    Build,
    FullDetailDistance,
    MidDetailDistance,
    FarDetailDistance,
    PriceTagDistance,
    LightLimit: GraphicsLightLimit
  });
  window.__STORE_RENDER_BUDGET_BUILD__ = Build;
  Installed = true;
  return true;
}

if (!Install()) {
  const Timer = setInterval(() => {
    Attempts += 1;
    if (Install() || Attempts >= 240) clearInterval(Timer);
  }, 50);
  addEventListener("pagehide", () => clearInterval(Timer), { once: true });
}

export { Install };
