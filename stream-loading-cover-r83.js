import * as THREE from "three";

const Game = window.__STORE_GAME__;
if (
  !Game?.Camera ||
  !Game?.Scene ||
  !Game?.ActiveChunks ||
  !Game?.PreparedChunks ||
  !Game?.ChunkIndexForZ
) {
  throw new Error("Game must load before stream loading cover.");
}

const Overlay = document.createElement("div");
Overlay.id = "StreamLoadingCoverR83";
Overlay.setAttribute("aria-hidden", "true");
Overlay.innerHTML = `
  <div class="StreamLoadingInnerR83">
    <strong>DISTANT AISLE FORMING</strong>
    <span>The next showroom is being prepared...</span>
    <i></i>
  </div>
`;

Object.assign(Overlay.style, {
  position: "fixed",
  left: "50%",
  bottom: "74px",
  transform: "translateX(-50%)",
  zIndex: "1200",
  opacity: "0",
  visibility: "hidden",
  pointerEvents: "none",
  transition: "opacity 120ms linear"
});

const Style = document.createElement("style");
Style.textContent = `
.StreamLoadingInnerR83{
  min-width:230px;
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:6px;
  padding:10px 14px 9px;
  border:1px solid rgba(211,181,120,.22);
  background:rgba(17,19,16,.84);
  box-shadow:0 12px 28px rgba(0,0,0,.24);
  font-family:Arial,sans-serif;
  letter-spacing:.09em;
  text-align:center
}
.StreamLoadingInnerR83 strong{font-size:.70rem;font-weight:900;color:#eee4cf}
.StreamLoadingInnerR83 span{font-size:.53rem;color:#9e9d91;letter-spacing:.06em}
.StreamLoadingInnerR83 i{
  width:118px;
  height:2px;
  margin-top:3px;
  background:linear-gradient(90deg,transparent,#9e9b84,transparent);
  background-size:70% 100%;
  animation:StreamLoadR83 .95s linear infinite
}
@keyframes StreamLoadR83{
  from{background-position:-160px 0}
  to{background-position:160px 0}
}
`;
document.head.appendChild(Style);
document.body.appendChild(Overlay);

const PRIORITY_DISTANCE = 72;
const NOTICE_DISTANCE = 1.35;
const NOTICE_MAX_MS = 1600;
const STRICT_AHEAD = 3;
const STRICT_BEHIND = 2;
const HORIZON_PROXY_LENGTH = 180;
const HORIZON_PROXY_WIDTH = 34;
const HORIZON_PROXY_HEIGHT = 3.72;
const HORIZON_OVERLAP = 2.4;
const PriorityFlights = new Map();
const LegacyStreamBarrierPattern = /StreamLoading|LoadingGate|StoreBoundary|StreamBarrier|FrontierBarrier|StreamingBarrier/i;

let OverlayVisible = false;
let HorizonProxyGroup = null;
let HorizonProxyBoundary = Number.NaN;
let NoticeIndex = Number.NaN;
let NoticeStartedAt = -Infinity;

function IsLegacyStreamBarrierEntry(Entry) {
  if (!Entry) return false;
  const Type = String(Entry.Type || "");
  const ObjectName = String(Entry.CollisionObject?.name || "");
  return LegacyStreamBarrierPattern.test(Type) ||
    LegacyStreamBarrierPattern.test(ObjectName) ||
    Entry.StreamLoadingBarrierR83 === true;
}

function PurgeLegacyStreamBarriers() {
  if (Array.isArray(Game.CollisionBoxes)) {
    for (let Index = Game.CollisionBoxes.length - 1; Index >= 0; Index -= 1) {
      const Entry = Game.CollisionBoxes[Index];
      if (!IsLegacyStreamBarrierEntry(Entry)) continue;
      Entry.Active = false;
      Game.CollisionBoxes.splice(Index, 1);
    }
  }

  const Seen = new Set();
  for (const Collection of [Game.ActiveChunks, Game.PreparedChunks]) {
    for (const Chunk of Collection?.values?.() || []) {
      if (!Chunk || Seen.has(Chunk)) continue;
      Seen.add(Chunk);
      for (let Index = (Chunk.CollisionEntries?.length || 0) - 1; Index >= 0; Index -= 1) {
        const Entry = Chunk.CollisionEntries[Index];
        if (!IsLegacyStreamBarrierEntry(Entry)) continue;
        Entry.Active = false;
        Chunk.CollisionEntries.splice(Index, 1);
      }
    }
  }

  const Remove = [];
  Game.Scene.traverse?.(Object => {
    if (!Object || Object === HorizonProxyGroup) return;
    const Name = String(Object.name || "");
    if (
      LegacyStreamBarrierPattern.test(Name) ||
      Object.userData?.StreamLoadingBarrierR83 === true ||
      Object.name === "StreamDistanceHazeR101"
    ) {
      Remove.push(Object);
    }
  });

  for (const Object of Remove) Object.parent?.remove(Object);
}

function EnsureHorizonProxy() {
  if (HorizonProxyGroup) return HorizonProxyGroup;

  const Group = new THREE.Group();
  Group.name = "StoreHorizonForward";
  Group.userData.StoreHorizon = true;
  Group.userData.StreamAmbientR101 = true;
  Group.userData.DecorationNoCollision = true;
  Group.userData.IgnoreRayCollisionR35 = true;

  const FloorMaterial = new THREE.MeshBasicMaterial({ color: 0x4f4a42, fog: true });
  const CeilingMaterial = new THREE.MeshBasicMaterial({ color: 0x3c3d39, fog: true });
  const WallMaterial = new THREE.MeshBasicMaterial({ color: 0x56564f, fog: true });

  const Floor = new THREE.Mesh(
    new THREE.BoxGeometry(HORIZON_PROXY_WIDTH, 0.08, HORIZON_PROXY_LENGTH),
    FloorMaterial
  );
  Floor.name = "HorizonFloorR106";
  Floor.position.set(0, -0.04, 0);

  const Ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(HORIZON_PROXY_WIDTH, 0.08, HORIZON_PROXY_LENGTH),
    CeilingMaterial
  );
  Ceiling.name = "HorizonCeilingR106";
  Ceiling.position.set(0, HORIZON_PROXY_HEIGHT, 0);

  const LeftWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, HORIZON_PROXY_HEIGHT, HORIZON_PROXY_LENGTH),
    WallMaterial
  );
  LeftWall.name = "HorizonWallLeftR106";
  LeftWall.position.set(-16.92, HORIZON_PROXY_HEIGHT * 0.5, 0);

  const RightWall = LeftWall.clone();
  RightWall.name = "HorizonWallRightR106";
  RightWall.position.x = 16.92;

  for (const Object of [Floor, Ceiling, LeftWall, RightWall]) {
    Object.userData.StreamAmbientR101 = true;
    Object.userData.DecorationNoCollision = true;
    Object.userData.IgnoreRayCollisionR35 = true;
    Object.frustumCulled = true;
    Group.add(Object);
  }

  const LightRows = [];
  for (let Distance = 6; Distance < HORIZON_PROXY_LENGTH - 4; Distance += 9) {
    for (const X of [-9, 0, 9]) {
      LightRows.push({ X, Z: HORIZON_PROXY_LENGTH * 0.5 - Distance });
    }
  }

  const LightGeometry = new THREE.BoxGeometry(4.5, 0.045, 0.28);
  const LightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffdfaa,
    fog: true,
    toneMapped: false
  });
  const Lights = new THREE.InstancedMesh(LightGeometry, LightMaterial, LightRows.length);
  Lights.name = "HorizonLightGlowR106";
  Lights.userData.StreamAmbientR101 = true;
  Lights.userData.DecorationNoCollision = true;
  Lights.userData.IgnoreRayCollisionR35 = true;

  const Matrix = new THREE.Matrix4();
  for (let Index = 0; Index < LightRows.length; Index += 1) {
    const Row = LightRows[Index];
    Matrix.makeTranslation(Row.X, HORIZON_PROXY_HEIGHT - 0.12, Row.Z);
    Lights.setMatrixAt(Index, Matrix);
  }
  Lights.instanceMatrix.needsUpdate = true;
  Lights.computeBoundingBox?.();
  Lights.computeBoundingSphere?.();
  Group.add(Lights);

  Group.visible = false;
  Game.Scene.add(Group);
  HorizonProxyGroup = Group;
  return Group;
}

function UpdateHorizonProxy() {
  const Group = EnsureHorizonProxy();
  let Furthest = null;

  for (const Chunk of Game.ActiveChunks.values()) {
    if (
      !Chunk?.Ready ||
      Chunk.Cancelled ||
      !Chunk.Active ||
      Chunk.Group?.parent !== Game.Scene ||
      Chunk.Group?.visible === false
    ) continue;
    if (!Furthest || Chunk.Index > Furthest.Index) Furthest = Chunk;
  }

  if (!Furthest) {
    Group.visible = false;
    return;
  }

  const Boundary = Number(Furthest.BottomZ) + HORIZON_OVERLAP;
  if (Boundary !== HorizonProxyBoundary) {
    HorizonProxyBoundary = Boundary;
    Group.position.set(0, 0, Boundary - HORIZON_PROXY_LENGTH * 0.5);
    Group.updateMatrix();
    Group.updateMatrixWorld(true);
  }

  Group.visible = true;
}

function FindChunk(Index) {
  const Active = Game.ActiveChunks.get(Index);
  if (Active) return Active;

  for (const Chunk of Game.PreparedChunks.values()) {
    if (Chunk?.Index === Index && !Chunk.Cancelled) return Chunk;
  }

  return null;
}

function IsTraversalReady(Chunk) {
  return Boolean(
    Chunk?.Ready &&
    !Chunk.Cancelled &&
    (
      Chunk.Group?.userData?.PresentationReadyR83
    )
  );
}

function IsAlreadyVisible(Chunk) {
  if (!Chunk?.Ready || Chunk.Cancelled || !Chunk.Group) return false;
  if (!Chunk.Active) return false;
  if (Game.ActiveChunks.get(Chunk.Index) !== Chunk) return false;
  return Chunk.Group.parent === Game.Scene && Chunk.Group.visible !== false;
}

function PrioritizeIndex(Index) {
  if (!Number.isInteger(Index) || Index < 0) return null;

  const Existing = FindChunk(Index);
  if (IsTraversalReady(Existing)) return Promise.resolve(true);
  if (PriorityFlights.has(Index)) return PriorityFlights.get(Index);

  const Source = Existing
    ? Promise.resolve(Existing)
    : Promise.resolve(Game.PrepareChunk?.(Index));

  const Flight = Source
    .then(Chunk => {
      if (!Chunk || Chunk.Cancelled) return false;
      const Presentation = window.__STORE_PRESENTATION_READY_R83__;
      return Presentation?.FinalizeChunk?.(Chunk) ?? false;
    })
    .catch(Error => {
      console.warn(`Strict stream preparation failed for chunk ${Index}`, Error);
      return false;
    })
    .finally(() => {
      PriorityFlights.delete(Index);
    });

  PriorityFlights.set(Index, Flight);
  return Flight;
}

function EnsureStrictBuffer(CurrentIndex) {
  for (let Offset = 1; Offset <= STRICT_AHEAD; Offset += 1) {
    const Index = CurrentIndex + Offset;
    const Chunk = FindChunk(Index);
    if (!IsTraversalReady(Chunk)) PrioritizeIndex(Index);
  }

  const Current = FindChunk(CurrentIndex);
  if (!IsTraversalReady(Current)) PrioritizeIndex(CurrentIndex);

  for (let Offset = 1; Offset <= STRICT_BEHIND; Offset += 1) {
    const Index = CurrentIndex - Offset;
    if (Index < 0) break;
    const Chunk = FindChunk(Index);
    if (!IsTraversalReady(Chunk)) PrioritizeIndex(Index);
  }
}

function SetOverlayVisible(Value) {
  const Next = Boolean(Value);
  if (OverlayVisible === Next) return;
  OverlayVisible = Next;
  Overlay.style.opacity = Next ? "1" : "0";
  Overlay.style.visibility = Next ? "visible" : "hidden";
  Overlay.setAttribute("aria-hidden", Next ? "false" : "true");
}

function SetLoadingState(Value) {
  window.__STORE_STREAM_LOADING__ = Boolean(Value);
}

function Show(CurrentChunk) {
  if (!CurrentChunk) return;
  SetLoadingState(true);
}

function Hide() {
  SetLoadingState(false);
  SetOverlayVisible(false);
  NoticeIndex = Number.NaN;
  NoticeStartedAt = -Infinity;
}

function Tick() {
  if (window.__STORE_BOOT_CRITICAL__ || window.__STORE_GAMEPLAY_STARTED__ !== true) {
    Hide();
    requestAnimationFrame(Tick);
    return;
  }

  const CurrentIndex = Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z));
  const Current = Game.ActiveChunks.get(CurrentIndex);
  UpdateHorizonProxy();
  window.__STORE_DISTANCE_HAZE_R82__?.Apply?.();

  if (!Current) {
    Hide();
    requestAnimationFrame(Tick);
    return;
  }

  EnsureStrictBuffer(CurrentIndex);

  const NextIndex = CurrentIndex + 1;
  let Next = FindChunk(NextIndex);
  let NextReady = IsTraversalReady(Next);
  let NextVisible = IsAlreadyVisible(Next);
  const DistanceToForwardEdge = Math.max(0, Game.Camera.position.z - Current.BottomZ);

  if (!NextReady && DistanceToForwardEdge <= PRIORITY_DISTANCE) {
    PrioritizeIndex(NextIndex);
  }

  if (NextReady && !NextVisible) {
    Game.TryActivateIndex?.(NextIndex);
    Next = FindChunk(NextIndex);
    NextReady = IsTraversalReady(Next);
    NextVisible = IsAlreadyVisible(Next);
  }

  if (NextVisible) {
    Hide();
    requestAnimationFrame(Tick);
    return;
  }

  SetLoadingState(true);

  if (DistanceToForwardEdge <= NOTICE_DISTANCE) {
    if (NoticeIndex !== NextIndex) {
      NoticeIndex = NextIndex;
      NoticeStartedAt = performance.now();
    }
    SetOverlayVisible(performance.now() - NoticeStartedAt <= NOTICE_MAX_MS);
  } else {
    SetOverlayVisible(false);
    NoticeIndex = Number.NaN;
    NoticeStartedAt = -Infinity;
  }

  requestAnimationFrame(Tick);
}

EnsureHorizonProxy();
PurgeLegacyStreamBarriers();
requestAnimationFrame(Tick);

addEventListener("pagehide", () => {
  Hide();
  if (HorizonProxyGroup) HorizonProxyGroup.visible = false;
}, { once: true });

window.__STORE_STREAM_LOADING_R83__ = {
  Show,
  Hide,
  PrioritizeNext: PrioritizeIndex,
  PrioritizeIndex,
  EnsureStrictBuffer,
  IsTraversalReady,
  IsAlreadyVisible
};
window.__STORE_STREAM_LOADING_BUILD__ = "V0.35.56-NO-VISIBLE-FRONTIER";
