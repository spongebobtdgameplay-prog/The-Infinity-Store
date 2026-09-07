import { WaitForWorkSlice } from "./render-work-budget.js?v=20260907-v03558";
import * as THREE from "three";
import {
  CreateOnlineSurfaceDecoration,
  OnlineDecorationKeys,
  PreloadOnlineDecorations
} from "./online-decoration-library-r75.js?v=20260824-88";

const Game = window.__STORE_GAME__;
if (!Game?.ActiveChunks || !Game?.PreparedChunks) throw new Error("Game must load before shelf stocking.");

const StockableNames = new Set([
  "Shelf_Large",
  "Bookshelf",
  "RetailLivingShelfR79",
  "RetailBedroomCabinetR79",
  "RetailStorageShelfR79",
  "RetailDisplayCabinetR79",
  "RetailStorageCabinetR79"
]);
const Processing = new WeakSet();
const ShelfRaycaster = new THREE.Raycaster();
const ShelfRayOrigin = new THREE.Vector3();
const ShelfRayDirection = new THREE.Vector3(0, -1, 0);
const ShelfBox = new THREE.Box3();
const DecorationBox = new THREE.Box3();
const ShelfSize = new THREE.Vector3();
const DecorationCenter = new THREE.Vector3();

function StockTargets(Chunk) {
  if (String(Chunk?.Layout?.Theme || "").toUpperCase() === "BATHROOMS") return [];
  const Targets = [];
  const Add = Object => {
    if (!Object?.parent || !StockableNames.has(Object.name) || Targets.includes(Object)) return;
    const SlotName = String(Object.userData?.LayoutSlot || "");
    const Slot = Chunk.Layout?.Slots?.[SlotName];
    if (!Slot?.StockStyle) return;
    Targets.push(Object);
  };
  for (const Model of Chunk.Models || []) Add(Model);
  for (const Object of Chunk.Group?.children || []) Add(Object);
  Targets.sort((A, B) => String(A.userData?.LayoutSlot || "").localeCompare(String(B.userData?.LayoutSlot || "")));
  return Targets.slice(0, 6);
}

function ExistingStock(Chunk) {
  const Stock = [];
  Chunk.Group?.traverse?.(Object => {
    if (Object?.userData?.ShelfStockR83) Stock.push(Object);
  });
  return Stock;
}

function RemoveExistingStock(Chunk) {
  for (const Object of ExistingStock(Chunk)) Object.parent?.remove(Object);
}

function PlansFor(Chunk, Target) {
  const SlotName = String(Target.userData?.LayoutSlot || "");
  const Slot = Chunk.Layout?.Slots?.[SlotName];
  if (Slot?.StockStyle !== "Books") return [];
  return [
    { Key: OnlineDecorationKeys.BookSet, TargetHeight: 0.18, HeightRatio: 0.29, OffsetX: -0.22, OffsetZ: 0, RotationY: 0.08 },
    { Key: OnlineDecorationKeys.BookSingle, TargetHeight: 0.14, HeightRatio: 0.56, OffsetX: 0.20, OffsetZ: 0.01, RotationY: -0.24 },
    { Key: OnlineDecorationKeys.BookSet, TargetHeight: 0.16, HeightRatio: 0.80, OffsetX: -0.05, OffsetZ: 0, RotationY: 0.12 }
  ];
}

function Yield() {
  return WaitForWorkSlice();
}

function SnapDecorationToShelf(Target, Decoration, Plan) {
  if (!Target?.parent || !Decoration?.isObject3D) return false;

  Target.updateWorldMatrix(true, true);
  Decoration.updateWorldMatrix(true, true);

  ShelfBox.setFromObject(Target);
  DecorationBox.setFromObject(Decoration);
  if (ShelfBox.isEmpty() || DecorationBox.isEmpty()) return false;

  ShelfBox.getSize(ShelfSize);
  DecorationBox.getCenter(DecorationCenter);

  const HeightRatio = THREE.MathUtils.clamp(Number(Plan?.HeightRatio) || 0.5, 0.05, 1.0);
  const DesiredY = ShelfBox.min.y + ShelfSize.y * HeightRatio;

  ShelfRayOrigin.set(
    DecorationCenter.x,
    ShelfBox.max.y + 0.08,
    DecorationCenter.z
  );

  ShelfRaycaster.set(ShelfRayOrigin, ShelfRayDirection);
  ShelfRaycaster.near = 0;
  ShelfRaycaster.far = ShelfSize.y + 0.20;

  const Hits = ShelfRaycaster.intersectObject(Target, true);
  let BestHit = null;
  let BestDistance = Infinity;

  for (const Hit of Hits) {
    if (!Hit?.point) continue;
    if (Hit.point.y < ShelfBox.min.y - 0.01 || Hit.point.y > ShelfBox.max.y + 0.01) continue;
    const Distance = Math.abs(Hit.point.y - DesiredY);
    if (Distance >= BestDistance) continue;
    BestDistance = Distance;
    BestHit = Hit;
  }

  if (!BestHit) return false;

  DecorationBox.setFromObject(Decoration);
  const Lift = BestHit.point.y + 0.004 - DecorationBox.min.y;
  if (!Number.isFinite(Lift)) return false;

  Decoration.position.y += Lift;
  Decoration.updateWorldMatrix(true, true);
  Decoration.userData.ShelfSurfaceSnappedR91 = true;
  Decoration.userData.ShelfSurfaceY = BestHit.point.y;
  return true;
}

export async function ProcessChunk(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group || Processing.has(Chunk)) return;
  if (Chunk.Group.userData?.PresentationReadyR83) return;

  const Targets = StockTargets(Chunk);
  const Expected = Targets.length * 3;
  const Existing = ExistingStock(Chunk);
  if (Chunk.Group.userData?.ShelfStockR83 && Existing.length >= Expected) return;

  Processing.add(Chunk);
  try {
    RemoveExistingStock(Chunk);
    let DecorationIndex = 0;
    for (let TargetIndex = 0; TargetIndex < Targets.length; TargetIndex += 1) {
      const Target = Targets[TargetIndex];
      for (const Plan of PlansFor(Chunk, Target)) {
        try {
          const Decoration = await CreateOnlineSurfaceDecoration(Plan.Key, Target, Plan);
          if (!Decoration) continue;
          Decoration.name = `OnlineSurfaceDecorationR76-ShelfStockR83-${DecorationIndex}`;
          Decoration.userData.ChunkId = Chunk.Id;
          Decoration.userData.DecorationNoCollision = false;
          Decoration.userData.ShelfStockR83 = true;
          SnapDecorationToShelf(Target, Decoration, Plan);
          Chunk.Group.add(Decoration);
          DecorationIndex += 1;
        } catch (Error) {
          console.warn("Shelf stock decoration unavailable", Error);
        }
      }
      // Raycasting and decoration cloning for each stocked shelf is
      // intentionally split across frames.
      if (TargetIndex < Targets.length - 1) await Yield();
    }
    Chunk.Group.userData.ShelfStockR83 = true;
    Chunk.Group.userData.ShelfStockCountR83 = DecorationIndex;
  } finally {
    Processing.delete(Chunk);
  }
}

export function IsStocked(Chunk) {
  const Targets = StockTargets(Chunk);
  return ExistingStock(Chunk).length >= Targets.length * 3;
}

await PreloadOnlineDecorations().catch(() => {});

function Discover() {
  if (window.__STORE_BOOT_CRITICAL__) return;
  for (const Chunk of Game.PreparedChunks.values()) if (!Chunk?.Group?.userData?.PresentationReadyR83) ProcessChunk(Chunk).catch(() => {});
  for (const Chunk of Game.ActiveChunks.values()) if (!Chunk?.Group?.userData?.PresentationReadyR83) ProcessChunk(Chunk).catch(() => {});
}

// Initial discovery only. Runtime stocking is sequenced by presentation
// so it cannot collide with other chunk passes mid-frame.
Discover();

window.__STORE_SHELF_STOCK_R83__ = { ProcessChunk, IsStocked, Discover };
window.__STORE_SHELF_STOCK_BUILD__ = "V0.35.47-BOOT-OWNER";