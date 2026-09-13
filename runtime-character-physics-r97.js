import * as THREE from "three";

const Build = "V0.35.67-R97-CHARACTER-PHYSICS";
const PlayerEyeHeight = 1.68;
const LowerBodyHeight = 0.84;
const CameraTargetHeight = 1.26;
const CameraRadius = 0.18;
const CameraSkin = 0.16;
const CameraMinimumDistance = 0.68;
const ContactRefreshMs = 55;

const BoneNames = Object.freeze({
  Hips: "Hips",
  Abdomen: "Abdomen",
  Torso: "Torso",
  Chest: "Chest",
  Neck: "Neck",
  Head: "Head",
  ShoulderL: "Shoulder.L",
  ShoulderR: "Shoulder.R",
  UpperArmL: "UpperArm.L",
  UpperArmR: "UpperArm.R",
  LowerArmL: "LowerArm.L",
  LowerArmR: "LowerArm.R",
  WristL: "Wrist.L",
  WristR: "Wrist.R",
  UpperLegL: "UpperLeg.L",
  UpperLegR: "UpperLeg.R",
  LowerLegL: "LowerLeg.L",
  LowerLegR: "LowerLeg.R",
  FootL: "Foot.L",
  FootR: "Foot.R"
});

const State = {
  Installed: false,
  Renderer: null,
  OriginalRender: null,
  Pivot: null,
  Bones: new Map(),
  SavedBones: new Map(),
  LastRootPosition: new THREE.Vector3(),
  HasRootPosition: false,
  SmoothedVelocity: new THREE.Vector3(),
  PreviousForwardSpeed: 0,
  PreviousYaw: 0,
  HasYaw: false,
  LastFrameAt: performance.now(),
  Phase: 0,
  Springs: new Map(),
  LastContactAt: -Infinity,
  ContactLeft: { Weight: 0, Side: 0, Front: 0 },
  ContactRight: { Weight: 0, Side: 0, Front: 0 },
  ContactChest: { Weight: 0, Side: 0, Front: 0 },
  CameraDistance: 0,
  CameraReady: false,
  TempEuler: new THREE.Euler(),
  TempQuaternion: new THREE.Quaternion(),
  TempCameraPosition: new THREE.Vector3(),
  TempCameraQuaternion: new THREE.Quaternion(),
  TempTarget: new THREE.Vector3(),
  TempDirection: new THREE.Vector3(),
  TempDesired: new THREE.Vector3(),
  TempForward: new THREE.Vector3(),
  TempRight: new THREE.Vector3(),
  TempBonePosition: new THREE.Vector3(),
  TempClosest: new THREE.Vector3(),
  TempNormal: new THREE.Vector3(),
  TempCenter: new THREE.Vector3()
};

function HudActive() {
  const Hud = document.getElementById("Hud");
  return Boolean(Hud && !Hud.classList.contains("Hidden"));
}

function OldRuntimeCollision(Entry) {
  const Type = String(Entry?.Type || "");
  return Boolean(
    Entry?.CoreFixR95 === true ||
    Entry?.CoreFixR96 === true ||
    /VisiblePhysical(WorldR95|ObjectR96)/i.test(Type)
  );
}

function RefreshRig() {
  const Game = window.__STORE_GAME__;
  const Scene = Game?.Scene;
  if (!Scene) return false;

  let Pivot = State.Pivot;
  if (!Pivot?.parent) Pivot = Scene.getObjectByName("PlayerCharacterPivot") || null;
  if (!Pivot) {
    State.Pivot = null;
    State.Bones.clear();
    State.SavedBones.clear();
    return false;
  }

  if (Pivot === State.Pivot && State.Bones.size) return true;

  State.Pivot = Pivot;
  State.Bones.clear();
  State.SavedBones.clear();

  for (const [Key, Name] of Object.entries(BoneNames)) {
    const Bone = Pivot.getObjectByName(Name);
    if (!Bone?.isBone) continue;
    State.Bones.set(Key, Bone);
    State.SavedBones.set(Key, new THREE.Quaternion());
  }

  State.HasRootPosition = false;
  State.HasYaw = false;
  return State.Bones.size > 0;
}

function SaveBonePose() {
  for (const [Key, Bone] of State.Bones) {
    let Saved = State.SavedBones.get(Key);
    if (!Saved) {
      Saved = new THREE.Quaternion();
      State.SavedBones.set(Key, Saved);
    }
    Saved.copy(Bone.quaternion);
  }
}

function RestoreBonePose() {
  for (const [Key, Bone] of State.Bones) {
    const Saved = State.SavedBones.get(Key);
    if (Saved) Bone.quaternion.copy(Saved);
  }
  State.Pivot?.updateMatrixWorld?.(true);
}

function AddBoneRotation(Key, X = 0, Y = 0, Z = 0) {
  const Bone = State.Bones.get(Key);
  if (!Bone) return;
  State.TempEuler.set(X, Y, Z, "XYZ");
  State.TempQuaternion.setFromEuler(State.TempEuler);
  Bone.quaternion.multiply(State.TempQuaternion).normalize();
}

function SpringValue(Key, Target, Delta, Frequency = 8.5, Damping = 0.92) {
  let Spring = State.Springs.get(Key);
  if (!Spring) {
    Spring = { Value: Number(Target) || 0, Velocity: 0 };
    State.Springs.set(Key, Spring);
  }

  const Dt = THREE.MathUtils.clamp(Number(Delta) || 0, 0.001, 0.05);
  const Omega = Math.max(0.1, Number(Frequency) || 8.5);
  Spring.Velocity += (Target - Spring.Value) * Omega * Omega * Dt;
  Spring.Velocity *= Math.exp(-Math.max(0.05, Damping) * Omega * Dt);
  Spring.Value += Spring.Velocity * Dt;
  return Spring.Value;
}

function UpdateMotion(Delta) {
  const Pivot = State.Pivot;
  if (!Pivot) return null;

  Pivot.updateMatrixWorld(true);
  const Position = Pivot.getWorldPosition(State.TempBonePosition);
  if (!State.HasRootPosition) {
    State.LastRootPosition.copy(Position);
    State.HasRootPosition = true;
  }

  const RawVelocity = State.TempNormal.copy(Position).sub(State.LastRootPosition).divideScalar(Math.max(Delta, 0.001));
  RawVelocity.y = 0;
  State.LastRootPosition.copy(Position);
  State.SmoothedVelocity.lerp(RawVelocity, 1 - Math.exp(-Delta * 10));

  const Yaw = Pivot.rotation.y;
  State.TempForward.set(Math.sin(Yaw), 0, Math.cos(Yaw));
  State.TempRight.set(Math.cos(Yaw), 0, -Math.sin(Yaw));

  const ForwardSpeed = State.SmoothedVelocity.dot(State.TempForward);
  const SideSpeed = State.SmoothedVelocity.dot(State.TempRight);
  const Acceleration = (ForwardSpeed - State.PreviousForwardSpeed) / Math.max(Delta, 0.001);
  State.PreviousForwardSpeed = ForwardSpeed;

  let YawRate = 0;
  if (State.HasYaw) {
    const Difference = Math.atan2(Math.sin(Yaw - State.PreviousYaw), Math.cos(Yaw - State.PreviousYaw));
    YawRate = Difference / Math.max(Delta, 0.001);
  } else {
    State.HasYaw = true;
  }
  State.PreviousYaw = Yaw;

  const Speed = State.SmoothedVelocity.length();
  State.Phase += Delta * THREE.MathUtils.lerp(1.6, 8.6, THREE.MathUtils.clamp(Speed / 5.35, 0, 1));

  return { Speed, ForwardSpeed, SideSpeed, Acceleration, YawRate };
}

function EntryBounds(Entry) {
  return Entry?.OriginalStructureBox || Entry?.OriginalBox || Entry?.Box || null;
}

function ContactAt(Position, Radius = 0.13) {
  const Entries = window.__STORE_COLLISION_BOXES__ || [];
  let BestWeight = 0;
  let BestSide = 0;
  let BestFront = 0;
  const Pivot = State.Pivot;
  const Yaw = Pivot?.rotation?.y || 0;
  const ForwardX = Math.sin(Yaw);
  const ForwardZ = Math.cos(Yaw);
  const RightX = Math.cos(Yaw);
  const RightZ = -Math.sin(Yaw);

  for (const Entry of Entries) {
    if (!Entry || Entry.Active === false || OldRuntimeCollision(Entry)) continue;
    if (/Rug|Carpet|FloorSurface|WalkableSurface/i.test(String(Entry.Type || ""))) continue;
    const Bounds = EntryBounds(Entry);
    if (!Bounds?.min || !Bounds?.max) continue;

    if (
      Position.x < Bounds.min.x - Radius - 0.10 || Position.x > Bounds.max.x + Radius + 0.10 ||
      Position.y < Bounds.min.y - Radius - 0.10 || Position.y > Bounds.max.y + Radius + 0.10 ||
      Position.z < Bounds.min.z - Radius - 0.10 || Position.z > Bounds.max.z + Radius + 0.10
    ) continue;

    State.TempClosest.set(
      THREE.MathUtils.clamp(Position.x, Bounds.min.x, Bounds.max.x),
      THREE.MathUtils.clamp(Position.y, Bounds.min.y, Bounds.max.y),
      THREE.MathUtils.clamp(Position.z, Bounds.min.z, Bounds.max.z)
    );
    State.TempNormal.copy(Position).sub(State.TempClosest);
    let Distance = State.TempNormal.length();

    if (Distance <= 0.00001) {
      Bounds.getCenter(State.TempCenter);
      State.TempNormal.copy(Position).sub(State.TempCenter);
      State.TempNormal.y = 0;
      if (State.TempNormal.lengthSq() <= 0.000001) State.TempNormal.set(0, 0, 1);
      Distance = 0;
    }

    const Weight = THREE.MathUtils.clamp(1 - Distance / (Radius + 0.075), 0, 1);
    if (Weight <= BestWeight) continue;
    State.TempNormal.normalize();
    BestWeight = Weight;
    BestSide = State.TempNormal.x * RightX + State.TempNormal.z * RightZ;
    BestFront = State.TempNormal.x * ForwardX + State.TempNormal.z * ForwardZ;
  }

  return { Weight: BestWeight, Side: BestSide, Front: BestFront };
}

function UpdateUpperBodyContacts(Now) {
  if (Now - State.LastContactAt < ContactRefreshMs || !State.Pivot) return;
  State.LastContactAt = Now;
  State.Pivot.updateMatrixWorld(true);

  const Left = State.Bones.get("WristL");
  const Right = State.Bones.get("WristR");
  const Chest = State.Bones.get("Chest");

  const SmoothContact = (Target, Next) => {
    Target.Weight = THREE.MathUtils.lerp(Target.Weight, Next.Weight, 0.58);
    Target.Side = THREE.MathUtils.lerp(Target.Side, Next.Side, 0.58);
    Target.Front = THREE.MathUtils.lerp(Target.Front, Next.Front, 0.58);
  };

  if (Left) {
    Left.getWorldPosition(State.TempBonePosition);
    SmoothContact(State.ContactLeft, ContactAt(State.TempBonePosition, 0.105));
  } else SmoothContact(State.ContactLeft, { Weight: 0, Side: 0, Front: 0 });

  if (Right) {
    Right.getWorldPosition(State.TempBonePosition);
    SmoothContact(State.ContactRight, ContactAt(State.TempBonePosition, 0.105));
  } else SmoothContact(State.ContactRight, { Weight: 0, Side: 0, Front: 0 });

  if (Chest) {
    Chest.getWorldPosition(State.TempBonePosition);
    SmoothContact(State.ContactChest, ContactAt(State.TempBonePosition, 0.18));
  } else SmoothContact(State.ContactChest, { Weight: 0, Side: 0, Front: 0 });
}

function ApplySecondaryMotion(Motion, Delta, Now) {
  if (!Motion || !State.Pivot) return;

  const Move = THREE.MathUtils.clamp(Motion.Speed / 5.35, 0, 1);
  const ForwardTarget = THREE.MathUtils.clamp(
    Motion.ForwardSpeed * 0.007 + Motion.Acceleration * 0.0016,
    -0.060,
    0.075
  );
  const SideTarget = THREE.MathUtils.clamp(Motion.SideSpeed * 0.010, -0.045, 0.045);
  const TurnTarget = THREE.MathUtils.clamp(Motion.YawRate * 0.020, -0.075, 0.075);

  const ForwardLean = SpringValue("ForwardLean", ForwardTarget, Delta, 8.5, 0.94);
  const SideLean = SpringValue("SideLean", SideTarget, Delta, 8.0, 0.95);
  const TurnLean = SpringValue("TurnLean", TurnTarget, Delta, 9.0, 0.90);
  const Breath = Math.sin(Now * 0.0017) * 0.0065 * (1 - Move * 0.72);
  const Counter = Math.sin(State.Phase) * 0.011 * Move;

  // Flexible torso chain: pelvis initiates motion, spine follows, chest counters.
  AddBoneRotation("Hips", ForwardLean * 0.18, -Counter * 0.25, -SideLean * 0.40 - TurnLean * 0.18);
  AddBoneRotation("Abdomen", ForwardLean * 0.34 + Breath * 0.35, Counter * 0.30, SideLean * 0.25 + TurnLean * 0.24);
  AddBoneRotation("Torso", ForwardLean * 0.30 + Breath * 0.42, -Counter * 0.42, SideLean * 0.28 + TurnLean * 0.30);
  AddBoneRotation("Chest", ForwardLean * 0.18 + Breath * 0.55, Counter * 0.55, -SideLean * 0.22 - TurnLean * 0.28);
  AddBoneRotation("Neck", -ForwardLean * 0.10 - Breath * 0.15, -TurnLean * 0.18, 0);
  AddBoneRotation("Head", -ForwardLean * 0.05, -TurnLean * 0.10, SideLean * 0.08);

  // Loose shoulder/arm inertia. The animation clip remains primary; this only
  // removes the rigid mannequin feel and never translates the character root.
  const ArmLag = SpringValue("ArmLag", THREE.MathUtils.clamp(Motion.Acceleration * 0.0022, -0.055, 0.055), Delta, 7.0, 0.82);
  AddBoneRotation("ShoulderL", -ArmLag * 0.30, TurnLean * -0.16, 0.010 + SideLean * 0.12);
  AddBoneRotation("ShoulderR", -ArmLag * 0.30, TurnLean * -0.16, -0.010 + SideLean * 0.12);
  AddBoneRotation("UpperArmL", -ArmLag * 0.70 - Counter * 0.35, 0, 0.010);
  AddBoneRotation("UpperArmR", -ArmLag * 0.70 + Counter * 0.35, 0, -0.010);
  AddBoneRotation("LowerArmL", Math.abs(ArmLag) * -0.28, 0, 0);
  AddBoneRotation("LowerArmR", Math.abs(ArmLag) * -0.28, 0, 0);

  UpdateUpperBodyContacts(Now);

  const Left = State.ContactLeft;
  const Right = State.ContactRight;
  const Chest = State.ContactChest;

  // Arm collision is pose-only. An arm touching a shelf retracts/bends instead
  // of slowing the player's root or pushing the camera backward.
  AddBoneRotation("ShoulderL", -0.055 * Left.Weight, 0, 0.045 * Left.Weight);
  AddBoneRotation("UpperArmL", 0.110 * Left.Weight, Left.Side * -0.045 * Left.Weight, 0.065 * Left.Weight);
  AddBoneRotation("LowerArmL", -0.285 * Left.Weight, 0, 0.025 * Left.Weight);

  AddBoneRotation("ShoulderR", -0.055 * Right.Weight, 0, -0.045 * Right.Weight);
  AddBoneRotation("UpperArmR", 0.110 * Right.Weight, Right.Side * -0.045 * Right.Weight, -0.065 * Right.Weight);
  AddBoneRotation("LowerArmR", -0.285 * Right.Weight, 0, -0.025 * Right.Weight);

  // Chest/head contact bends the upper chain visually but does not become root
  // collision authority. Legs, feet and the player capsule own locomotion.
  const ChestWeight = Chest.Weight;
  AddBoneRotation("Abdomen", -0.030 * ChestWeight, -Chest.Side * 0.020 * ChestWeight, -Chest.Side * 0.030 * ChestWeight);
  AddBoneRotation("Torso", -0.050 * ChestWeight, -Chest.Side * 0.035 * ChestWeight, -Chest.Side * 0.050 * ChestWeight);
  AddBoneRotation("Chest", 0.034 * ChestWeight, Chest.Side * 0.025 * ChestWeight, Chest.Side * 0.036 * ChestWeight);
  AddBoneRotation("Neck", 0.016 * ChestWeight, Chest.Side * 0.018 * ChestWeight, 0);

  // Small compliant follow in the legs prevents a locked wooden stance without
  // fighting the existing geometry-driven foot IK.
  AddBoneRotation("UpperLegL", 0, SideLean * 0.08, -SideLean * 0.11);
  AddBoneRotation("UpperLegR", 0, SideLean * 0.08, -SideLean * 0.11);
}

function InstallLowerBodyRootAuthority() {
  const SurfaceStep = window.__STORE_SURFACE_STEP_ANIMATION_R87__;
  const Game = window.__STORE_GAME__;
  if (!SurfaceStep || typeof SurfaceStep.ResolveBodyPartCurbForce !== "function" || !Game?.Camera) return false;
  if (SurfaceStep.__LowerBodyContactAuthorityR97) return true;

  const Original = SurfaceStep.ResolveBodyPartCurbForce.bind(SurfaceStep);
  SurfaceStep.ResolveBodyPartCurbForce = function ResolveRootContactFromLowerBody(
    Position,
    Radius = 0.10,
    Target = null,
    Clearance = 0.010
  ) {
    if (!Position?.isVector3) {
      const Separation = Target?.isVector3 ? Target : new THREE.Vector3();
      Separation.set(0, 0, 0);
      return { Hit: false, Depth: 0, Separation, UpperBodyVisualOnlyR97: true };
    }

    const FeetY = Number(Game.Camera.position.y) - PlayerEyeHeight;
    const LowerBodyCeiling = FeetY + LowerBodyHeight;
    if (Position.y - Math.max(0, Number(Radius) || 0) > LowerBodyCeiling) {
      const Separation = Target?.isVector3 ? Target : new THREE.Vector3();
      Separation.set(0, 0, 0);
      return { Hit: false, Depth: 0, Separation, UpperBodyVisualOnlyR97: true };
    }

    return Original(Position, Radius, Target, Clearance);
  };

  Object.defineProperty(SurfaceStep, "__LowerBodyContactAuthorityR97", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  window.__STORE_ROOT_CONTACT_POLICY_R97__ = Object.freeze({
    Build,
    Mode: "CAPSULE_FEET_LEGS",
    UpperBodyContact: "POSE_ONLY",
    LowerBodyHeight
  });
  return true;
}

function ProbeCamera(Start, End) {
  const Supplement = window.__STORE_COLLISION_SUPPLEMENT_R97__;
  if (typeof Supplement?.ProbeCameraSegment === "function") {
    return Supplement.ProbeCameraSegment(Start, End, CameraRadius);
  }
  return { Hit: false, Fraction: 1, Entry: null };
}

function CorrectThirdPersonCamera(Camera, Delta) {
  const Player = window.__STORE_PLAYER__;
  if (!Player?.IsThirdPerson?.() || !State.Pivot) {
    State.CameraReady = false;
    return;
  }

  const DesiredDistance = THREE.MathUtils.clamp(
    Number(Player.GetThirdPersonDistance?.()) || 4.8,
    0.48,
    6.0
  );

  State.TempTarget.copy(State.Pivot.position);
  State.TempTarget.y += CameraTargetHeight;

  State.TempDirection.copy(Camera.position).sub(State.TempTarget);
  if (State.TempDirection.lengthSq() <= 0.025) {
    State.TempDirection.set(0, 0, 1).applyQuaternion(Camera.quaternion);
  }
  State.TempDirection.normalize();
  State.TempDesired.copy(State.TempTarget).addScaledVector(State.TempDirection, DesiredDistance);

  const Probe = ProbeCamera(State.TempTarget, State.TempDesired);
  const AllowedDistance = Probe?.Hit
    ? Math.max(CameraMinimumDistance, DesiredDistance * THREE.MathUtils.clamp(Probe.Fraction, 0, 1) - CameraSkin)
    : DesiredDistance;
  const TargetDistance = Math.min(DesiredDistance, AllowedDistance);

  if (!State.CameraReady || !Number.isFinite(State.CameraDistance)) {
    State.CameraDistance = TargetDistance;
    State.CameraReady = true;
  } else {
    const Response = TargetDistance < State.CameraDistance ? 30 : 11;
    State.CameraDistance = THREE.MathUtils.lerp(
      State.CameraDistance,
      TargetDistance,
      1 - Math.exp(-Delta * Response)
    );
  }

  Camera.position.copy(State.TempTarget).addScaledVector(State.TempDirection, State.CameraDistance);
  Camera.lookAt(State.TempTarget);
  Camera.updateMatrixWorld(true);
}

function InstallRendererWrapper() {
  const Game = window.__STORE_GAME__;
  const Renderer = Game?.Renderer;
  if (!Renderer?.render) return false;
  if (Renderer.__R97CharacterPhysicsInstalled) return true;

  State.Renderer = Renderer;
  State.OriginalRender = Renderer.render.bind(Renderer);

  Renderer.render = function RenderWithCharacterPhysics(Scene, Camera) {
    if (!Scene || !Camera || !HudActive() || !RefreshRig()) {
      return State.OriginalRender(Scene, Camera);
    }

    const Now = performance.now();
    const Delta = THREE.MathUtils.clamp((Now - State.LastFrameAt) / 1000, 0.001, 0.05);
    State.LastFrameAt = Now;

    const ThirdPerson = Boolean(window.__STORE_PLAYER__?.IsThirdPerson?.());
    State.TempCameraPosition.copy(Camera.position);
    State.TempCameraQuaternion.copy(Camera.quaternion);
    SaveBonePose();

    try {
      const Motion = UpdateMotion(Delta);
      if (ThirdPerson) {
        ApplySecondaryMotion(Motion, Delta, Now);
        State.Pivot.updateMatrixWorld(true);
        CorrectThirdPersonCamera(Camera, Delta);
      } else {
        State.CameraReady = false;
      }
      return State.OriginalRender(Scene, Camera);
    } finally {
      RestoreBonePose();
      Camera.position.copy(State.TempCameraPosition);
      Camera.quaternion.copy(State.TempCameraQuaternion);
      Camera.updateMatrixWorld(true);
    }
  };

  Object.defineProperty(Renderer, "__R97CharacterPhysicsInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function Install() {
  const Game = window.__STORE_GAME__;
  const Player = window.__STORE_PLAYER__;
  if (!Game?.Renderer || !Game?.Scene || !Player) return false;

  InstallLowerBodyRootAuthority();
  if (!InstallRendererWrapper()) return false;

  const BuildNode = document.getElementById("BuildVersion");
  if (BuildNode) BuildNode.textContent = "BUILD V0.35.67";

  window.__STORE_CHARACTER_PHYSICS_R97__ = Object.freeze({
    Build,
    RefreshRig,
    InstallLowerBodyRootAuthority
  });
  window.__STORE_CHARACTER_PHYSICS_BUILD__ = Build;
  State.Installed = true;
  return true;
}

if (!Install()) {
  let Attempts = 0;
  const Start = setInterval(() => {
    Attempts += 1;
    if (Install() || Attempts >= 240) clearInterval(Start);
  }, 50);
}

addEventListener("store-gameplay-started", () => {
  RefreshRig();
  InstallLowerBodyRootAuthority();
});

export { Install, RefreshRig, InstallLowerBodyRootAuthority };
