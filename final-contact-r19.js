import * as THREE from "three";

const Game = window.__STORE_GAME__;
const Player = window.__STORE_PLAYER__;
const Collision = window.__STORE_COLLISION_UTILITY__;
const StrictVerifier = window.__STORE_STRICT_MOVEMENT_VERIFIER__ || null;

if (!Game?.Scene || !Player || !Collision) {
  throw new Error("Game, player, and ray collision utility must load before final contact pass.");
}

const FINAL_CONTACT_SKIN = 0.018;
const FINAL_POSE_SKIN = 0.012;

const ForceCapsules = [
  { A: "Neck", B: "Head", Radius: 0.145, EndExtension: 0.07 },
  { A: "Chest", B: "Neck", Radius: 0.176 },
  { A: "Torso", B: "Chest", Radius: 0.214 },
  { A: "Abdomen", B: "Torso", Radius: 0.208 },
  { A: "Hips", B: "Abdomen", Radius: 0.202 },

  { A: "Chest", B: "Shoulder.L", Radius: 0.168 },
  { A: "Shoulder.L", B: "UpperArm.L", Radius: 0.118 },
  { A: "UpperArm.L", B: "LowerArm.L", Radius: 0.112 },
  { A: "LowerArm.L", B: "Wrist.L", Radius: 0.102, EndExtension: 0.15 },

  { A: "Chest", B: "Shoulder.R", Radius: 0.168 },
  { A: "Shoulder.R", B: "UpperArm.R", Radius: 0.118 },
  { A: "UpperArm.R", B: "LowerArm.R", Radius: 0.112 },
  { A: "LowerArm.R", B: "Wrist.R", Radius: 0.102, EndExtension: 0.15 },

  { A: "Hips", B: "UpperLeg.L", Radius: 0.168 },
  { A: "UpperLeg.L", B: "LowerLeg.L", Radius: 0.142 },
  { A: "LowerLeg.L", B: "Foot.L", Radius: 0.132, EndExtension: 0.23 },

  { A: "Hips", B: "UpperLeg.R", Radius: 0.168 },
  { A: "UpperLeg.R", B: "LowerLeg.R", Radius: 0.142 },
  { A: "LowerLeg.R", B: "Foot.R", Radius: 0.132, EndExtension: 0.23 }
];

const CoreForceCapsules = ForceCapsules.filter(Capsule => {
  const Key = `${Capsule.A}>${Capsule.B}`;
  return new Set([
    "Neck>Head",
    "Chest>Neck",
    "Torso>Chest",
    "Abdomen>Torso",
    "Hips>Abdomen"
  ]).has(Key);
});

const PoseSegments = [
  { Joint: "Shoulder.L", Child: "UpperArm.L", Radius: 0.108 },
  { Joint: "UpperArm.L", Child: "LowerArm.L", Radius: 0.112 },
  { Joint: "LowerArm.L", Child: "Wrist.L", Radius: 0.104, EndExtension: 0.15 },
  { Joint: "Shoulder.R", Child: "UpperArm.R", Radius: 0.108 },
  { Joint: "UpperArm.R", Child: "LowerArm.R", Radius: 0.112 },
  { Joint: "LowerArm.R", Child: "Wrist.R", Radius: 0.104, EndExtension: 0.15 },
  { Joint: "UpperLeg.L", Child: "LowerLeg.L", Radius: 0.140 },
  { Joint: "LowerLeg.L", Child: "Foot.L", Radius: 0.132, EndExtension: 0.23 },
  { Joint: "UpperLeg.R", Child: "LowerLeg.R", Radius: 0.140 },
  { Joint: "LowerLeg.R", Child: "Foot.R", Radius: 0.132, EndExtension: 0.23 }
];

const Scratch = {
  Start: new THREE.Vector3(),
  End: new THREE.Vector3(),
  ExtendedEnd: new THREE.Vector3(),
  Sample: new THREE.Vector3(),
  SafeEnd: new THREE.Vector3(),
  CurrentDirection: new THREE.Vector3(),
  TargetDirection: new THREE.Vector3(),
  ParentQuaternion: new THREE.Quaternion(),
  JointQuaternion: new THREE.Quaternion(),
  DeltaQuaternion: new THREE.Quaternion(),
  DesiredQuaternion: new THREE.Quaternion(),
  LocalQuaternion: new THREE.Quaternion(),
  Separation: new THREE.Vector3(),
  BestSeparation: new THREE.Vector3(),
  PivotCenter: new THREE.Vector3(),
  SavedPivotPosition: new THREE.Vector3(),
  SavedQuaternions: new Map(),
  SavedScales: new Map(),
  SavedVisibility: new Map(),
  PivotPositionSaved: false
};

const SegmentState = new Map();

function BodyCollision(Entry) {
  return Boolean(Entry?.ProceduralBodyContact || Collision.IsStructure(Entry));
}

function EntryBounds(Entry) {
  return Entry?.OriginalStructureBox || Entry?.OriginalBox || Entry?.Box || Entry || null;
}

function FiniteBounds(Bounds) {
  return Boolean(
    Bounds?.min && Bounds?.max &&
    [Bounds.min.x, Bounds.min.y, Bounds.min.z, Bounds.max.x, Bounds.max.y, Bounds.max.z].every(Number.isFinite)
  );
}

function PointSeparation(Point, Radius, Bounds, Target) {
  if (!FiniteBounds(Bounds)) return 0;

  const MinX = Bounds.min.x - Radius;
  const MaxX = Bounds.max.x + Radius;
  const MinY = Bounds.min.y - Radius;
  const MaxY = Bounds.max.y + Radius;
  const MinZ = Bounds.min.z - Radius;
  const MaxZ = Bounds.max.z + Radius;

  if (
    Point.x <= MinX || Point.x >= MaxX ||
    Point.y <= MinY || Point.y >= MaxY ||
    Point.z <= MinZ || Point.z >= MaxZ
  ) return 0;

  const Left = Point.x - MinX;
  const Right = MaxX - Point.x;
  const Back = Point.z - MinZ;
  const Front = MaxZ - Point.z;
  const Minimum = Math.min(Left, Right, Back, Front) + 0.012;

  if (Minimum === Left + 0.012) Target.set(-Minimum, 0, 0);
  else if (Minimum === Right + 0.012) Target.set(Minimum, 0, 0);
  else if (Minimum === Back + 0.012) Target.set(0, 0, -Minimum);
  else Target.set(0, 0, Minimum);

  return Minimum;
}

function CapsuleSampleSeparation(Start, End, Radius, Entries, Target) {
  let BestDepth = 0;
  Target.set(0, 0, 0);

  const EffectiveRadius = Radius + FINAL_CONTACT_SKIN;
  const Length = Start.distanceTo(End);
  const Samples = THREE.MathUtils.clamp(Math.ceil(Length / Math.max(0.052, EffectiveRadius * 0.56)), 5, 12);

  for (let Index = 0; Index <= Samples; Index += 1) {
    const T = Index / Samples;
    Scratch.Sample.lerpVectors(Start, End, T);

    for (const Entry of Entries) {
      if (!BodyCollision(Entry)) continue;
      const Depth = PointSeparation(Scratch.Sample, EffectiveRadius, EntryBounds(Entry), Scratch.Separation);
      if (Depth <= BestDepth) continue;
      BestDepth = Depth;
      Target.copy(Scratch.Separation);
    }
  }

  return BestDepth;
}

function SavePivotPosition(Pivot) {
  if (Scratch.PivotPositionSaved) return;
  Scratch.SavedPivotPosition.copy(Pivot.position);
  Scratch.PivotPositionSaved = true;
}

function ForceWholeRigOut(Pivot, Roots) {
  if (!Collision?.ProbeVisibleGeometrySeparation || !Roots?.length) return;

  SavePivotPosition(Pivot);
  let TotalPush = 0;

  for (let Pass = 0; Pass < 2 && TotalPush < 0.13; Pass += 1) {
    let BestDepth = 0;
    Scratch.BestSeparation.set(0, 0, 0);
    Pivot.updateMatrixWorld(true);

    for (const Capsule of CoreForceCapsules) {
      const BoneA = Pivot.getObjectByName(Capsule.A);
      const BoneB = Pivot.getObjectByName(Capsule.B);
      if (!BoneA?.isBone || !BoneB?.isBone) continue;

      BoneA.getWorldPosition(Scratch.Start);
      BoneB.getWorldPosition(Scratch.End);

      for (const T of [0.18, 0.5, 0.82]) {
        Scratch.Sample.lerpVectors(Scratch.Start, Scratch.End, T);

        const Probe = Collision.ProbeVisibleGeometrySeparation(
          Scratch.Sample,
          Capsule.Radius,
          Scratch.Separation,
          {
            Scene: Game.Scene,
            Roots,
            Skin: FINAL_CONTACT_SKIN
          }
        );

        const Depth = Number(Probe?.Depth) || 0;
        if (!Probe?.Hit || Depth <= BestDepth) continue;

        BestDepth = Depth;
        Scratch.BestSeparation.copy(Probe.Separation);
      }
    }

    if (BestDepth <= 0.0005 || Scratch.BestSeparation.lengthSq() <= 0.000001) break;

    const Remaining = Math.max(0, 0.13 - TotalPush);
    const PushLength = Math.min(
      Scratch.BestSeparation.length(),
      0.045,
      Remaining
    );
    if (PushLength <= 0.0005) break;

    Scratch.BestSeparation.setLength(PushLength);
    Pivot.position.add(Scratch.BestSeparation);
    TotalPush += PushLength;
  }

  Pivot.updateMatrixWorld(true);
}

function StateFor(Segment) {
  const Key = `${Segment.Joint}>${Segment.Child}`;
  let State = SegmentState.get(Key);
  if (State) return State;

  State = {
    PreviousDirection: new THREE.Vector3(),
    HasPrevious: false
  };
  SegmentState.set(Key, State);
  return State;
}

function SaveBone(Bone) {
  if (!Bone?.isBone || Scratch.SavedQuaternions.has(Bone)) return;
  Scratch.SavedQuaternions.set(Bone, Bone.quaternion.clone());
}

function RotateJointToTarget(Pivot, Joint, Child, Target) {
  if (!Joint?.isBone || !Child?.isBone || !Joint.parent) return false;

  Pivot.updateMatrixWorld(true);
  Joint.getWorldPosition(Scratch.Start);
  Child.getWorldPosition(Scratch.End);

  Scratch.CurrentDirection.copy(Scratch.End).sub(Scratch.Start);
  Scratch.TargetDirection.copy(Target).sub(Scratch.Start);

  if (Scratch.CurrentDirection.lengthSq() <= 0.000001 || Scratch.TargetDirection.lengthSq() <= 0.000001) return false;

  Scratch.CurrentDirection.normalize();
  Scratch.TargetDirection.normalize();
  if (Scratch.CurrentDirection.dot(Scratch.TargetDirection) > 0.9999995) return false;

  Scratch.DeltaQuaternion.setFromUnitVectors(Scratch.CurrentDirection, Scratch.TargetDirection);
  Joint.getWorldQuaternion(Scratch.JointQuaternion);
  Scratch.DesiredQuaternion.copy(Scratch.DeltaQuaternion).multiply(Scratch.JointQuaternion);

  Joint.parent.getWorldQuaternion(Scratch.ParentQuaternion).invert();
  Scratch.LocalQuaternion.copy(Scratch.ParentQuaternion).multiply(Scratch.DesiredQuaternion).normalize();

  Joint.quaternion.copy(Scratch.LocalQuaternion);
  Pivot.updateMatrixWorld(true);
  return true;
}

function RememberDirection(State, Start, End) {
  State.PreviousDirection.copy(End).sub(Start);
  if (State.PreviousDirection.lengthSq() <= 0.000001) return;
  State.PreviousDirection.normalize();
  State.HasPrevious = true;
}

function ConstrainPoseSegment(Pivot, Segment, Records) {
  const Joint = Pivot.getObjectByName(Segment.Joint);
  const Child = Pivot.getObjectByName(Segment.Child);
  if (!Joint?.isBone || !Child?.isBone) return false;

  SaveBone(Joint);

  Joint.getWorldPosition(Scratch.Start);
  Child.getWorldPosition(Scratch.End);
  Scratch.ExtendedEnd.copy(Scratch.End);

  if (Segment.EndExtension > 0) {
    Scratch.CurrentDirection.copy(Scratch.End).sub(Scratch.Start);
    if (Scratch.CurrentDirection.lengthSq() > 0.000001) {
      Scratch.ExtendedEnd.addScaledVector(
        Scratch.CurrentDirection.normalize(),
        Segment.EndExtension
      );
    }
  }

  const State = StateFor(Segment);
  let Result = null;

  if (typeof Collision.ResolveRaycastCapsuleSegment === "function") {
    Result = Collision.ResolveRaycastCapsuleSegment(
      Scratch.Start,
      Scratch.ExtendedEnd,
      Segment.Radius,
      Scratch.SafeEnd,
      {
        Scene: Game.Scene,
        Roots: Records,
        Skin: FINAL_POSE_SKIN
      }
    );
  } else if (StrictVerifier?.ResolveSegmentAgainstTriangles && Records?.length) {
    Result = StrictVerifier.ResolveSegmentAgainstTriangles(
      Scratch.Start,
      Scratch.ExtendedEnd,
      Segment.Radius,
      Records,
      Scratch.SafeEnd,
      {
        Skin: FINAL_POSE_SKIN,
        PreviousDirection: State.HasPrevious ? State.PreviousDirection : null
      }
    );
  }

  if (!Result?.Hit) {
    RememberDirection(State, Scratch.Start, Scratch.End);
    return false;
  }

  const Target = Result.Point?.isVector3 ? Result.Point : Scratch.SafeEnd;
  const Changed = RotateJointToTarget(Pivot, Joint, Child, Target);
  Pivot.updateMatrixWorld(true);

  Joint.getWorldPosition(Scratch.Start);
  Child.getWorldPosition(Scratch.End);
  RememberDirection(State, Scratch.Start, Scratch.End);
  return Changed;
}

function ResolveAllVisibleContacts(Pivot) {
  Pivot.updateMatrixWorld(true);
  Pivot.getWorldPosition(Scratch.PivotCenter);

  const Roots = typeof Collision.RaycastCandidateRoots === "function"
    ? Collision.RaycastCandidateRoots(
        Game.Scene,
        Scratch.PivotCenter,
        1.55
      )
    : [];

  if (!Roots.length) return;

  for (let Pass = 0; Pass < 2; Pass += 1) {
    let Changed = false;
    for (const Segment of PoseSegments) {
      if (ConstrainPoseSegment(Pivot, Segment, Roots)) Changed = true;
    }
    if (!Changed) break;
  }

  ForceWholeRigOut(Pivot, Roots);

  for (const Segment of PoseSegments) {
    ConstrainPoseSegment(Pivot, Segment, Roots);
  }
}

function HideFirstPersonHead(Pivot) {
  if (Player.IsThirdPerson?.()) return;

  const Head = Pivot.getObjectByName("Head");
  if (Head?.isBone) {
    Scratch.SavedScales.set(Head, Head.scale.clone());
    Head.scale.setScalar(0.00001);
  }

  Pivot.traverse(Object => {
    if (!Object?.isMesh || !/head|helmet|hardhat|hair/i.test(String(Object.name || ""))) return;
    Scratch.SavedVisibility.set(Object, Object.visible);
    Object.visible = false;
  });

  Pivot.updateMatrixWorld(true);
}

function RestoreFinalPass(Pivot) {
  for (const [Bone, Quaternion] of Scratch.SavedQuaternions) Bone.quaternion.copy(Quaternion);
  for (const [Bone, Scale] of Scratch.SavedScales) Bone.scale.copy(Scale);
  for (const [Object, Visible] of Scratch.SavedVisibility) Object.visible = Visible;

  if (Scratch.PivotPositionSaved) {
    Pivot.position.copy(Scratch.SavedPivotPosition);
    Scratch.PivotPositionSaved = false;
  }

  Scratch.SavedQuaternions.clear();
  Scratch.SavedScales.clear();
  Scratch.SavedVisibility.clear();
  Pivot.updateMatrixWorld(true);
}

const PreviousRender = Player.Render;
if (typeof PreviousRender !== "function") throw new Error("Player render function is unavailable for final contact pass.");

Player.Render = function RenderWithForcedFullBodyContact(Renderer, Scene, Camera) {
  const ProxyRenderer = {
    render(RenderScene, RenderCamera) {
      const Pivot = RenderScene.getObjectByName("PlayerCharacterPivot");

      if (!Pivot) {
        Renderer.render(RenderScene, RenderCamera);
        return;
      }

      try {
        ResolveAllVisibleContacts(Pivot);
        Player.ApplyCarpetRenderForce?.(Pivot);
        Player.ApplyCarpetShoeBoxGuard?.(Pivot);
        HideFirstPersonHead(Pivot);
        Renderer.render(RenderScene, RenderCamera);
      } finally {
        RestoreFinalPass(Pivot);
      }
    }
  };

  return PreviousRender.call(Player, ProxyRenderer, Scene, Camera);
};

window.__STORE_FINAL_CONTACT__ = {
  ForceCapsules,
  PoseSegments,
  State: SegmentState,
  Apply: ResolveAllVisibleContacts
};

window.__STORE_FINAL_CONTACT_BUILD__ = "V0.35.61-INDEPENDENT-LIMBS";