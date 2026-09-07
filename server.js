import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import pg from "pg";
import { Server as SocketIOServer } from "socket.io";

const { Pool } = pg;

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const NODE_ENV = String(process.env.NODE_ENV || "development");
const SERVER_VERSION = "0.3.4";
const NETWORK_PROTOCOL = 1;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const DEFAULT_MAX_PLAYERS = 4;
const STORE_START_SECONDS = 23 * 60 * 60 + 57 * 60;
const STORE_TIME_RATE = 14;
const SESSION_DAYS = 365;
const MOVEMENT_MIN_INTERVAL_MS = 35;
const MOVEMENT_MAX_SPEED = 8.25;
const MOVEMENT_BASE_ALLOWANCE = 0.42;
const DISCONNECT_GRACE_MS = 45_000;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SOCKET_AUTH_WINDOW_MS = 60_000;
const SOCKET_AUTH_LIMIT = 60;
const SOCKET_ROOM_ACTION_WINDOW_MS = 10_000;
const SOCKET_ROOM_ACTION_LIMIT = 18;
const SOCKET_MOVEMENT_WINDOW_MS = 1_000;
const SOCKET_MOVEMENT_LIMIT = 120;
const SOCKET_TASK_WINDOW_MS = 10_000;
const SOCKET_TASK_LIMIT = 20;
const SOCKET_PROFILE_WINDOW_MS = 60_000;
const SOCKET_PROFILE_LIMIT = 60;
const SOCKET_SETTINGS_WINDOW_MS = 60_000;
const SOCKET_SETTINGS_LIMIT = 12;
const SOCKET_PING_WINDOW_MS = 60_000;
const SOCKET_PING_LIMIT = 30;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add the Render Postgres Internal Database URL to the web service environment.");
}

const DEFAULT_ORIGINS = [
  "https://spongebobtdgameplay-prog.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];
const ConfiguredOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(Value => Value.trim())
  .filter(Boolean);
const CLIENT_ORIGINS = new Set([...DEFAULT_ORIGINS, ...ConfiguredOrigins]);

function OriginAllowed(Origin) {
  if (!Origin) return true;
  return CLIENT_ORIGINS.has(Origin);
}

function ShouldUseSSL() {
  if (/^(postgres|postgresql):\/\/(localhost|127\.0\.0\.1)/i.test(DATABASE_URL)) return false;
  if (process.env.PGSSL === "false") return false;
  if (process.env.PGSSL === "true") return true;
  return /[?&]sslmode=(require|verify-ca|verify-full)/i.test(DATABASE_URL);
}

const Database = new Pool({
  connectionString: DATABASE_URL,
  ssl: ShouldUseSSL() ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false
});

Database.on("error", Error => {
  console.error("Postgres pool error", Error);
});

async function InitializeDatabase() {
  await Database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(20) NOT NULL,
      username_key VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    )
  `);

  await Database.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      user_agent VARCHAR(256)
    )
  `);

  await Database.query(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`);
  await Database.query(`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)`);

  await Database.query(`
    CREATE TABLE IF NOT EXISTS player_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      games_played INTEGER NOT NULL DEFAULT 0,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      best_aisle INTEGER NOT NULL DEFAULT 0,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await Database.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

function NormalizeUsername(Value) {
  return String(Value || "").trim();
}

function UsernameKey(Value) {
  return NormalizeUsername(Value).toLowerCase();
}

function ValidateUsername(Value) {
  const Username = NormalizeUsername(Value);
  if (Username.length < 3 || Username.length > 20) return "USERNAME_LENGTH";
  if (!/^[A-Za-z0-9_]+$/.test(Username)) return "USERNAME_CHARACTERS";
  return "";
}

function ValidatePassword(Value) {
  const Password = String(Value || "");
  if (Password.length < 8) return "PASSWORD_TOO_SHORT";
  if (Password.length > 20) return "PASSWORD_TOO_LONG";
  if (!/^[\x20-\x7E]+$/.test(Password)) return "PASSWORD_CHARACTERS";
  return "";
}

function SessionTokenHash(Token) {
  return crypto.createHash("sha256").update(String(Token || "")).digest("hex");
}

function ValidSessionTokenShape(Token) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(Token || ""));
}

function NewSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function PublicAccount(Row) {
  return {
    id: Row.id,
    username: Row.username,
    createdAt: Row.created_at
  };
}

async function CreateSession(UserId, UserAgent = "") {
  const Token = NewSessionToken();
  const TokenHash = SessionTokenHash(Token);
  const SessionId = crypto.randomUUID();
  const ExpiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await Database.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [SessionId, UserId, TokenHash, ExpiresAt, String(UserAgent || "").slice(0, 256)]
  );
  await Database.query(
    `DELETE FROM sessions
     WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8
     )`,
    [UserId]
  );
  return { Token, ExpiresAt };
}

async function AccountFromToken(Token, Touch = true) {
  if (!ValidSessionTokenShape(Token)) return null;
  const TokenHash = SessionTokenHash(Token);
  const Result = await Database.query(
    `SELECT u.id, u.username, u.created_at, s.id AS session_id, s.last_seen_at, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.disabled = FALSE
     LIMIT 1`,
    [TokenHash]
  );
  const Row = Result.rows[0];
  if (!Row) return null;
  if (Touch && (!Row.last_seen_at || Date.now() - new Date(Row.last_seen_at).getTime() > 5 * 60 * 1000)) {
    const ExpiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
    await Database.query("UPDATE sessions SET last_seen_at = NOW(), expires_at = $2 WHERE id = $1", [Row.session_id, ExpiresAt]);
    Row.expires_at = ExpiresAt;
  }
  return {
    id: Row.id,
    username: Row.username,
    createdAt: Row.created_at,
    sessionId: Row.session_id,
    expiresAt: Row.expires_at
  };
}

function BearerToken(Request) {
  const Header = String(Request.headers.authorization || "");
  if (!Header.startsWith("Bearer ")) return "";
  return Header.slice(7).trim();
}

async function RequireAccount(Request, Response, Next) {
  try {
    const Account = await AccountFromToken(BearerToken(Request));
    if (!Account) return Response.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    Request.account = Account;
    return Next();
  } catch (Error) {
    console.error("Auth middleware failed", Error);
    return Response.status(503).json({ ok: false, error: "DATABASE_UNAVAILABLE" });
  }
}

function Clamp(Value, Min, Max) {
  return Math.min(Max, Math.max(Min, Number(Value) || 0));
}

function CleanProfileSettings(Value) {
  if (!Value || typeof Value !== "object" || Array.isArray(Value)) return {};
  const Result = {};
  if (Number.isFinite(Number(Value.Sensitivity))) Result.Sensitivity = Clamp(Value.Sensitivity, 0.35, 2);
  if (Number.isFinite(Number(Value.TrackpadSmoothing))) Result.TrackpadSmoothing = Clamp(Value.TrackpadSmoothing, 0, 100);
  if (Number.isFinite(Number(Value.Fov))) Result.Fov = Clamp(Value.Fov, 58, 100);
  if (["performance", "balanced", "high"].includes(Value.Graphics)) Result.Graphics = Value.Graphics;
  if (Number.isFinite(Number(Value.AmbientVolume))) Result.AmbientVolume = Clamp(Value.AmbientVolume, 0, 1);
  if (typeof Value.ShowFps === "boolean") Result.ShowFps = Value.ShowFps;
  return Result;
}

const App = express();
App.set("trust proxy", 1);
App.disable("x-powered-by");
App.use(helmet({ crossOriginResourcePolicy: false }));
App.use(express.json({ limit: "32kb" }));
App.use(cors({
  origin(Origin, Callback) {
    if (OriginAllowed(Origin)) return Callback(null, true);
    return Callback(new Error("Origin not allowed"));
  },
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const ApiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMITED" }
});

const AuthLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "TOO_MANY_ATTEMPTS" }
});

const PublicInfoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMITED" }
});

App.use("/api", ApiLimiter);

App.get("/", PublicInfoLimiter, (_Request, Response) => {
  Response.json({
    service: "The Infinity Store multiplayer server",
    status: "online",
    version: SERVER_VERSION,
    protocol: NETWORK_PROTOCOL
  });
});

App.get("/api/client-info", (_Request, Response) => {
  Response.json({
    ok: true,
    serverVersion: SERVER_VERSION,
    protocol: NETWORK_PROTOCOL,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS
  });
});

App.post("/api/auth/register", AuthLimiter, async (Request, Response) => {
  const Username = NormalizeUsername(Request.body?.username);
  const Password = String(Request.body?.password || "");
  const UsernameError = ValidateUsername(Username);
  const PasswordError = ValidatePassword(Password);
  if (UsernameError) return Response.status(400).json({ ok: false, error: UsernameError });
  if (PasswordError) return Response.status(400).json({ ok: false, error: PasswordError });

  try {
    const UserId = crypto.randomUUID();
    const PasswordHash = await argon2.hash(Password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32
    });
    const Client = await Database.connect();
    try {
      await Client.query("BEGIN");
      await Client.query(
        `INSERT INTO users (id, username, username_key, password_hash, last_login_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [UserId, Username, UsernameKey(Username), PasswordHash]
      );
      await Client.query("INSERT INTO player_profiles (user_id) VALUES ($1)", [UserId]);
      await Client.query("COMMIT");
    } catch (Error) {
      await Client.query("ROLLBACK");
      throw Error;
    } finally {
      Client.release();
    }

    const Session = await CreateSession(UserId, Request.headers["user-agent"]);
    return Response.status(201).json({
      ok: true,
      token: Session.Token,
      expiresAt: Session.ExpiresAt,
      account: { id: UserId, username: Username, createdAt: new Date().toISOString() },
      profile: { games_played: 0, tasks_completed: 0, best_aisle: 0, settings: {} }
    });
  } catch (Error) {
    if (Error?.code === "23505") return Response.status(409).json({ ok: false, error: "USERNAME_TAKEN" });
    console.error("Registration failed", Error);
    return Response.status(500).json({ ok: false, error: "REGISTER_FAILED" });
  }
});

App.post("/api/auth/login", AuthLimiter, async (Request, Response) => {
  const Username = NormalizeUsername(Request.body?.username);
  const Password = String(Request.body?.password || "");
  if (!Username || !Password) return Response.status(400).json({ ok: false, error: "MISSING_CREDENTIALS" });
  if (ValidateUsername(Username) || ValidatePassword(Password)) {
    return Response.status(401).json({ ok: false, error: "INVALID_LOGIN" });
  }

  try {
    const Result = await Database.query(
      `SELECT id, username, username_key, password_hash, created_at, disabled
       FROM users WHERE username_key = $1 LIMIT 1`,
      [UsernameKey(Username)]
    );
    const Row = Result.rows[0];
    if (!Row || Row.disabled) return Response.status(401).json({ ok: false, error: "INVALID_LOGIN" });
    const Valid = await argon2.verify(Row.password_hash, Password);
    if (!Valid) return Response.status(401).json({ ok: false, error: "INVALID_LOGIN" });

    const [Session, ProfileResult] = await Promise.all([
      CreateSession(Row.id, Request.headers["user-agent"]),
      Database.query(
        "SELECT games_played, tasks_completed, best_aisle, settings FROM player_profiles WHERE user_id = $1",
        [Row.id]
      ),
      Database.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [Row.id])
    ]);
    return Response.json({
      ok: true,
      token: Session.Token,
      expiresAt: Session.ExpiresAt,
      account: PublicAccount(Row),
      profile: ProfileResult.rows[0] || { games_played: 0, tasks_completed: 0, best_aisle: 0, settings: {} }
    });
  } catch (Error) {
    console.error("Login failed", Error);
    return Response.status(500).json({ ok: false, error: "LOGIN_FAILED" });
  }
});

App.get("/api/auth/me", RequireAccount, async (Request, Response) => {
  try {
    const ProfileResult = await Database.query(
      "SELECT games_played, tasks_completed, best_aisle, settings FROM player_profiles WHERE user_id = $1",
      [Request.account.id]
    );
    return Response.json({
      ok: true,
      account: {
        id: Request.account.id,
        username: Request.account.username,
        createdAt: Request.account.createdAt
      },
      profile: ProfileResult.rows[0] || { games_played: 0, tasks_completed: 0, best_aisle: 0, settings: {} }
    });
  } catch (Error) {
    console.error("Profile lookup failed", Error);
    return Response.status(500).json({ ok: false, error: "PROFILE_FAILED" });
  }
});

App.post("/api/auth/logout", RequireAccount, async (Request, Response) => {
  try {
    await Database.query("DELETE FROM sessions WHERE id = $1", [Request.account.sessionId]);
    return Response.json({ ok: true });
  } catch (Error) {
    console.error("Logout failed", Error);
    return Response.status(500).json({ ok: false, error: "LOGOUT_FAILED" });
  }
});

const HttpServer = http.createServer(App);
const IO = new SocketIOServer(HttpServer, {
  cors: {
    origin(Origin, Callback) {
      if (OriginAllowed(Origin)) return Callback(null, true);
      return Callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ["websocket"],
  allowUpgrades: false,
  pingInterval: 20_000,
  pingTimeout: 15_000,
  maxHttpBufferSize: 64 * 1024,
  perMessageDeflate: false,
  connectionStateRecovery: {
    maxDisconnectionDuration: DISCONNECT_GRACE_MS,
    skipMiddlewares: false
  }
});

const Rooms = new Map();
const SocketPlayers = new Map();
const SocketAuthWindows = new Map();

function ClientAddressFromSocket(Socket) {
  const Forwarded = String(Socket.handshake.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return (Forwarded || String(Socket.handshake.address || "unknown")).slice(0, 128);
}

function ConsumeRateWindow(MapValue, Key, Limit, WindowMs) {
  const Now = Date.now();
  const Existing = MapValue.get(Key);
  if (!Existing || Now - Existing.startedAt >= WindowMs) {
    MapValue.set(Key, { startedAt: Now, count: 1 });
    return true;
  }
  Existing.count += 1;
  return Existing.count <= Limit;
}

function AllowSocketEvent(Socket, Scope, Limit, WindowMs) {
  if (!Socket.data.rateWindows) Socket.data.rateWindows = new Map();
  return ConsumeRateWindow(Socket.data.rateWindows, Scope, Limit, WindowMs);
}

function RateLimitAck(Ack) {
  if (typeof Ack === "function") Ack({ ok: false, error: "RATE_LIMITED" });
}

App.get("/health", PublicInfoLimiter, async (_Request, Response) => {
  try {
    await Database.query("SELECT 1");
    Response.status(200).json({
      ok: true,
      version: SERVER_VERSION,
      protocol: NETWORK_PROTOCOL,
      uptime: Math.floor(process.uptime()),
      database: true,
      sockets: IO.engine.clientsCount,
      rooms: Rooms.size
    });
  } catch {
    Response.status(503).json({
      ok: false,
      version: SERVER_VERSION,
      protocol: NETWORK_PROTOCOL,
      database: false
    });
  }
});

function CleanRoomCode(Value) {
  return String(Value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}

function GenerateRoomCode() {
  for (let Attempt = 0; Attempt < 100; Attempt += 1) {
    let Code = "";
    for (let Index = 0; Index < ROOM_CODE_LENGTH; Index += 1) {
      Code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
    }
    if (!Rooms.has(Code)) return Code;
  }
  return crypto.randomBytes(8).toString("hex").toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

function RandomWorldSeed() {
  return crypto.randomInt(1, 0x100000000);
}

function CleanRoomSettings(Value = {}, Existing = null) {
  const RequestedMax = Math.floor(Number(Value.maxPlayers));
  const MaxPlayers = Number.isFinite(RequestedMax)
    ? Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, RequestedMax))
    : Existing?.maxPlayers || DEFAULT_MAX_PLAYERS;
  return {
    maxPlayers: MaxPlayers,
    allowLateJoin: Value.allowLateJoin === undefined ? (Existing?.allowLateJoin ?? false) : Boolean(Value.allowLateJoin),
    allowRandomJoin: Value.allowRandomJoin === undefined ? (Existing?.allowRandomJoin ?? true) : Boolean(Value.allowRandomJoin)
  };
}

function CreateRoom(HostAccount, Settings = {}) {
  const Clean = CleanRoomSettings(Settings);
  const Code = GenerateRoomCode();
  const Room = {
    code: Code,
    hostUserId: HostAccount.id,
    seed: RandomWorldSeed(),
    maxPlayers: Clean.maxPlayers,
    allowLateJoin: Clean.allowLateJoin,
    allowRandomJoin: Clean.allowRandomJoin,
    createdAt: Date.now(),
    started: false,
    startedAt: 0,
    players: new Map(),
    completedTasks: new Set()
  };
  Rooms.set(Code, Room);
  return Room;
}

function RoomStoreSeconds(Room, Now = Date.now()) {
  const Anchor = Room.startedAt || Room.createdAt;
  const Elapsed = Math.max(0, Now - Anchor) / 1000;
  return (STORE_START_SECONDS + Elapsed * STORE_TIME_RATE) % (24 * 60 * 60);
}

function ConnectedPlayers(Room) {
  if (!Room) return [];
  return [...Room.players.values()].filter(Player => Player.connected !== false);
}

function PublicMovement(Movement) {
  return {
    x: Movement.x,
    y: Movement.y,
    z: Movement.z,
    yaw: Movement.yaw,
    pitch: Movement.pitch,
    animation: Movement.animation,
    sprinting: Movement.sprinting,
    sequence: Movement.sequence,
    serverTime: Movement.serverTime
  };
}

function PublicPlayer(Player) {
  return {
    id: Player.socketId,
    userId: Player.userId,
    name: Player.name,
    joinedAt: Player.joinedAt,
    movement: PublicMovement(Player.movement)
  };
}

function PublicRoom(Room) {
  return {
    code: Room.code,
    hostUserId: Room.hostUserId,
    seed: Room.seed,
    minPlayers: MIN_PLAYERS,
    maxPlayers: Room.maxPlayers,
    playerCount: ConnectedPlayers(Room).length,
    allowLateJoin: Room.allowLateJoin,
    allowRandomJoin: Room.allowRandomJoin,
    started: Room.started,
    startedAt: Room.startedAt || null,
    storeSeconds: RoomStoreSeconds(Room),
    completedTasks: [...Room.completedTasks]
  };
}

function RoomPayload(Room) {
  return {
    room: PublicRoom(Room),
    players: ConnectedPlayers(Room).map(PublicPlayer),
    serverTime: Date.now()
  };
}

function EmitRoomState(Room) {
  if (!Room || !Rooms.has(Room.code)) return;
  IO.to(Room.code).emit("room:state", RoomPayload(Room));
}

function DefaultMovement() {
  return {
    x: 0,
    y: 1.68,
    z: 8,
    yaw: Math.PI,
    pitch: 0,
    animation: "idle",
    sprinting: false,
    sequence: 0,
    serverTime: Date.now()
  };
}

function PlayerRecord(Socket, Room) {
  const Account = Socket.data.account;
  return {
    socketId: Socket.id,
    userId: Account.id,
    name: Account.username,
    roomCode: Room.code,
    joinedAt: Date.now(),
    movement: DefaultMovement(),
    lastMovementPacketAt: 0,
    lastAcceptedMovementAt: 0,
    countedGame: false,
    connected: true,
    disconnectedAt: 0,
    disconnectTimer: null
  };
}

function CountGameForPlayer(Player) {
  if (!Player || Player.countedGame) return;
  Player.countedGame = true;
  Database.query(
    `UPDATE player_profiles
     SET games_played = games_played + 1, updated_at = NOW()
     WHERE user_id = $1`,
    [Player.userId]
  ).catch(() => {});
}

function ClearDisconnectTimer(Player) {
  if (!Player?.disconnectTimer) return;
  clearTimeout(Player.disconnectTimer);
  Player.disconnectTimer = null;
}

function FindRoomPlayerByUserId(Room, UserId) {
  if (!Room || !UserId) return null;
  return [...Room.players.values()].find(Player => Player.userId === UserId) || null;
}

function ReassignHost(Room) {
  if (!Room || Room.players.size === 0) return false;
  if ([...Room.players.values()].some(Player => Player.userId === Room.hostUserId)) return false;
  const Next = [...Room.players.values()].sort((Left, Right) => Left.joinedAt - Right.joinedAt)[0];
  Room.hostUserId = Next.userId;
  IO.to(Room.code).emit("room:host", { hostUserId: Room.hostUserId });
  return true;
}

function RemovePlayerRecord(Player, Emit = true) {
  if (!Player?.roomCode) return;
  ClearDisconnectTimer(Player);
  const Room = Rooms.get(Player.roomCode);
  const RoomCode = Player.roomCode;
  const SocketId = Player.socketId;

  SocketPlayers.delete(SocketId);
  if (!Room) return;

  Room.players.delete(SocketId);
  if (Emit) IO.to(RoomCode).emit("player:left", { id: SocketId, userId: Player.userId });
  if (Room.players.size === 0) {
    Rooms.delete(RoomCode);
  } else {
    ReassignHost(Room);
    EmitRoomState(Room);
  }
}

function LeaveCurrentRoom(Socket, Emit = true) {
  const Player = SocketPlayers.get(Socket.id);
  if (!Player?.roomCode) return;
  Socket.leave(Player.roomCode);
  RemovePlayerRecord(Player, Emit);
}

function ScheduleDisconnectCleanup(Socket) {
  const Player = SocketPlayers.get(Socket.id);
  if (!Player?.roomCode) return;
  const Room = Rooms.get(Player.roomCode);
  Player.connected = false;
  Player.disconnectedAt = Date.now();
  ClearDisconnectTimer(Player);
  Player.disconnectTimer = setTimeout(() => {
    const Current = SocketPlayers.get(Player.socketId);
    if (Current !== Player || Player.connected) return;
    RemovePlayerRecord(Player, true);
  }, DISCONNECT_GRACE_MS);
  Player.disconnectTimer.unref?.();
  if (Room) EmitRoomState(Room);
}

function CanJoinRoom(Room, RandomJoin = false) {
  if (!Room) return "ROOM_NOT_FOUND";
  if (Room.players.size >= Room.maxPlayers) return "ROOM_FULL";
  if (Room.started && !Room.allowLateJoin) return "LATE_JOIN_DISABLED";
  if (RandomJoin && !Room.allowRandomJoin) return "RANDOM_JOIN_DISABLED";
  return "";
}

function JoinResponse(Room, Player, Extra = {}) {
  return {
    ok: true,
    room: PublicRoom(Room),
    player: PublicPlayer(Player),
    players: ConnectedPlayers(Room).map(PublicPlayer),
    serverTime: Date.now(),
    ...Extra
  };
}

function JoinRoom(Socket, Room, Options = {}) {
  const RandomJoin = Boolean(Options.randomJoin);
  const Existing = SocketPlayers.get(Socket.id);

  if (Existing?.roomCode === Room?.code) {
    Existing.connected = true;
    Existing.disconnectedAt = 0;
    ClearDisconnectTimer(Existing);
    return JoinResponse(Room, Existing);
  }

  if (!Room) return { ok: false, error: "ROOM_NOT_FOUND" };

  const Returning = FindRoomPlayerByUserId(Room, Socket.data.account.id);
  if (Returning && Returning.socketId !== Socket.id) {
    const PreviousSocket = IO.sockets.sockets.get(Returning.socketId);
    if (Returning.connected && PreviousSocket?.connected) return { ok: false, error: "ACCOUNT_ALREADY_IN_ROOM" };

    const PreviousSocketId = Returning.socketId;
    ClearDisconnectTimer(Returning);
    Room.players.delete(PreviousSocketId);
    SocketPlayers.delete(PreviousSocketId);

    Returning.socketId = Socket.id;
    Returning.connected = true;
    Returning.disconnectedAt = 0;
    Returning.lastMovementPacketAt = 0;
    Returning.lastAcceptedMovementAt = 0;
    Returning.movement = {
      ...Returning.movement,
      sequence: 0,
      serverTime: Date.now()
    };

    Room.players.set(Socket.id, Returning);
    SocketPlayers.set(Socket.id, Returning);
    Socket.join(Room.code);
    if (Room.started) CountGameForPlayer(Returning);

    IO.to(Room.code).emit("player:left", { id: PreviousSocketId, userId: Returning.userId });
    Socket.to(Room.code).emit("player:joined", PublicPlayer(Returning));
    EmitRoomState(Room);
    return JoinResponse(Room, Returning, { reconnected: true });
  }

  const Error = CanJoinRoom(Room, RandomJoin);
  if (Error) return { ok: false, error: Error };
  if (Existing) LeaveCurrentRoom(Socket);

  const Player = PlayerRecord(Socket, Room);
  Room.players.set(Socket.id, Player);
  SocketPlayers.set(Socket.id, Player);
  Socket.join(Room.code);
  if (Room.started) CountGameForPlayer(Player);

  Socket.to(Room.code).emit("player:joined", PublicPlayer(Player));
  EmitRoomState(Room);
  return JoinResponse(Room, Player);
}

function CreateOrReuseRoom(Socket, Settings = {}) {
  const ExistingPlayer = SocketPlayers.get(Socket.id);
  const ExistingRoom = ExistingPlayer ? Rooms.get(ExistingPlayer.roomCode) : null;

  if (ExistingRoom && !ExistingRoom.started && ExistingRoom.hostUserId === Socket.data.account.id) {
    ExistingPlayer.connected = true;
    ExistingPlayer.disconnectedAt = 0;
    ClearDisconnectTimer(ExistingPlayer);
    return JoinResponse(ExistingRoom, ExistingPlayer, { reused: true });
  }

  if (ExistingPlayer) LeaveCurrentRoom(Socket);
  return JoinRoom(Socket, CreateRoom(Socket.data.account, Settings));
}

function QuickJoinRoom(Socket) {
  const Candidate = [...Rooms.values()]
    .filter(Room => Room.allowRandomJoin)
    .filter(Room => Room.players.size < Room.maxPlayers)
    .filter(Room => !Room.started || Room.allowLateJoin)
    .sort((Left, Right) => {
      if (Left.started !== Right.started) return Left.started ? 1 : -1;
      return ConnectedPlayers(Right).length - ConnectedPlayers(Left).length || Left.createdAt - Right.createdAt;
    })[0];

  if (!Candidate) return { ok: false, error: "NO_AVAILABLE_ROOM" };
  return JoinRoom(Socket, Candidate, { randomJoin: true });
}

function UpdateRoomSettings(Socket, Value = {}) {
  const Player = SocketPlayers.get(Socket.id);
  const Room = Player ? Rooms.get(Player.roomCode) : null;
  if (!Player || !Room) return { ok: false, error: "NOT_IN_ROOM" };
  if (Room.hostUserId !== Player.userId) return { ok: false, error: "HOST_ONLY" };
  if (Room.started) return { ok: false, error: "GAME_ALREADY_STARTED" };

  const Clean = CleanRoomSettings(Value, Room);
  if (Clean.maxPlayers < Room.players.size) return { ok: false, error: "MAX_PLAYERS_TOO_LOW" };
  Room.maxPlayers = Clean.maxPlayers;
  Room.allowLateJoin = Clean.allowLateJoin;
  Room.allowRandomJoin = Clean.allowRandomJoin;
  EmitRoomState(Room);
  return { ok: true, room: PublicRoom(Room), serverTime: Date.now() };
}

function StartRoom(Socket) {
  const Player = SocketPlayers.get(Socket.id);
  const Room = Player ? Rooms.get(Player.roomCode) : null;
  if (!Player || !Room) return { ok: false, error: "NOT_IN_ROOM" };
  if (Room.hostUserId !== Player.userId) return { ok: false, error: "HOST_ONLY" };
  if (Room.started) return { ok: true, room: PublicRoom(Room), serverTime: Date.now(), alreadyStarted: true };

  const Connected = ConnectedPlayers(Room);
  if (Connected.length < MIN_PLAYERS) return { ok: false, error: "NOT_ENOUGH_PLAYERS" };

  Room.started = true;
  Room.startedAt = Date.now();
  for (const Member of Connected) CountGameForPlayer(Member);
  const Payload = RoomPayload(Room);
  IO.to(Room.code).emit("room:started", Payload);
  EmitRoomState(Room);
  return { ok: true, room: PublicRoom(Room), serverTime: Date.now() };
}

function CleanFinite(Value, Fallback = 0) {
  const NumberValue = Number(Value);
  return Number.isFinite(NumberValue) ? NumberValue : Fallback;
}

function NormalizeAngle(Value) {
  return Math.atan2(Math.sin(Value), Math.cos(Value));
}

function CleanMovement(Payload = {}) {
  const Animation = ["idle", "walk", "sprint"].includes(Payload.animation) ? Payload.animation : "idle";
  return {
    x: CleanFinite(Payload.x),
    y: Clamp(CleanFinite(Payload.y, 1.68), 0.25, 3.6),
    z: CleanFinite(Payload.z, 8),
    yaw: NormalizeAngle(CleanFinite(Payload.yaw)),
    pitch: Clamp(CleanFinite(Payload.pitch), -1.45, 1.45),
    animation: Animation,
    sprinting: Boolean(Payload.sprinting) && Animation === "sprint",
    sequence: Math.max(0, Math.floor(CleanFinite(Payload.sequence))),
    serverTime: Date.now()
  };
}

function MovementValid(Player, Next, Now) {
  if (Math.abs(Next.x) > 16.75) return false;
  if (Math.abs(Next.z) > 1_000_000) return false;
  if (Player.movement.sequence === 0) return true;
  const DeltaSeconds = Math.max(0.001, (Now - Player.lastAcceptedMovementAt) / 1000);
  const DX = Next.x - Player.movement.x;
  const DZ = Next.z - Player.movement.z;
  const Distance = Math.hypot(DX, DZ);
  const Allowed = MOVEMENT_BASE_ALLOWANCE + MOVEMENT_MAX_SPEED * DeltaSeconds;
  return Distance <= Allowed;
}

function ValidTaskId(Value) {
  const Text = String(Value || "");
  return /^Chunk-[1-9]\d*:(breaker|manifest|scanner)$/.test(Text) ? Text : "";
}

IO.use(async (Socket, Next) => {
  try {
    const Protocol = Number(Socket.handshake.auth?.protocol);
    if (Protocol !== NETWORK_PROTOCOL) return Next(new Error("SESSION_OUTDATED"));

    const Address = ClientAddressFromSocket(Socket);
    if (!ConsumeRateWindow(SocketAuthWindows, Address, SOCKET_AUTH_LIMIT, SOCKET_AUTH_WINDOW_MS)) {
      return Next(new Error("RATE_LIMITED"));
    }

    const Token = String(Socket.handshake.auth?.token || "");
    if (!ValidSessionTokenShape(Token)) return Next(new Error("AUTH_REQUIRED"));
    const Account = await AccountFromToken(Token);
    if (!Account) return Next(new Error("AUTH_REQUIRED"));
    Socket.data.account = Account;
    Socket.data.sessionToken = Token;
    return Next();
  } catch (Error) {
    console.error("Socket authentication failed", Error);
    return Next(new Error("AUTH_UNAVAILABLE"));
  }
});

IO.on("connection", Socket => {
  const Account = Socket.data.account;
  const PreservedPlayer = SocketPlayers.get(Socket.id);
  if (PreservedPlayer && PreservedPlayer.userId === Account.id) {
    PreservedPlayer.connected = true;
    PreservedPlayer.disconnectedAt = 0;
    ClearDisconnectTimer(PreservedPlayer);
    if (PreservedPlayer.roomCode) Socket.join(PreservedPlayer.roomCode);
    const PreservedRoom = Rooms.get(PreservedPlayer.roomCode);
    if (PreservedRoom) EmitRoomState(PreservedRoom);
  }

  Socket.emit("server:ready", {
    id: Socket.id,
    userId: Account.id,
    name: Account.username,
    version: SERVER_VERSION,
    protocol: NETWORK_PROTOCOL,
    transport: Socket.conn.transport.name,
    recovered: Socket.recovered
  });

  Socket.on("room:quickJoin", (_Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    Ack(QuickJoinRoom(Socket));
  });

  Socket.on("room:create", (Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    Ack(CreateOrReuseRoom(Socket, Payload));
  });

  Socket.on("room:join", (Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    const Code = CleanRoomCode(Payload.code);
    if (Code.length !== ROOM_CODE_LENGTH) return Ack({ ok: false, error: "ROOM_CODE_REQUIRED" });
    return Ack(JoinRoom(Socket, Rooms.get(Code)));
  });

  Socket.on("room:leave", (_Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    LeaveCurrentRoom(Socket);
    Ack({ ok: true });
  });

  Socket.on("room:updateSettings", (Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    Ack(UpdateRoomSettings(Socket, Payload));
  });

  Socket.on("room:start", (_Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "room-action", SOCKET_ROOM_ACTION_LIMIT, SOCKET_ROOM_ACTION_WINDOW_MS)) return RateLimitAck(Ack);
    Ack(StartRoom(Socket));
  });

  Socket.on("movement:update", Payload => {
    if (!AllowSocketEvent(Socket, "movement", SOCKET_MOVEMENT_LIMIT, SOCKET_MOVEMENT_WINDOW_MS)) {
      Socket.disconnect(true);
      return;
    }
    const Player = SocketPlayers.get(Socket.id);
    if (!Player?.roomCode || Player.connected === false) return;
    const Room = Rooms.get(Player.roomCode);
    if (!Room?.started) return;

    const Now = Date.now();
    if (Now - Player.lastMovementPacketAt < MOVEMENT_MIN_INTERVAL_MS) return;
    Player.lastMovementPacketAt = Now;

    const Next = CleanMovement(Payload);
    if (Next.sequence <= Player.movement.sequence && Player.movement.sequence !== 0) return;
    if (!MovementValid(Player, Next, Now)) {
      Socket.emit("movement:correction", PublicMovement(Player.movement));
      return;
    }

    Player.movement = Next;
    Player.lastAcceptedMovementAt = Now;
    Socket.to(Room.code).volatile.emit("movement:snapshot", {
      id: Socket.id,
      userId: Player.userId,
      ...PublicMovement(Next)
    });
  });

  Socket.on("task:complete", (Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "task", SOCKET_TASK_LIMIT, SOCKET_TASK_WINDOW_MS)) return RateLimitAck(Ack);
    const Player = SocketPlayers.get(Socket.id);
    const Room = Player ? Rooms.get(Player.roomCode) : null;
    if (!Player || Player.connected === false || !Room?.started) return Ack({ ok: false, error: "NOT_IN_ACTIVE_ROOM" });
    const TaskId = ValidTaskId(Payload.taskId);
    if (!TaskId) return Ack({ ok: false, error: "INVALID_TASK" });
    if (Room.completedTasks.has(TaskId)) return Ack({ ok: true, alreadyCompleted: true });

    Room.completedTasks.add(TaskId);
    IO.to(Room.code).emit("task:completed", {
      taskId: TaskId,
      userId: Player.userId,
      name: Player.name,
      serverTime: Date.now()
    });
    Database.query(
      `UPDATE player_profiles
       SET tasks_completed = tasks_completed + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [Player.userId]
    ).catch(() => {});
    return Ack({ ok: true });
  });

  Socket.on("profile:aisle", Payload => {
    if (!AllowSocketEvent(Socket, "profile", SOCKET_PROFILE_LIMIT, SOCKET_PROFILE_WINDOW_MS)) return;
    const Aisle = Math.max(0, Math.min(1_000_000, Math.floor(CleanFinite(Payload?.aisle))));
    if (!Aisle) return;
    Database.query(
      `UPDATE player_profiles
       SET best_aisle = GREATEST(best_aisle, $2), updated_at = NOW()
       WHERE user_id = $1`,
      [Account.id, Aisle]
    ).catch(() => {});
  });

  Socket.on("profile:updateSettings", async (Payload = {}, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "settings", SOCKET_SETTINGS_LIMIT, SOCKET_SETTINGS_WINDOW_MS)) return RateLimitAck(Ack);
    const Settings = CleanProfileSettings(Payload.settings);
    try {
      await Database.query(
        `UPDATE player_profiles
         SET settings = $2::jsonb, updated_at = NOW()
         WHERE user_id = $1`,
        [Account.id, JSON.stringify(Settings)]
      );
      return Ack({ ok: true, settings: Settings });
    } catch (Error) {
      console.error("Settings update failed", Error);
      return Ack({ ok: false, error: "SETTINGS_UPDATE_FAILED" });
    }
  });

  Socket.on("ping:client", (ClientTime, Ack = () => {}) => {
    if (!AllowSocketEvent(Socket, "ping", SOCKET_PING_LIMIT, SOCKET_PING_WINDOW_MS)) return RateLimitAck(Ack);
    Ack({ clientTime: CleanFinite(ClientTime), serverTime: Date.now() });
  });

  Socket.on("disconnect", () => {
    ScheduleDisconnectCleanup(Socket);
  });
});

App.get("/api/rooms", RequireAccount, (_Request, Response) => {
  const AvailableRooms = [...Rooms.values()]
    .filter(Room => Room.allowRandomJoin)
    .filter(Room => Room.players.size < Room.maxPlayers)
    .filter(Room => !Room.started || Room.allowLateJoin)
    .map(Room => ({
      code: Room.code,
      players: ConnectedPlayers(Room).length,
      maxPlayers: Room.maxPlayers,
      started: Room.started
    }));
  Response.json({ ok: true, rooms: AvailableRooms });
});

const SessionCleanupInterval = setInterval(() => {
  Database.query("DELETE FROM sessions WHERE expires_at <= NOW()").catch(() => {});
}, 60 * 60 * 1000);
SessionCleanupInterval.unref?.();

const AbuseCleanupInterval = setInterval(() => {
  const Now = Date.now();
  for (const [Key, Window] of SocketAuthWindows) {
    if (Now - Window.startedAt > SOCKET_AUTH_WINDOW_MS * 2) SocketAuthWindows.delete(Key);
  }
}, 60_000);
AbuseCleanupInterval.unref?.();

await InitializeDatabase();

HttpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`The Infinity Store server v${SERVER_VERSION} protocol ${NETWORK_PROTOCOL} listening on port ${PORT} (${NODE_ENV})`);
});

async function Shutdown(Signal) {
  console.log(`${Signal} received; shutting down.`);
  clearInterval(SessionCleanupInterval);
  clearInterval(AbuseCleanupInterval);
  SocketAuthWindows.clear();
  for (const Player of SocketPlayers.values()) ClearDisconnectTimer(Player);
  IO.close();
  HttpServer.close(async () => {
    try {
      await Database.end();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => Shutdown("SIGTERM"));
process.on("SIGINT", () => Shutdown("SIGINT"));