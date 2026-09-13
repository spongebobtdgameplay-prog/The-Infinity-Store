import * as THREE from "three";

const Collision = window.__STORE_COLLISION_UTILITY__;
if (!Collision) throw new Error("Collision utility must load before procedural physics.");

const EyeHeight = 1.68;
const DefaultRadius = 0.48;
const Skin = 0.012;
const MaxStepHeight = 0.30;
const StepClearance = 0.018;
const SurfaceBlendWidth = 0.115;
const CurbBodyProbeRadius = 0.14;
const StepUpSpeed = 4.20;
const StepDownSpeed = 3.35;
const MaxSlides = 6;
const MaxSweepSteps = 18;
const BinarySteps = 8;
const ContactMergeDot = 0.965;

const WalkableSurfaces = new Map();
const NearbyEntries = [];
const ContactNormals = [];
const ContactEntries = [];

let VerticalStateInitialized = false;
let AuthoritativeFloorY = 0;

const Scratch = {
  Forward: new THREE.Vector3(),
  Right: new THREE.Vector3(),
  Desired: new THREE.Vector3(),
  DesiredDirection: new THREE.Vector3(),
  Start: new THREE.Vector3(),
  Position: new THREE.Vector3(),
  Remaining: new THREE.Vector3(),
  Leftover: new THREE.Vector3(),
  Probe: new THREE.Vector3(),
  Normal: new THREE.Vector3(),
  NormalSum: new THREE.Vector3(),
  Closest: new THREE.Vector3()
};

function FiniteBounds(Bounds) {
  return Boolean(
    Bounds?.min && Bounds?.max &&
    [Bounds.min.x, Bounds.min.y, Bounds.min.z, Bounds.max.x, Bounds.max.y, Bounds.max.z].every(Number.isFinite) &&
    Bounds.min.x <= Bounds.max.x &&
    Bounds.min.y <= Bounds.max.y &&
    Bounds.min.z <= Bounds.max.z
  );
}

function EntryBounds(Entry) {
  return Collision.EntryBounds?.(Entry) || Entry?.OriginalStructureBox || Entry?.OriginalBox || Entry?.Box || Entry || null;
}

function IsExplicitWalkable(Entry) {
  const Type = String(Entry?.Type || "");
  const Object = Entry?.CollisionObject;
  return Boolean(
    /Rug|Carpet|FloorSurface|WalkableSurface/i.test(Type) ||
    Object?.userData?.WalkableCarpetR87 ||
    Object?.userData?.DecorationKind === "Rug" ||
    Object?.userData?.DecorationKind === "LargeShowroomRug"
  );
}

function BoundsAt(Object) {
  if (!Object?.isObject3D || !Object.parent || !Object.visible) return null;
  Object.updateWorldMatrix(true, true);
  const Bounds = new THREE.Box3().setFromObject(Object);
  return Bounds.isEmpty() ? null : Bounds;
}

function SurfaceId(Object, ChunkId = "") {
  return `${ChunkId || Object?.userData?.ChunkId || "world"}:${Object?.uuid || "unknown"}`;
}

function RegisterWalkableSurface(Object, ChunkId = "") {
  const Bounds = BoundsAt(Object);
  if (!Bounds) return "";
  const Id = SurfaceId(Object, ChunkId);
  WalkableSurfaces.set(Id, {
    Id,
    Object,
    ChunkId: ChunkId || Object.userData?.ChunkId || "",
    Bounds
  });
  Object.userData.WalkableCarpetR87 = true;
  Object.userData.DecorationNoCollision = true;
  return Id;
}

function UnregisterWalkableSurface(Object) {
  for (const [Id, Record] of WalkableSurfaces) {
    if (Record.Object === Object) WalkableSurfaces.delete(Id);
  }
}

function UnregisterChunk(ChunkId) {
  for (const [Id, Record] of WalkableSurfaces) {
    if (Record.ChunkId === ChunkId) WalkableSurfaces.delete(Id);
  }
}

function RefreshWalkableSurface(Object) {
  for (const Record of WalkableSurfaces.values()) {
    if (Record.Object !== Object) continue;
    const Bounds = BoundsAt(Object);
    if (!Bounds) {
      WalkableSurfaces.delete(Record.Id);
      return false;
    }
    Record.Bounds.copy(Bounds);
    return true;
  }
  return false;
}

function RefreshWalkableSurfaces() {
  for (const [Id, Record] of WalkableSurfaces) {
    const Bounds = BoundsAt(Record.Object);
    if (!Bounds) {
      WalkableSurfaces.delete(Id);
      continue;
    }
    Record.Bounds.copy(Bounds);
  }
}

function SmoothStep01(Value) {
  const T = THREE.MathUtils.clamp(Value, 0, 1);
  return T * T * (3 - 2 * T);
}

function WalkableSupport(Position, Bounds, ProbeRadius = 0) {
  const Margin = Math.min(
    Position.x - Bounds.min.x,
    Bounds.max.x - Position.x,
    Position.z - Bounds.min.z,
    Bounds.max.z - Position.z
  );
  const Width = Bounds.max.x - Bounds.min.x;
  const Depth = Bounds.max.z - Bounds.min.z;
  const Blend = Math.min(SurfaceBlendWidth, Math.max(0.045, Math.min(Width, Depth) * 0.20));
  const ContactMargin = Margin + Math.max(0, Number(ProbeRadius) || 0);
  return SmoothStep01((ContactMargin + Blend) / (Blend * 2));
}

function WalkableSurfaceHeight(Position, CurrentFeetY = 0) {
  let Height = 0;
  for (const Record of WalkableSurfaces.values()) {
    const Bounds = Record.Bounds;
    if (!FiniteBounds(Bounds)) continue;
    const Support = WalkableSupport(Position, Bounds, CurbBodyProbeRadius);
    if (Support <= 0.001) continue;
    const Rise = Bounds.max.y - CurrentFeetY;
    if (Rise > MaxStepHeight + StepClearance) continue;
    Height = Math.max(Height, Bounds.max.y * Support);
  }
  return Height;
}

function SurfaceHeight(Position) {
  return Math.max(0, WalkableSurfaceHeight(Position, AuthoritativeFloorY));
}

function CameraBasis(Camera) {
  Scratch.Forward.set(0, 0, -1).applyQuaternion(Camera.quaternion);
  Scratch.Forward.y = 0;
  if (Scratch.Forward.lengthSq() <= 0.000001) Scratch.Forward.set(0, 0, -1);
  else Scratch.Forward.normalize();

  Scratch.Right.set(1, 0, 0).applyQuaternion(Camera.quaternion);
  Scratch.Right.y = 0;
  if (Scratch.Right.lengthSq() <= 0.000001) Scratch.Right.set(1, 0, 0);
  else Scratch.Right.normalize();
}

function MoveToward(Current, Target, MaximumDelta) {
  if (!Number.isFinite(Current)) return Target;
  if (!Number.isFinite(Target)) return Current;
  if (Current < Target) return Math.min(Target, Current + MaximumDelta);
  if (Current > Target) return Math.max(Target, Current - MaximumDelta);
  return Current;
}

function EffectiveCollisionEntries(Entries) {
  if (Array.isArray(Entries)) return Entries;
  const GlobalEntries = window.__STORE_COLLISION_BOXES__;
  return Array.isArray(GlobalEntries) ? GlobalEntries : [];
}

function CollectNearbyEntries(Start, Desired, Radius, Entries) {
  NearbyEntries.length = 0;
  const Padding = Math.max(0.12, Radius + Skin + 0.08);
  const EndX = Start.x + Desired.x;
  const EndZ = Start.z + Desired.z;
  const MinX = Math.min(Start.x, EndX) - Padding;
  const MaxX = Math.max(Start.x, EndX) + Padding;
  const MinZ = Math.min(Start.z, EndZ) - Padding;
  const MaxZ = Math.max(Start.z, EndZ) + Padding;

  for (const Entry of Entries || []) {
    if (!Entry || Entry.Active === false || IsExplicitWalkable(Entry)) continue;
    const Bounds = EntryBounds(Entry);
    if (!FiniteBounds(Bounds)) continue;
    if (Bounds.max.x < MinX || Bounds.min.x > MaxX) continue;
    if (Bounds.max.z < MinZ || Bounds.min.z > MaxZ) continue;
    NearbyEntries.push(Entry);
  }
  return NearbyEntries;
}

function EntryNormal(Entry, Position, Radius, Motion, Target) {
  // Engine compound colliders know their own orientation; use that first.
  if (typeof Entry?.GetContactNormal === "function") {
    try {
      Target.set(0, 0, 0);
      if (Entry.GetContactNormal(Position, Radius, Motion, Target) && Target.lengthSq() > 0.000001) {
        Target.y = 0;
        Target.normalize();
        if (Motion?.lengthSq?.() > 0.000001 && Motion.dot(Target) > 0) Target.negate();
        return true;
      }
    } catch {}
  }

  const Bounds = EntryBounds(Entry);
  if (!FiniteBounds(Bounds)) return false;
  const SafeRadius = Math.max(0.01, Number(Radius) || DefaultRadius);
  const MinX = Bounds.min.x - SafeRadius;
  const MaxX = Bounds.max.x + SafeRadius;
  const MinZ = Bounds.min.z - SafeRadius;
  const MaxZ = Bounds.max.z + SafeRadius;

  if (Position.x >= MinX && Position.x <= MaxX && Position.z >= MinZ && Position.z <= MaxZ) {
    const Left = Position.x - MinX;
    const Right = MaxX - Position.x;
    const Back = Position.z - MinZ;
    const Front = MaxZ - Position.z;
    const Minimum = Math.min(Left, Right, Back, Front);
    if (Minimum === Left) Target.set(-1, 0, 0);
    else if (Minimum === Right) Target.set(1, 0, 0);
    else if (Minimum === Back) Target.set(0, 0, -1);
    else Target.set(0, 0, 1);
  } else {
    Scratch.Closest.set(
      THREE.MathUtils.clamp(Position.x, Bounds.min.x, Bounds.max.x),
      Position.y,
      THREE.MathUtils.clamp(Position.z, Bounds.min.z, Bounds.max.z)
    );
    Target.copy(Position).sub(Scratch.Closest);
    Target.y = 0;
    if (Target.lengthSq() <= 0.000001) return false;
    Target.normalize();
  }

  if (Motion?.lengthSq?.() > 0.000001 && Motion.dot(Target) > 0) Target.negate();
  return true;
}

function AddContactNormal(Normal, Entry) {
  if (!Normal?.isVector3 || Normal.lengthSq() <= 0.25) return;
  Normal.normalize();
  for (const Existing of ContactNormals) {
    if (Existing.dot(Normal) >= ContactMergeDot) return;
  }
  ContactNormals.push(Normal.clone());
  ContactEntries.push(Entry || null);
}

function BuildContactManifold(Position, Radius, Motion, Entries) {
  ContactNormals.length = 0;
  ContactEntries.length = 0;

  for (const Entry of Entries) {
    let Touching = false;
    try {
      Touching = Collision.EntryTouchesCircle?.(Entry, Position, Radius + Skin * 0.35) === true;
    } catch {}
    if (!Touching) continue;
    if (EntryNormal(Entry, Position, Radius, Motion, Scratch.Normal)) AddContactNormal(Scratch.Normal, Entry);
  }

  if (!ContactNormals.length && Motion.lengthSq() > 0.000001) {
    Scratch.Normal.copy(Motion).normalize().negate();
    AddContactNormal(Scratch.Normal, null);
  }
  return ContactNormals;
}

function ProjectAgainstContacts(Vector, Normals) {
  for (let Pass = 0; Pass < 2; Pass += 1) {
    let Changed = false;
    for (const Normal of Normals) {
      const Into = Vector.dot(Normal);
      if (Into >= 0) continue;
      Vector.addScaledVector(Normal, -Into);
      Changed = true;
    }
    if (!Changed) break;
  }
  return Vector;
}

function ResolveCharacterMove(Start, Desired, Radius, Entries) {
  Scratch.Position.copy(Start);
  Scratch.Remaining.copy(Desired);
  Scratch.Remaining.y = 0;

  const Nearby = CollectNearbyEntries(Start, Desired, Radius, Entries);
  if (!Nearby.length || Scratch.Remaining.lengthSq() <= 0.00000001) {
    Scratch.Position.add(Scratch.Remaining);
    return {
      Position: Scratch.Position.clone(),
      Resolved: Scratch.Remaining.clone(),
      Hit: false,
      Sliding: false,
      Entry: null,
      Normal: new THREE.Vector3(),
      ContactCount: 0
    };
  }

  let Hit = false;
  let Sliding = false;
  let LastEntry = null;
  const LastNormal = new THREE.Vector3();
  let ContactCount = 0;

  for (let Iteration = 0; Iteration < MaxSlides; Iteration += 1) {
    const RemainingLength = Scratch.Remaining.length();
    if (RemainingLength <= 0.00001) break;

    const Fraction = Collision.SweepCircleFraction(
      Scratch.Position,
      Scratch.Remaining,
      Radius,
      Nearby,
      {
        MaxSweepSteps,
        BinarySteps,
        Filter: Entry => Entry?.Active !== false
      }
    );

    if (Fraction >= 0.9995) {
      Scratch.Position.add(Scratch.Remaining);
      Scratch.Remaining.set(0, 0, 0);
      break;
    }

    Hit = true;
    const SkinFraction = Skin / Math.max(RemainingLength, 0.000001);
    const SafeFraction = THREE.MathUtils.clamp(Fraction - SkinFraction, 0, 1);
    Scratch.Position.addScaledVector(Scratch.Remaining, SafeFraction);

    Scratch.Probe.copy(Scratch.Position).addScaledVector(
      Scratch.Remaining,
      Math.min(0.025 / Math.max(RemainingLength, 0.000001), 1 - SafeFraction)
    );

    const Normals = BuildContactManifold(Scratch.Probe, Radius, Scratch.Remaining, Nearby);
    ContactCount = Math.max(ContactCount, Normals.length);
    if (Normals.length) {
      LastNormal.copy(Normals[0]);
      LastEntry = ContactEntries[0] || LastEntry;
    }

    Scratch.Leftover.copy(Scratch.Remaining).multiplyScalar(1 - SafeFraction);
    const BeforeProjection = Scratch.Leftover.lengthSq();
    ProjectAgainstContacts(Scratch.Leftover, Normals);

    if (Fraction <= 0.001 && Normals.length) {
      Scratch.NormalSum.set(0, 0, 0);
      for (const Normal of Normals) Scratch.NormalSum.add(Normal);
      if (Scratch.NormalSum.lengthSq() > 0.000001) {
        Scratch.NormalSum.normalize();
        Scratch.Position.addScaledVector(Scratch.NormalSum, Skin * 0.55);
      }
    }

    Sliding ||= BeforeProjection > Scratch.Leftover.lengthSq() + 0.0000001 && Scratch.Leftover.lengthSq() > 0.0000001;
    Scratch.Remaining.copy(Scratch.Leftover);
  }

  const Resolved = Scratch.Position.clone().sub(Start);
  Resolved.y = 0;
  return {
    Position: Scratch.Position.clone(),
    Resolved,
    Hit,
    Sliding,
    SlideVector: Hit ? Resolved.clone() : new THREE.Vector3(),
    Entry: LastEntry,
    Normal: LastNormal,
    ContactCount
  };
}

function ContactState() {
  const Contact = window.__STORE_MOVEMENT_CONTACT__ ||= {};
  for (const Key of ["Normal", "Position", "DesiredDirection", "SlideDirection"]) {
    if (!Contact[Key]?.isVector3) Contact[Key] = new THREE.Vector3();
  }
  return Contact;
}

function RecordContact(Result, Desired) {
  if (!Result?.Hit) return;
  const Contact = ContactState();
  Contact.Normal.copy(Result.Normal || Scratch.DesiredDirection.clone().multiplyScalar(-1));
  if (Contact.Normal.lengthSq() > 0.000001) Contact.Normal.normalize();
  Contact.Position.copy(Result.Position);
  Contact.DesiredDirection.copy(Desired);
  if (Contact.DesiredDirection.lengthSq() > 0.000001) Contact.DesiredDirection.normalize();
  Contact.SlideDirection.copy(Result.SlideVector || Result.Resolved || new THREE.Vector3());
  if (Contact.SlideDirection.lengthSq() > 0.000001) Contact.SlideDirection.normalize();
  Contact.IntentInward = Math.max(0, -Contact.DesiredDirection.dot(Contact.Normal));
  Contact.SlideAmount = Result.Sliding ? 1 : 0;
  Contact.Strength = THREE.MathUtils.clamp(0.25 + Contact.IntentInward * 0.60, 0, 1);
  Contact.Sliding = Boolean(Result.Sliding);
  Contact.ContactCount = Number(Result.ContactCount) || 1;
  Contact.Type = Result.Entry?.Type || "Collision";
  Contact.LastHit = performance.now();
}

function SettleHeight(Camera, Delta) {
  if (!VerticalStateInitialized) {
    AuthoritativeFloorY = THREE.MathUtils.clamp(
      Number(Camera.position.y) - EyeHeight,
      0,
      MaxStepHeight
    );
    VerticalStateInitialized = true;
  }

  let TargetFloor = SurfaceHeight(Camera.position);
  const FootSupport = window.__STORE_FOOT_SUPPORT__ || null;
  const SupportAge = performance.now() - Number(FootSupport?.UpdatedAt ?? -Infinity);

  if (
    FootSupport?.Active === true &&
    SupportAge >= 0 && SupportAge < 140 &&
    Number.isFinite(FootSupport.Height)
  ) {
    const LeftHeight = Number(FootSupport.LeftHeight);
    const RightHeight = Number(FootSupport.RightHeight);
    const SplitStance = Number.isFinite(LeftHeight) &&
      Number.isFinite(RightHeight) &&
      Math.abs(LeftHeight - RightHeight) > 0.022;
    if (!SplitStance) TargetFloor = THREE.MathUtils.clamp(Number(FootSupport.Height), 0, MaxStepHeight);
  }

  const Speed = TargetFloor > AuthoritativeFloorY ? StepUpSpeed : StepDownSpeed;
  const MaxDelta = Math.max(0.0001, Math.min(Number(Delta) || 0.016, 0.05) * Speed);
  AuthoritativeFloorY = MoveToward(AuthoritativeFloorY, TargetFloor, MaxDelta);
  Camera.position.y = EyeHeight + AuthoritativeFloorY;
  return AuthoritativeFloorY;
}

function MoveCharacter(Camera, ForwardAmount, RightAmount, Distance, Delta, Entries, Radius = DefaultRadius) {
  if (!Camera?.position || !Number.isFinite(Distance) || Distance < 0) return null;
  const CollisionEntries = EffectiveCollisionEntries(Entries);

  if (VerticalStateInitialized) Camera.position.y = EyeHeight + AuthoritativeFloorY;
  CameraBasis(Camera);
  Scratch.Desired.set(0, 0, 0)
    .addScaledVector(Scratch.Forward, Number(ForwardAmount) || 0)
    .addScaledVector(Scratch.Right, Number(RightAmount) || 0);

  if (Scratch.Desired.lengthSq() <= 0.000001 || Distance <= 0.000001) {
    const FloorHeight = SettleHeight(Camera, Delta);
    return {
      Position: Camera.position.clone(),
      Resolved: new THREE.Vector3(),
      Hit: false,
      Sliding: false,
      FloorHeight
    };
  }

  Scratch.Desired.normalize().multiplyScalar(Distance);
  Scratch.DesiredDirection.copy(Scratch.Desired).normalize();
  Scratch.Start.copy(Camera.position);

  // Keep the actual body radius supplied by the player model. R98 incorrectly
  // crushed 0.48m to 0.32m, which is why the visible torso could enter walls.
  const SafeRadius = THREE.MathUtils.clamp(Number(Radius) || DefaultRadius, 0.34, 0.52);
  const Result = ResolveCharacterMove(Scratch.Start, Scratch.Desired, SafeRadius, CollisionEntries);

  Camera.position.x = Result.Position.x;
  Camera.position.z = Result.Position.z;
  Result.FloorHeight = SettleHeight(Camera, Delta);
  RecordContact(Result, Scratch.Desired);
  return Result;
}

function GetSettings() {
  return {
    EyeHeight,
    DefaultRadius,
    Skin,
    MaxStepHeight,
    StepClearance,
    StepUpSpeed,
    StepDownSpeed,
    MaxSlides,
    MaxSweepSteps,
    BinarySteps
  };
}

const ProceduralPhysics = {
  MoveCharacter,
  SettleHeight,
  SurfaceHeight,
  RegisterWalkableSurface,
  UnregisterWalkableSurface,
  UnregisterChunk,
  RefreshWalkableSurface,
  RefreshWalkableSurfaces,
  GetRegisteredSurfaceCount: () => WalkableSurfaces.size,
  ResetVerticalState() {
    VerticalStateInitialized = false;
    AuthoritativeFloorY = 0;
  },
  GetPhysicalFloorY: () => AuthoritativeFloorY,
  GetSettings
};

window.__STORE_PROCEDURAL_PHYSICS__ = ProceduralPhysics;
window.__STORE_PROCEDURAL_PHYSICS_BUILD__ = "V0.35.69-R99-ENGINE-MOVE-SLIDE";

export default ProceduralPhysics;
export {
  MoveCharacter,
  SettleHeight,
  SurfaceHeight,
  RegisterWalkableSurface,
  UnregisterWalkableSurface,
  UnregisterChunk,
  RefreshWalkableSurface,
  RefreshWalkableSurfaces,
  GetSettings
};
