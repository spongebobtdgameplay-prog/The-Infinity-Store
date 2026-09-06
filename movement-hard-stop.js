(() => {
  let PhysicsValue = null;

  function Clamp(Value, Min, Max) {
    return Math.min(Max, Math.max(Min, Value));
  }

  function RelevantEntries(Start, End, Radius, Entries, Collision) {
    const Result = [];
    const Padding = Radius + 0.72;
    const MinX = Math.min(Start.x, End.x) - Padding;
    const MaxX = Math.max(Start.x, End.x) + Padding;
    const MinZ = Math.min(Start.z, End.z) - Padding;
    const MaxZ = Math.max(Start.z, End.z) + Padding;

    for (const Entry of Entries || []) {
      if (!Entry || Entry.Active === false) continue;
      const Bounds = Collision.EntryBounds?.(Entry);
      if (!Bounds?.min || !Bounds?.max) continue;
      if (Bounds.max.x < MinX || Bounds.min.x > MaxX) continue;
      if (Bounds.max.z < MinZ || Bounds.min.z > MaxZ) continue;
      Result.push(Entry);
    }

    return Result;
  }

  function IsBlocked(Position, Radius, Entries, Collision) {
    return Collision.IsCircleBlocked?.(Position, Radius, Entries, {
      Filter: Entry => Entry?.Active !== false
    }) === true;
  }

  function FindNearestSafe(Position, Radius, Entries, Collision) {
    if (!IsBlocked(Position, Radius, Entries, Collision)) return Position.clone();

    const Candidate = Position.clone();
    let Best = null;
    let BestDistance = Infinity;
    const DirectionCount = 20;

    for (let Ring = 1; Ring <= 24; Ring += 1) {
      const Distance = Ring * 0.025;
      if (Distance >= BestDistance) break;

      for (let DirectionIndex = 0; DirectionIndex < DirectionCount; DirectionIndex += 1) {
        const Angle = DirectionIndex / DirectionCount * Math.PI * 2;
        Candidate.copy(Position);
        Candidate.x += Math.cos(Angle) * Distance;
        Candidate.z += Math.sin(Angle) * Distance;
        if (IsBlocked(Candidate, Radius, Entries, Collision)) continue;
        Best = Candidate.clone();
        BestDistance = Distance;
        break;
      }
    }

    return Best || Position.clone();
  }

  function Patch(Physics) {
    if (!Physics || Physics.__FullBodyHardStopPatched) return;
    if (typeof Physics.MoveCharacter !== "function") return;

    const OriginalMoveCharacter = Physics.MoveCharacter.bind(Physics);

    Physics.MoveCharacter = function(Camera, ForwardAmount, RightAmount, Distance, Delta, Entries, Radius) {
      if (!Camera?.position) {
        return OriginalMoveCharacter(Camera, ForwardAmount, RightAmount, Distance, Delta, Entries, Radius);
      }

      const Start = Camera.position.clone();
      const Result = OriginalMoveCharacter(Camera, ForwardAmount, RightAmount, Distance, Delta, Entries, Radius);
      const Collision = window.__STORE_COLLISION_UTILITY__;
      if (!Collision?.ResolveHorizontalMove || !Collision?.IsCircleBlocked) return Result;

      const RequestedRadius = Clamp(Number(Radius) || 0.48, 0.38, 0.52);
      const RawEnd = Camera.position.clone();
      const Motion = RawEnd.clone().sub(Start);
      Motion.y = 0;
      const MotionLength = Motion.length();

      if (MotionLength <= 0.000001) return Result;

      const CollisionEntries = Array.isArray(Entries)
        ? Entries
        : Array.isArray(window.__STORE_COLLISION_BOXES__)
          ? window.__STORE_COLLISION_BOXES__
          : [];
      const Nearby = RelevantEntries(Start, RawEnd, RequestedRadius, CollisionEntries, Collision);
      if (!Nearby.length) return Result;

      let Position = FindNearestSafe(Start, RequestedRadius, Nearby, Collision);
      const StepCount = Clamp(Math.ceil(MotionLength / 0.02), 1, 48);
      const Step = Motion.clone().multiplyScalar(1 / StepCount);
      let Hit = Position.distanceToSquared(Start) > 0.000001;
      let LastEntry = null;
      let LastNormal = null;

      for (let StepIndex = 0; StepIndex < StepCount; StepIndex += 1) {
        const StepResult = Collision.ResolveHorizontalMove(
          Position,
          Step,
          RequestedRadius,
          Nearby,
          {
            Skin: 0.014,
            AllowSlide: true,
            MaxIterations: 5,
            MaxSweepSteps: 12,
            BinarySteps: 22,
            SlideIntentThreshold: 0.04,
            Filter: Entry => Entry?.Active !== false
          }
        );

        if (!StepResult?.Position) break;
        const Previous = Position;
        Position = StepResult.Position.clone();

        if (IsBlocked(Position, RequestedRadius, Nearby, Collision)) {
          Position = Previous.clone();
          Hit = true;
          LastEntry = StepResult.Entry || LastEntry;
          LastNormal = StepResult.Normal?.clone?.() || LastNormal;
          break;
        }

        if (StepResult.Hit) {
          Hit = true;
          LastEntry = StepResult.Entry || LastEntry;
          LastNormal = StepResult.Normal?.clone?.() || LastNormal;
        }
      }

      if (IsBlocked(Position, RequestedRadius, Nearby, Collision)) {
        Position = FindNearestSafe(Position, RequestedRadius, Nearby, Collision);
        Hit = true;
      }

      Camera.position.x = Position.x;
      Camera.position.z = Position.z;

      if (Result && typeof Result === "object") {
        const Resolved = Position.clone().sub(Start);
        Resolved.y = 0;
        Result.Position = Camera.position.clone();
        Result.Resolved = Resolved;
        Result.Hit = Boolean(Result.Hit || Hit);
        if (LastEntry) Result.Entry = LastEntry;
        if (LastNormal) Result.Normal = LastNormal;
        Result.FullBodyRadius = RequestedRadius;
        Result.HardStop = Hit;
      }

      return Result;
    };

    Object.defineProperty(Physics, "__FullBodyHardStopPatched", {
      value: true,
      configurable: false,
      enumerable: false
    });
    window.__STORE_MOVEMENT_HARD_STOP__ = {
      Build: "V0.35.53",
      RadiusMin: 0.38,
      RadiusMax: 0.52,
      SweepStep: 0.02
    };
  }

  Object.defineProperty(window, "__STORE_PROCEDURAL_PHYSICS__", {
    configurable: true,
    get() {
      return PhysicsValue;
    },
    set(Value) {
      PhysicsValue = Value;
      Patch(Value);
    }
  });
})();