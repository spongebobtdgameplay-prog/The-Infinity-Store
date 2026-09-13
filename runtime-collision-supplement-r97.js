import {
  THREE,
  IsVisualHelper,
  IsWalkableSurface
} from "./store-engine-core-r95.js";

const Build = "V0.35.67-R97-COLLISION-SUPPLEMENT";
const EyeHeight = 1.68;
const CollisionChunkRadius = 2;
const RefreshIntervalMs = 650;
const MaxPiecesPerRoot = 40;
const ManagedChunks = new Map();
const TempPoint = new THREE.Vector3();
const TempScale = new THREE.Vector3();
let Installed = false;
let Timer = 0;

function IsOldRuntimeEntry(Entry) {
  const Type = String(Entry?.Type || "");
  return Boolean(
    Entry?.CoreFixR95 === true ||
    Entry?.CoreFixR96 === true ||
    /VisiblePhysical(WorldR95|ObjectR96)/i.test(Type)
  );
}

function RemoveEntry(Game, Chunk, Entry) {
  if (!Entry) return;
  Entry.Active = false;
  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    if (Game.CollisionBoxes[Index] === Entry) Game.CollisionBoxes.splice(Index, 1);
  }
  const LocalIndex = Chunk?.CollisionEntries?.indexOf?.(Entry) ?? -1;
  if (LocalIndex >= 0) Chunk.CollisionEntries.splice(LocalIndex, 1);
}

function PurgeOldRuntimeCollision(Game) {
  for (const Chunk of [
    ...(Game.ActiveChunks?.values?.() || []),
    ...(Game.PreparedChunks?.values?.() || [])
  ]) {
    if (!Chunk?.CollisionEntries) continue;
    for (const Entry of [...Chunk.CollisionEntries]) {
      if (IsOldRuntimeEntry(Entry)) RemoveEntry(Game, Chunk, Entry);
    }
  }

  for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
    if (IsOldRuntimeEntry(Game.CollisionBoxes[Index])) {
      Game.CollisionBoxes[Index].Active = false;
      Game.CollisionBoxes.splice(Index, 1);
    }
  }
}

function IsStructuralRoot(Root) {
  const Name = String(Root?.name || "");
  return /^(Floor|Ceiling|WallLeft|WallRight|Baseboard|ShowroomPartition|PartitionCap|PartitionBase|RearStoreClosureR80|RearStoreWallR80|RearStoreBaseboardR80)/i.test(Name);
}

function BelongsToRoot(Object, Root) {
  let Current = Object || null;
  while (Current) {
    if (Current === Root) return true;
    Current = Current.parent || null;
  }
  return false;
}

function CoveredByCoreFix(Chunk, Root) {
  const Slot = String(Root?.userData?.LayoutSlot || "");
  for (const Entry of Chunk?.CollisionEntries || []) {
    if (!Entry?.CoreFixR87 || Entry.Active === false && !Chunk.Active) continue;
    if (
      Entry.CollisionObject === Root ||
      Entry.SourceModel === Root ||
      Entry.Model === Root ||
      BelongsToRoot(Entry.CollisionObject, Root) ||
      BelongsToRoot(Entry.SourceModel, Root)
    ) return true;
    if (Slot && String(Entry.LayoutSlot || Entry.CollisionObject?.userData?.LayoutSlot || "") === Slot) return true;
  }
  return false;
}

function IsCollisionMesh(Object) {
  if (!Object?.isMesh || !Object.geometry?.attributes?.position) return false;
  if (Object.userData?.ForceNoCollisionR95 === true) return false;
  if (Object.userData?.DecorationNoCollision === true) return false;
  if (Object.userData?.RenderBatchR104 === true) return false;
  if (Object.userData?.RenderBatchedSourceR104 === true) return false;
  if (IsVisualHelper(Object) || IsWalkableSurface(Object)) return false;
  if (Object.visible === false) return false;

  const Name = String(Object.name || "");
  if (/Text|Label|Glow|Highlight|Crosshair|PriceTag|PriceSign|PricePlacard/i.test(Name)) return false;

  const Materials = Array.isArray(Object.material) ? Object.material : [Object.material];
  if (Materials.length && Materials.every(Material => {
    if (!Material || Material.visible === false) return true;
    return Material.transparent === true && Number(Material.opacity) <= 0.05;
  })) return false;

  return true;
}

function BuildPieces(Root) {
  Root.updateWorldMatrix(true, true);
  const Pieces = [];
  const Bounds = new THREE.Box3().makeEmpty();

  Root.traverse(Object => {
    if (Pieces.length >= MaxPiecesPerRoot || !IsCollisionMesh(Object)) return;
    Object.geometry.computeBoundingBox?.();
    const LocalBox = Object.geometry.boundingBox?.clone?.();
    if (!LocalBox || LocalBox.isEmpty()) return;

    Object.updateWorldMatrix(true, false);
    const WorldBox = new THREE.Box3().setFromObject(Object);
    if (WorldBox.isEmpty()) return;

    Object.getWorldScale(TempScale);
    const Scale = new THREE.Vector3(
      Math.max(Math.abs(TempScale.x), 0.0001),
      Math.max(Math.abs(TempScale.y), 0.0001),
      Math.max(Math.abs(TempScale.z), 0.0001)
    );

    Pieces.push({
      LocalBox,
      Inverse: Object.matrixWorld.clone().invert(),
      Scale,
      WorldBox
    });
    Bounds.union(WorldBox);
  });

  return { Pieces, Bounds };
}

function CircleHitsPiece(Position, Radius, Piece) {
  const FeetY = Position.y - EyeHeight + 0.025;
  const HeadY = Position.y + 0.08;
  if (Piece.WorldBox.max.y < FeetY || Piece.WorldBox.min.y > HeadY) return false;

  if (
    Position.x + Radius < Piece.WorldBox.min.x ||
    Position.x - Radius > Piece.WorldBox.max.x ||
    Position.z + Radius < Piece.WorldBox.min.z ||
    Position.z - Radius > Piece.WorldBox.max.z
  ) return false;

  TempPoint.copy(Position).applyMatrix4(Piece.Inverse);
  const RadiusX = Radius / Piece.Scale.x;
  const RadiusZ = Radius / Piece.Scale.z;
  const ClosestX = THREE.MathUtils.clamp(TempPoint.x, Piece.LocalBox.min.x, Piece.LocalBox.max.x);
  const ClosestZ = THREE.MathUtils.clamp(TempPoint.z, Piece.LocalBox.min.z, Piece.LocalBox.max.z);
  const DX = (TempPoint.x - ClosestX) / Math.max(RadiusX, 0.0001);
  const DZ = (TempPoint.z - ClosestZ) / Math.max(RadiusZ, 0.0001);
  return DX * DX + DZ * DZ <= 1;
}

function CircleHitsPieces(Position, Radius, Record) {
  if (!Record?.Pieces?.length || Record.Bounds.isEmpty()) return false;
  if (
    Position.x + Radius < Record.Bounds.min.x ||
    Position.x - Radius > Record.Bounds.max.x ||
    Position.z + Radius < Record.Bounds.min.z ||
    Position.z - Radius > Record.Bounds.max.z
  ) return false;

  for (const Piece of Record.Pieces) {
    if (CircleHitsPiece(Position, Radius, Piece)) return true;
  }
  return false;
}

function SegmentExpandedBoundsFraction(Start, End, Bounds, Padding = 0) {
  if (!Bounds?.min || !Bounds?.max) return null;

  const DirectionX = End.x - Start.x;
  const DirectionY = End.y - Start.y;
  const DirectionZ = End.z - Start.z;
  let Minimum = 0;
  let Maximum = 1;

  for (const [Axis, Direction] of [["x", DirectionX], ["y", DirectionY], ["z", DirectionZ]]) {
    const Origin = Start[Axis];
    const Min = Bounds.min[Axis] - Padding;
    const Max = Bounds.max[Axis] + Padding;

    // If the camera target itself is inside a collider, movement collision owns
    // that error. Treating it as a camera wall is what caused the old 0.42m lock.
    if (Origin >= Min && Origin <= Max && Minimum === 0) {
      // Continue through the slab; another axis may still reject the box.
    }

    if (Math.abs(Direction) <= 0.0000001) {
      if (Origin < Min || Origin > Max) return null;
      continue;
    }

    let Near = (Min - Origin) / Direction;
    let Far = (Max - Origin) / Direction;
    if (Near > Far) [Near, Far] = [Far, Near];
    Minimum = Math.max(Minimum, Near);
    Maximum = Math.min(Maximum, Far);
    if (Minimum > Maximum) return null;
  }

  if (Maximum < 0 || Minimum > 1) return null;
  return THREE.MathUtils.clamp(Minimum, 0, 1);
}

function PointInsideBounds(Point, Bounds, Padding = 0) {
  return Point.x >= Bounds.min.x - Padding && Point.x <= Bounds.max.x + Padding &&
    Point.y >= Bounds.min.y - Padding && Point.y <= Bounds.max.y + Padding &&
    Point.z >= Bounds.min.z - Padding && Point.z <= Bounds.max.z + Padding;
}

function ProbeCameraSegment(Start, End, Radius = 0.18) {
  const Game = window.__STORE_GAME__;
  const Entries = Game?.CollisionBoxes || [];
  let Fraction = 1;
  let HitEntry = null;

  for (const Entry of Entries) {
    if (!Entry || Entry.Active === false || IsOldRuntimeEntry(Entry)) continue;
    const Bounds = Entry.OriginalStructureBox || Entry.OriginalBox || Entry.Box || null;
    if (!Bounds?.min || !Bounds?.max) continue;

    // Never let an oversized/invalid entry that already contains the player
    // target collapse third person to minimum distance.
    if (PointInsideBounds(Start, Bounds, Radius * 0.35)) continue;

    const Hit = SegmentExpandedBoundsFraction(Start, End, Bounds, Radius);
    if (Hit === null || Hit >= Fraction) continue;
    Fraction = Hit;
    HitEntry = Entry;
  }

  return { Hit: Boolean(HitEntry), Fraction, Entry: HitEntry };
}

function MakeEntry(Chunk, Root, Record) {
  const StableBounds = Record.Bounds.clone();
  const Entry = {
    Box: StableBounds,
    OriginalBox: StableBounds.clone(),
    OriginalLegacyBox: StableBounds.clone(),
    ChunkId: Chunk.Id,
    Type: `VisibleSupplementR97:${String(Root.name || "Object")}`,
    Active: false,
    CoreFixR97: true,
    PreciseGeometry: false,
    ProceduralBodyContact: true,
    CollisionObject: Root,
    LayoutSlot: Root.userData?.LayoutSlot || "",
    PieceCountR97: Record.Pieces.length,
    TestPlayerCollision(Position, Radius = 0.255) {
      return CircleHitsPieces(Position, Radius, Record);
    },
    TestCollision(Position, Radius = 0.255) {
      return CircleHitsPieces(Position, Radius, Record);
    }
  };
  return Entry;
}

function RootStamp(Root) {
  let MeshCount = 0;
  Root.traverse(Object => {
    if (IsCollisionMesh(Object)) MeshCount += 1;
  });
  const E = Root.matrixWorld.elements;
  return `${Root.uuid}:${MeshCount}:${E[0].toFixed(3)}:${E[5].toFixed(3)}:${E[10].toFixed(3)}:${E[12].toFixed(3)}:${E[13].toFixed(3)}:${E[14].toFixed(3)}`;
}

function ChunkStamp(Chunk) {
  Chunk.Group?.updateWorldMatrix?.(true, true);
  const Parts = [];
  for (const Root of Chunk.Group?.children || []) {
    if (!Root?.isObject3D || IsStructuralRoot(Root) || IsWalkableSurface(Root)) continue;
    if (CoveredByCoreFix(Chunk, Root)) continue;
    Parts.push(RootStamp(Root));
  }
  return Parts.join("|");
}

function SyncEntry(Game, Chunk, Entry) {
  const Active = Boolean(Chunk?.Active && !Chunk?.Cancelled && Chunk?.Group?.parent);
  Entry.Active = Active;
  const Index = Game.CollisionBoxes.indexOf(Entry);
  if (Active && Index < 0) Game.CollisionBoxes.push(Entry);
  else if (!Active && Index >= 0) Game.CollisionBoxes.splice(Index, 1);
}

function RemoveChunkRecord(Game, Chunk) {
  const Existing = ManagedChunks.get(Chunk);
  if (!Existing) return;
  for (const Entry of Existing.Entries) RemoveEntry(Game, Chunk, Entry);
  ManagedChunks.delete(Chunk);
}

function InstallChunk(Game, Chunk) {
  if (!Chunk?.Group || Chunk.Cancelled || !Chunk.Active) return false;
  const Stamp = ChunkStamp(Chunk);
  const Existing = ManagedChunks.get(Chunk);

  if (Existing?.Stamp === Stamp) {
    for (const Entry of Existing.Entries) SyncEntry(Game, Chunk, Entry);
    return false;
  }

  if (Existing) RemoveChunkRecord(Game, Chunk);

  const Entries = [];
  for (const Root of Chunk.Group.children || []) {
    if (!Root?.isObject3D || IsStructuralRoot(Root) || IsWalkableSurface(Root)) continue;
    if (Root.userData?.RenderBatchR104 === true) continue;
    if (CoveredByCoreFix(Chunk, Root)) continue;

    const Record = BuildPieces(Root);
    if (!Record.Pieces.length || Record.Bounds.isEmpty()) continue;

    const Entry = MakeEntry(Chunk, Root, Record);
    Chunk.CollisionEntries ||= [];
    Chunk.CollisionEntries.push(Entry);
    Entries.push(Entry);
    SyncEntry(Game, Chunk, Entry);
  }

  ManagedChunks.set(Chunk, { Stamp, Entries });
  Chunk.Group.userData ||= {};
  Chunk.Group.userData.CollisionSupplementR97 = true;
  Chunk.Group.userData.CollisionSupplementCountR97 = Entries.length;
  return true;
}

function CurrentChunkIndex(Game) {
  if (!Game?.Camera || typeof Game.ChunkIndexForZ !== "function") return 0;
  return Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z));
}

function Refresh() {
  const Game = window.__STORE_GAME__;
  if (!Game?.CollisionBoxes || !Game?.ActiveChunks) return false;

  PurgeOldRuntimeCollision(Game);
  const CurrentIndex = CurrentChunkIndex(Game);

  for (const Chunk of Game.ActiveChunks.values()) {
    if (!Chunk?.Group || Chunk.Cancelled || !Chunk.Active) continue;
    const Distance = Math.abs((Number(Chunk.Index) || 0) - CurrentIndex);
    if (Distance <= CollisionChunkRadius) InstallChunk(Game, Chunk);
  }

  for (const [Chunk] of [...ManagedChunks]) {
    const Distance = Math.abs((Number(Chunk?.Index) || 0) - CurrentIndex);
    if (Chunk?.Cancelled || !Chunk?.Active || Distance > CollisionChunkRadius) {
      RemoveChunkRecord(Game, Chunk);
    }
  }

  window.__STORE_COLLISION_SUPPLEMENT_R97__ = Object.freeze({
    Build,
    ProbeCameraSegment,
    CircleHitsPieces,
    Refresh
  });
  window.__STORE_COLLISION_SUPPLEMENT_BUILD__ = Build;
  return true;
}

function Install() {
  if (!Refresh()) return false;
  if (Installed) return true;
  Installed = true;
  Timer = setInterval(Refresh, RefreshIntervalMs);
  addEventListener("store-world-buffer-progress", Refresh);
  addEventListener("store-gameplay-started", Refresh);
  addEventListener("pagehide", () => {
    if (Timer) clearInterval(Timer);
  }, { once: true });
  return true;
}

if (!Install()) {
  let Attempts = 0;
  const Start = setInterval(() => {
    Attempts += 1;
    if (Install() || Attempts >= 240) clearInterval(Start);
  }, 50);
}

export { Install, Refresh, ProbeCameraSegment, CircleHitsPieces };
