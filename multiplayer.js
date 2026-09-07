const SERVER_URL = "https://the-infinity-store-vh88.onrender.com";
const CLIENT_PROTOCOL = 1;
const TOKEN_KEY = "InfinityStoreSessionV1";
const ROOM_KEY = "InfinityStoreRoomV1";
const SAVED_ACCOUNTS_KEY = "InfinityStoreSavedAccountsV1";
const SETTINGS_KEY = "InfiniteFurnitureStoreSettingsV3";
const PLAYER_MODEL_URL = "https://raw.githubusercontent.com/euuuuuuan/fatal-funnel-public/main/packages/renderer/assets/models/quaternius-men/worker.glb";
const PLAYER_HEIGHT = 1.76;
const SEND_INTERVAL_MS = 50;
const INTERPOLATION_DELAY_MS = 115;
const MAX_SNAPSHOT_AGE_MS = 5000;
const SERVER_WAKE_TIMEOUT_MS = 45_000;
const COMPATIBILITY_CACHE_MS = 60_000;
const STORE_TIME_RATE = 14;
const DAY_SECONDS = 24 * 60 * 60;

function GenerateWorldSeed() {
  const Values = new Uint32Array(1);
  crypto.getRandomValues(Values);
  return (Values[0] >>> 0) || 1;
}

let SinglePlayerWorldSeed = GenerateWorldSeed();
window.__STORE_WORLD_SEED__ = SinglePlayerWorldSeed;
window.__STORE_WORLD_SEED_SOURCE__ = "SOLO_RUNTIME";

let SessionToken = localStorage.getItem(TOKEN_KEY) || "";
let DesiredRoomCode = localStorage.getItem(ROOM_KEY) || "";
let Account = null;
let Profile = null;
let Socket = null;
let SocketIo = null;
let ConnectFlight = null;
let CreateRoomFlight = null;
let JoinFlight = null;
let CompatibilityFlight = null;
let CompatibilityResult = null;
let CompatibilityCheckedAt = 0;
let CurrentRoom = null;
let CurrentRoomServerTime = 0;
let CurrentPlayers = [];
let Status = "offline";
let ServerClockOffset = 0;
let AccountGateResolved = false;
let ResolveAccountGate = null;
let CoreReady = false;
let GameAttached = false;
let GameRuntimeStarted = false;
let Game = null;
let Player = null;
let THREE = null;
let GLTFLoader = null;
let SkeletonUtils = null;
let Loader = null;
let RemoteAssetPromise = null;
let LastFrameAt = performance.now();
let LastSendAt = 0;
let Sequence = 0;
let HasLastSentPosition = false;
let LastAisleReport = 0;
let TempDirection = null;
let TempPosition = null;
let TempPositionB = null;
let LastSentPosition = null;
let NavigationObserver = null;
let RoomSeedFlight = null;
let StartGameFlight = null;

const RemotePlayers = new Map();
const SharedCompletedTasks = new Set();
const PendingCompletedTasks = new Set();

const AccountGate = new Promise(Resolve => {
  ResolveAccountGate = Resolve;
});

function Dispatch(Name, Detail = {}) {
  window.dispatchEvent(new CustomEvent(Name, { detail: Detail }));
}

function GetState() {
  return {
    serverUrl: SERVER_URL,
    status: Status,
    connected: Boolean(Socket?.connected),
    account: Account,
    profile: Profile,
    room: CurrentRoom,
    players: [...CurrentPlayers],
    remotePlayers: RemotePlayers.size
  };
}

function SetStatus(Value) {
  if (Status === Value) return;
  Status = Value;
  Dispatch("store-network-change", GetState());
  RenderNetworkStatus();
}

function StoreSession(Token) {
  SessionToken = String(Token || "");
  if (SessionToken) localStorage.setItem(TOKEN_KEY, SessionToken);
  else localStorage.removeItem(TOKEN_KEY);
}

function SaveDesiredRoom(Code) {
  DesiredRoomCode = String(Code || "");
  if (DesiredRoomCode) localStorage.setItem(ROOM_KEY, DesiredRoomCode);
  else localStorage.removeItem(ROOM_KEY);
}

function ReadSavedAccounts() {
  try {
    const Value = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]");
    if (!Array.isArray(Value)) return [];
    return Value.filter(Item => typeof Item === "string" && Item.length >= 3 && Item.length <= 20).slice(0, 8);
  } catch {
    return [];
  }
}

function SaveAccountName(Name) {
  const Username = String(Name || "").trim();
  if (!Username) return;
  const Existing = ReadSavedAccounts().filter(Item => Item.toLowerCase() !== Username.toLowerCase());
  Existing.unshift(Username);
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(Existing.slice(0, 8)));
  RenderAccountChoices();
}

function ApplyProfileSettings() {
  if (!Profile?.settings || typeof Profile.settings !== "object" || Array.isArray(Profile.settings)) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(Profile.settings));
  } catch {}
}

async function Api(Path, Options = {}) {
  const Controller = new AbortController();
  const Timeout = setTimeout(() => Controller.abort(), Options.timeout || 15_000);
  try {
    const Headers = { "Content-Type": "application/json", ...(Options.headers || {}) };
    if (Options.auth !== false && SessionToken) Headers.Authorization = `Bearer ${SessionToken}`;
    const Response = await fetch(`${SERVER_URL}${Path}`, {
      method: Options.method || "GET",
      headers: Headers,
      body: Options.body === undefined ? undefined : JSON.stringify(Options.body),
      signal: Controller.signal,
      cache: "no-store"
    });
    let Data = null;
    try {
      Data = await Response.json();
    } catch {
      Data = { ok: false, error: "INVALID_SERVER_RESPONSE" };
    }
    if (!Response.ok && !Data?.error) Data.error = `HTTP_${Response.status}`;
    return Data;
  } catch (Error) {
    if (Error?.name === "AbortError") return { ok: false, error: "SERVER_TIMEOUT" };
    return { ok: false, error: "SERVER_UNREACHABLE" };
  } finally {
    clearTimeout(Timeout);
  }
}

async function CheckCompatibility(Force = false) {
  const Now = Date.now();
  if (!Force && CompatibilityResult?.ok && Now - CompatibilityCheckedAt < COMPATIBILITY_CACHE_MS) return CompatibilityResult;
  if (CompatibilityFlight) return CompatibilityFlight;

  CompatibilityFlight = (async () => {
    const Result = await Api("/api/client-info", { auth: false, timeout: SERVER_WAKE_TIMEOUT_MS });
    if (!Result?.ok) {
      if (Result?.error === "HTTP_404") {
        ShowOutdated();
        return { ok: false, error: "SESSION_OUTDATED" };
      }
      return Result;
    }
    if (Number(Result.protocol) !== CLIENT_PROTOCOL) {
      ShowOutdated();
      return { ok: false, error: "SESSION_OUTDATED" };
    }
    CompatibilityResult = Result;
    CompatibilityCheckedAt = Date.now();
    return Result;
  })().finally(() => {
    CompatibilityFlight = null;
  });

  return CompatibilityFlight;
}

function ErrorText(Error) {
  const Map = {
    USERNAME_LENGTH: "Username must be 3 to 20 characters.",
    USERNAME_CHARACTERS: "Username can only use letters, numbers, and underscores.",
    PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
    PASSWORD_TOO_LONG: "Password can be at most 20 characters.",
    PASSWORD_CHARACTERS: "Password must use normal printable keyboard characters.",
    PASSWORDS_DO_NOT_MATCH: "The two passwords do not match.",
    USERNAME_TAKEN: "That username is already taken.",
    INVALID_LOGIN: "Username or password is incorrect.",
    MISSING_CREDENTIALS: "Enter your username and password.",
    TOO_MANY_ATTEMPTS: "Too many attempts. Try again shortly.",
    REGISTER_FAILED: "Account creation failed.",
    LOGIN_FAILED: "Login failed.",
    AUTH_REQUIRED: "Your session expired. Sign in again.",
    AUTH_UNAVAILABLE: "Account verification is temporarily unavailable.",
    SERVER_TIMEOUT: "The multiplayer server took too long to respond.",
    SERVER_UNREACHABLE: "The multiplayer server is unreachable.",
    SOCKET_OFFLINE: "The realtime connection is offline.",
    NO_AVAILABLE_ROOM: "No available multiplayer server exists right now.",
    ROOM_NOT_FOUND: "That game code does not exist anymore.",
    ROOM_FULL: "That game is full.",
    ROOM_CODE_REQUIRED: "Enter the 6-character game code.",
    LATE_JOIN_DISABLED: "That game already started and late joining is off.",
    RANDOM_JOIN_DISABLED: "That game does not allow random joining.",
    ACCOUNT_ALREADY_IN_ROOM: "This account is already in that game.",
    NOT_IN_ROOM: "You are not in a multiplayer lobby.",
    HOST_ONLY: "Only the host can do that.",
    GAME_ALREADY_STARTED: "That game has already started.",
    MAX_PLAYERS_TOO_LOW: "The player limit cannot be lower than the current player count.",
    NOT_ENOUGH_PLAYERS: "At least 2 players are required to start.",
    SESSION_OUTDATED: "This game session is outdated. Refresh the page.",
    RATE_LIMITED: "Too many requests. Try again shortly."
  };
  return Map[Error] || String(Error || "Something went wrong.");
}

function ValidateClientUsername(Value) {
  const Username = String(Value || "").trim();
  if (Username.length < 3 || Username.length > 20) return "USERNAME_LENGTH";
  if (!/^[A-Za-z0-9_]+$/.test(Username)) return "USERNAME_CHARACTERS";
  return "";
}

function ValidateClientPassword(Value) {
  const Password = String(Value || "");
  if (Password.length < 8) return "PASSWORD_TOO_SHORT";
  if (Password.length > 20) return "PASSWORD_TOO_LONG";
  if (!/^[\x20-\x7E]+$/.test(Password)) return "PASSWORD_CHARACTERS";
  return "";
}

const Style = document.createElement("style");
Style.id = "StoreMultiplayerStyle";
Style.textContent = `
.StoreNetworkOverlay{position:fixed;inset:0;z-index:2500;display:grid;place-items:center;padding:calc(var(--safe-top,10px) + 12px) calc(var(--safe-right,10px) + 12px) calc(var(--safe-bottom,10px) + 12px) calc(var(--safe-left,10px) + 12px);background:linear-gradient(90deg,rgba(4,5,6,.94),rgba(4,5,6,.82));backdrop-filter:blur(10px);color:#f4efe6;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}
.StoreNetworkOverlay[hidden]{display:none}
.StoreNetworkCard{width:min(760px,100%);max-height:calc(100dvh - var(--safe-top,10px) - var(--safe-bottom,10px) - 24px);overflow:auto;border:1px solid rgba(255,255,255,.11);background:linear-gradient(160deg,rgba(20,22,24,.98),rgba(9,10,12,.96));box-shadow:0 30px 80px rgba(0,0,0,.54)}
.StoreAccountCard{width:min(560px,100%)}
.StoreNetworkHead{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:clamp(16px,2.6vw,22px) clamp(17px,3vw,24px);border-bottom:1px solid rgba(255,255,255,.09);background:rgba(18,20,21,.97)}
.StoreNetworkHead small{display:block;color:#c99358;font-size:clamp(.52rem,1.4vw,.59rem);font-weight:900;letter-spacing:.18em}
.StoreNetworkHead h2{margin:5px 0 0;font-size:clamp(.88rem,2.4vw,1.08rem);letter-spacing:.10em}
.StoreNetworkClose{flex:0 0 42px;width:42px;height:42px;border:1px solid rgba(255,255,255,.22);background:#242826;color:#fff;font-size:1.28rem;cursor:pointer;transition:transform .14s ease,background .14s ease,border-color .14s ease}
.StoreNetworkClose:hover{transform:scale(1.06);border-color:#d0a36b;background:#3a3026}
.StoreNetworkBody{padding:clamp(16px,3vw,24px)}
.StoreNetworkView[hidden],.StoreAccountStep[hidden]{display:none}
.StoreNetworkGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:9px}
.StoreNetworkChoice{min-height:112px;padding:16px;border:1px solid rgba(255,255,255,.13);background:#171a19;color:#f4efe6;text-align:left;cursor:pointer;transition:transform .14s ease,border-color .14s ease,background .14s ease,box-shadow .14s ease}
.StoreNetworkChoice:hover{transform:translateY(-3px);border-color:#d0a36b;background:#29231d;box-shadow:0 10px 24px rgba(0,0,0,.28)}
.StoreNetworkChoice strong{display:block;font-size:.72rem;letter-spacing:.08em}
.StoreNetworkChoice span{display:block;margin-top:8px;color:rgba(244,239,230,.52);font-size:.62rem;line-height:1.45}
.StoreNetworkForm{display:grid;gap:12px}
.StoreNetworkLabel{display:grid;gap:7px;color:rgba(244,239,230,.64);font-size:.58rem;font-weight:900;letter-spacing:.11em}
.StoreNetworkInput,.StoreNetworkSelect{box-sizing:border-box;width:100%;min-height:46px;border:1px solid rgba(255,255,255,.20);background:#0e1110;color:#fff;padding:0 13px;font:750 .8rem Inter,system-ui,sans-serif;outline:none;border-radius:0}
.StoreNetworkInput:focus,.StoreNetworkSelect:focus{border-color:#c99358}
.StoreMaskedSecretInput{font-family:Arial,sans-serif;letter-spacing:.12em}
.StoreNetworkActions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:8px;margin-top:5px}
.StoreNetworkButton{display:inline-flex;align-items:center;justify-content:center;min-width:0;min-height:44px;padding:0 14px;border:1px solid rgba(255,255,255,.24);background:#252a27;color:#fff;font-size:.61rem;font-weight:900;letter-spacing:.10em;text-transform:uppercase;cursor:pointer;transition:transform .14s ease,background .14s ease,border-color .14s ease,box-shadow .14s ease,color .14s ease}
.StoreNetworkButton:hover{transform:translateY(-2px);border-color:rgba(217,168,117,.78);background:#343a36;box-shadow:0 8px 20px rgba(0,0,0,.24)}
.StoreNetworkButton.Primary:hover{border-color:#e1b27d;background:#cc8e52;color:#090704;box-shadow:0 8px 22px rgba(183,123,67,.22)}
.StoreNetworkButton.Danger:hover{border-color:#e48677;background:#3a201d;color:#ffd6cf}
.StoreNetworkButton:active{transform:translateY(0)}
.StoreNetworkButton:focus-visible{outline:2px solid #d0a36b;outline-offset:2px}
.StoreNetworkButton.Primary{border-color:#d09a60;background:#b77b43;color:#100c08}
.StoreNetworkButton.Danger{border-color:rgba(194,92,77,.58);color:#ffc5bc}
.StoreNetworkButton:disabled{opacity:.38;cursor:not-allowed}
.StoreNetworkStatus{min-height:18px;margin:12px 0 0;color:rgba(244,239,230,.55);font-size:.64rem;line-height:1.45}
.StoreNetworkStatus.Error{color:#ffafa4}
.StoreAccountModeTitle{margin:0 0 16px;color:#f4efe6;font-size:.8rem;font-weight:900;letter-spacing:.13em}
.StoreAccountLoginSwitch{width:100%;margin:3px 0 0;border:0;background:transparent;color:#c99358;font-size:.58rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;text-decoration:underline;text-underline-offset:4px;transition:color .14s ease,background .14s ease}
.StoreAccountLoginSwitch:hover{color:#fff;background:rgba(201,147,88,.16)}
.StoreAccountSectionTitle{margin-bottom:11px;color:#c99358;font-size:.61rem;font-weight:900;letter-spacing:.18em}
.StoreAccountChoices{display:grid;gap:8px}
.StoreAccountChoice{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:54px;width:100%;padding:0 15px;border:1px solid rgba(255,255,255,.15);background:#151817;color:#fff;text-align:left;cursor:pointer;transition:transform .14s ease,border-color .14s ease,background .14s ease,box-shadow .14s ease}
.StoreAccountChoice:hover{transform:translateX(3px);border-color:#d0a36b;background:#25201a;box-shadow:0 7px 18px rgba(0,0,0,.22)}
.StoreAccountChoice:focus-visible{outline:2px solid #d0a36b;outline-offset:2px}
.StoreAccountChoice strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.76rem;letter-spacing:.06em}
.StoreAccountChoice span{flex:0 0 auto;color:#c99358;font-size:.54rem;font-weight:900;letter-spacing:.10em}
.StoreAccountOther{width:100%;margin-top:9px}
.StoreAccountBack{margin-bottom:14px;min-height:36px;padding:0 10px;border:1px solid transparent;background:transparent;color:rgba(244,239,230,.58);font-size:.58rem;font-weight:900;letter-spacing:.10em;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease,transform .14s ease}
.StoreAccountBack:hover{transform:translateX(-2px);border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#fff}
.StoreSelectedAccount{margin-bottom:16px;padding:15px;border:1px solid rgba(255,255,255,.12);background:#121513}
.StoreSelectedAccount small{display:block;color:rgba(244,239,230,.43);font-size:.52rem;font-weight:900;letter-spacing:.13em}
.StoreSelectedAccount strong{display:block;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:1rem;letter-spacing:.07em}
.StoreNetworkSubtle{color:rgba(244,239,230,.45);font-size:.61rem;line-height:1.5}
.StoreToggleRow{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:48px;border:1px solid rgba(255,255,255,.11);padding:0 13px;background:#141715}
.StoreToggleRow span{font-size:.62rem;font-weight:850;letter-spacing:.07em}
.StoreToggleRow input{width:20px;height:20px;accent-color:#c99358}
.StoreLobbyTop{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:9px;margin-bottom:13px}
.StoreLobbyCode,.StoreLobbyInfo{padding:15px;border:1px solid rgba(255,255,255,.12);background:#131614}
.StoreLobbyCode small,.StoreLobbyInfo small,.StoreProfileStat small{display:block;color:rgba(255,255,255,.44);font-size:.51rem;font-weight:900;letter-spacing:.12em}
.StoreLobbyCode strong{display:block;margin:7px 0 10px;font:900 clamp(1.15rem,5vw,1.5rem) ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.18em}
.StoreLobbyInfo strong{display:block;margin-top:7px;font-size:.78rem;letter-spacing:.08em}
.StorePlayers{display:grid;gap:7px;margin:13px 0}
.StorePlayerRow{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;border:1px solid rgba(255,255,255,.09);background:#111412}
.StorePlayerName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.67rem;font-weight:850;letter-spacing:.05em}
.StoreHostBadge{margin-left:auto;padding:4px 7px;border:1px solid rgba(200,153,101,.55);color:#d9a875;font-size:.48rem;font-weight:900;letter-spacing:.10em}
.StoreLobbySettings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:11px}
.StoreLobbySetting{min-width:0;padding:10px;border:1px solid rgba(255,255,255,.09);background:#131614}
.StoreLobbySetting small{display:block;color:rgba(255,255,255,.40);font-size:.46rem;font-weight:900;letter-spacing:.09em}
.StoreLobbySetting strong{display:block;margin-top:5px;font-size:.61rem}
.StoreProfileName{font-size:clamp(1rem,4vw,1.25rem);font-weight:900;letter-spacing:.09em}
.StoreProfileStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:16px 0}
.StoreProfileStat{min-width:0;padding:13px;border:1px solid rgba(255,255,255,.10);background:#131614}
.StoreProfileStat strong{display:block;margin-top:7px;font-size:.86rem}
.StoreAccountBadge{display:inline-flex;align-items:center;gap:7px;margin-top:11px;padding:7px 9px;border:1px solid rgba(255,255,255,.11);background:rgba(10,12,11,.45);color:#d9d1c4;font-size:.55rem;font-weight:900;letter-spacing:.1em}
.StoreAccountBadge:before{content:"";width:6px;height:6px;border-radius:50%;background:#74bb7b}
.StoreOutdated{animation:StoreOutdatedPulse 1.1s ease-in-out infinite alternate}
@keyframes StoreOutdatedPulse{from{box-shadow:0 0 0 rgba(214,132,86,0)}to{box-shadow:0 0 42px rgba(214,132,86,.22)}}
.StoreNavButton{display:inline-flex;align-items:center;justify-content:center;min-height:47px;padding:0 18px;border:1px solid rgba(255,255,255,.8);background:rgba(255,255,255,.035);color:#fff;font-size:.7rem;font-weight:850;letter-spacing:.11em;text-transform:uppercase;cursor:pointer}
.StoreNavButton:hover{background:#fff;color:#0a0c0d}
.StoreAccountNavButton{display:inline-flex;align-items:center;justify-content:flex-start;gap:9px;min-width:0;max-width:220px;text-transform:none;letter-spacing:0}
.StoreAccountNavButton .StoreProfileChipIcon{display:grid;place-items:center;flex:0 0 27px;width:27px;height:27px;border:1px solid rgba(255,255,255,.26);background:rgba(8,10,9,.48);color:#d6a46e}
.StoreAccountNavButton .StoreProfileChipIcon svg{width:17px;height:17px;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;fill:none}
.StoreAccountNavButton .StoreProfileChipName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.68rem;font-weight:900;letter-spacing:.045em}
.StoreAccountNavButton:hover .StoreProfileChipIcon{border-color:rgba(10,12,13,.38);background:rgba(10,12,13,.08);color:#7f542d}
@media(max-width:520px){.StoreNetworkHead{padding:15px 16px}.StoreNetworkBody{padding:15px}.StoreLobbySettings,.StoreProfileStats{grid-template-columns:repeat(3,minmax(0,1fr))}.StoreNetworkButton{font-size:.56rem;padding:0 9px}}
@media(max-height:600px){.StoreNetworkCard{max-height:calc(100dvh - 12px)}.StoreNetworkHead{padding-top:12px;padding-bottom:12px}.StoreNetworkBody{padding-top:13px;padding-bottom:13px}.StoreNetworkChoice{min-height:92px}}
`;
document.head.appendChild(Style);

const AccountOverlay = document.createElement("section");
AccountOverlay.id = "StoreAccountOverlay";
AccountOverlay.className = "StoreNetworkOverlay";
AccountOverlay.innerHTML = `
  <div class="StoreNetworkCard StoreAccountCard">
    <div class="StoreNetworkHead">
      <div><h2 id="StoreAccountTitle">ACCOUNT</h2></div>
    </div>
    <div class="StoreNetworkBody">
      <div id="StoreAccountNormal">
        <section id="StoreAccountChooser" class="StoreAccountStep">
          <div class="StoreAccountSectionTitle">CONTINUE WITH</div>
          <div id="StoreAccountChoices" class="StoreAccountChoices"></div>
          <button id="StoreAccountOther" class="StoreNetworkButton StoreAccountOther" type="button">LOG IN TO A DIFFERENT ACCOUNT</button>
          <button id="StoreAccountCreateNew" class="StoreNetworkButton StoreAccountOther" type="button">CREATE A NEW ACCOUNT</button>
          <p id="StoreAccountChooserStatus" class="StoreNetworkStatus"></p>
        </section>
        <section id="StoreQuickAccount" class="StoreAccountStep" hidden>
          <button id="StoreQuickBack" class="StoreAccountBack" type="button">← BACK</button>
          <div class="StoreSelectedAccount"><small>CONTINUE WITH</small><strong id="StoreQuickAccountName">PLAYER</strong></div>
          <form id="StoreQuickAccountForm" class="StoreNetworkForm" autocomplete="off" data-form-type="other">
            <label class="StoreNetworkLabel">PASSWORD
              <input id="StoreQuickPassword" class="StoreNetworkInput StoreMaskedSecretInput" type="text" inputmode="text" maxlength="20" autocomplete="off" name="store-entry-a" autocapitalize="off" spellcheck="false" aria-autocomplete="none" data-form-type="other" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-protonpass-ignore="true">
            </label>
            <div class="StoreNetworkActions"><button id="StoreQuickSubmit" class="StoreNetworkButton Primary" type="submit">CONTINUE</button></div>
          </form>
          <p id="StoreQuickStatus" class="StoreNetworkStatus"></p>
        </section>
        <section id="StoreManualAccount" class="StoreAccountStep" hidden>
          <button id="StoreManualBack" class="StoreAccountBack" type="button">← BACK TO ACCOUNTS</button>
          <div id="StoreAccountModeTitle" class="StoreAccountModeTitle">LOGIN</div>
          <form id="StoreAccountForm" class="StoreNetworkForm" autocomplete="off" data-form-type="other">
            <label class="StoreNetworkLabel">USERNAME
              <input id="StoreAccountUsername" class="StoreNetworkInput" maxlength="20" autocomplete="one-time-code" name="infinity-store-account-name-v2" autocapitalize="off" spellcheck="false" aria-autocomplete="none" data-form-type="other" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-protonpass-ignore="true">
            </label>
            <label class="StoreNetworkLabel">PASSWORD
              <input id="StoreAccountPassword" class="StoreNetworkInput StoreMaskedSecretInput" type="text" inputmode="text" maxlength="20" autocomplete="off" name="store-entry-b" autocapitalize="off" spellcheck="false" aria-autocomplete="none" data-form-type="other" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-protonpass-ignore="true">
            </label>
            <label id="StoreAccountRepeatWrap" class="StoreNetworkLabel" hidden>RETYPE PASSWORD
              <input id="StoreAccountRepeat" class="StoreNetworkInput StoreMaskedSecretInput" type="text" inputmode="text" maxlength="20" autocomplete="off" name="store-entry-c" autocapitalize="off" spellcheck="false" aria-autocomplete="none" data-form-type="other" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-protonpass-ignore="true">
            </label>
            <div class="StoreNetworkActions">
              <button id="StoreAccountSubmit" class="StoreNetworkButton Primary" type="submit">LOGIN</button>
              <button id="StoreAccountRetry" class="StoreNetworkButton" type="button">RETRY SERVER</button>
            </div>
            <button id="StoreAccountLoginSwitch" class="StoreAccountLoginSwitch" type="button" hidden>ALREADY HAVE AN ACCOUNT? LOG IN</button>
          </form>
          <p id="StoreAccountStatus" class="StoreNetworkStatus"></p>
        </section>
      </div>
      <div id="StoreAccountOutdated" class="StoreOutdated" hidden>
        <div class="StoreProfileName">SESSION OUTDATED</div>
        <p class="StoreNetworkSubtle">This page is using a different multiplayer protocol than the server. Refresh before continuing.</p>
        <div class="StoreNetworkActions"><button id="StoreAccountRefresh" class="StoreNetworkButton Primary" type="button">REFRESH</button></div>
      </div>
    </div>
  </div>
`;
document.body.appendChild(AccountOverlay);

const NetworkOverlay = document.createElement("section");
NetworkOverlay.id = "StoreMultiplayerOverlay";
NetworkOverlay.className = "StoreNetworkOverlay";
NetworkOverlay.hidden = true;
NetworkOverlay.innerHTML = `
  <div class="StoreNetworkCard">
    <div class="StoreNetworkHead">
      <div><small id="StoreNetworkEyebrow">MULTIPLAYER</small><h2 id="StoreNetworkTitle">PLAY WITH OTHER PEOPLE</h2></div>
      <button id="StoreNetworkClose" class="StoreNetworkClose" type="button" aria-label="Close">×</button>
    </div>
    <div class="StoreNetworkBody">
      <section class="StoreNetworkView" data-network-view="menu">
        <div class="StoreNetworkGrid">
          <button class="StoreNetworkChoice" type="button" data-network-action="quick"><strong>RANDOM AVAILABLE SERVER</strong><span>Join an existing game that allows random players. This never creates a new room.</span></button>
          <button class="StoreNetworkChoice" type="button" data-network-action="join"><strong>JOIN WITH GAME CODE</strong><span>Enter a six-character code from a host.</span></button>
          <button class="StoreNetworkChoice" type="button" data-network-action="create"><strong>CREATE GAME</strong><span>Choose player count and joining rules, then host a lobby.</span></button>
        </div>
        <p id="StoreNetworkMenuStatus" class="StoreNetworkStatus"></p>
      </section>
      <section class="StoreNetworkView" data-network-view="join" hidden>
        <form id="StoreJoinForm" class="StoreNetworkForm">
          <label class="StoreNetworkLabel">GAME CODE
            <input id="StoreJoinCode" class="StoreNetworkInput" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ABC123">
          </label>
          <div class="StoreNetworkActions">
            <button class="StoreNetworkButton Primary" type="submit">JOIN GAME</button>
            <button class="StoreNetworkButton" type="button" data-network-back>BACK</button>
          </div>
        </form>
        <p id="StoreJoinStatus" class="StoreNetworkStatus"></p>
      </section>
      <section class="StoreNetworkView" data-network-view="create" hidden>
        <div class="StoreNetworkForm">
          <label class="StoreNetworkLabel">MAX PLAYERS
            <select id="StoreCreateMaxPlayers" class="StoreNetworkSelect">
              <option value="2">2 PLAYERS</option><option value="3">3 PLAYERS</option><option value="4" selected>4 PLAYERS</option><option value="5">5 PLAYERS</option><option value="6">6 PLAYERS</option>
            </select>
          </label>
          <label class="StoreToggleRow"><span>ALLOW LATE JOIN</span><input id="StoreCreateLateJoin" type="checkbox"></label>
          <label class="StoreToggleRow"><span>ALLOW RANDOM JOIN</span><input id="StoreCreateRandomJoin" type="checkbox" checked></label>
          <div class="StoreNetworkActions">
            <button id="StoreCreateSubmit" class="StoreNetworkButton Primary" type="button">CREATE GAME</button>
            <button class="StoreNetworkButton" type="button" data-network-back>BACK</button>
          </div>
        </div>
        <p id="StoreCreateStatus" class="StoreNetworkStatus"></p>
      </section>
      <section class="StoreNetworkView" data-network-view="lobby" hidden>
        <div class="StoreLobbyTop">
          <div class="StoreLobbyCode"><small>GAME CODE</small><strong id="StoreLobbyCode">------</strong><button id="StoreCopyCode" class="StoreNetworkButton" type="button">COPY CODE</button></div>
          <div class="StoreLobbyInfo"><small>PLAYERS</small><strong id="StoreLobbyCount">0 / 0</strong><div id="StoreLobbyState" class="StoreNetworkSubtle">WAITING IN LOBBY</div></div>
        </div>
        <div id="StoreLobbySettingsSummary" class="StoreLobbySettings">
          <div class="StoreLobbySetting"><small>MAX PLAYERS</small><strong id="StoreLobbyMaxSummary">4</strong></div>
          <div class="StoreLobbySetting"><small>LATE JOIN</small><strong id="StoreLobbyLateSummary">OFF</strong></div>
          <div class="StoreLobbySetting"><small>RANDOM JOIN</small><strong id="StoreLobbyRandomSummary">ON</strong></div>
        </div>
        <div id="StoreLobbyPlayers" class="StorePlayers"></div>
        <div id="StoreLobbyHostSettings" class="StoreNetworkForm" hidden>
          <label class="StoreNetworkLabel">MAX PLAYERS
            <select id="StoreLobbyMaxPlayers" class="StoreNetworkSelect">
              <option value="2">2 PLAYERS</option><option value="3">3 PLAYERS</option><option value="4">4 PLAYERS</option><option value="5">5 PLAYERS</option><option value="6">6 PLAYERS</option>
            </select>
          </label>
          <label class="StoreToggleRow"><span>ALLOW LATE JOIN</span><input id="StoreLobbyLateJoin" type="checkbox"></label>
          <label class="StoreToggleRow"><span>ALLOW RANDOM JOIN</span><input id="StoreLobbyRandomJoin" type="checkbox"></label>
          <button id="StoreLobbySaveSettings" class="StoreNetworkButton" type="button">UPDATE LOBBY SETTINGS</button>
        </div>
        <div class="StoreNetworkActions">
          <button id="StoreLobbyStart" class="StoreNetworkButton Primary" type="button">START GAME</button>
          <button id="StoreLobbyLeave" class="StoreNetworkButton Danger" type="button">LEAVE GAME</button>
        </div>
        <p id="StoreLobbyStatus" class="StoreNetworkStatus"></p>
      </section>
      <section class="StoreNetworkView" data-network-view="profile" hidden>
        <div id="StoreProfileName" class="StoreProfileName">PLAYER</div>
        <div id="StoreProfileConnection" class="StoreAccountBadge">ONLINE</div>
        <div class="StoreProfileStats">
          <div class="StoreProfileStat"><small>GAMES PLAYED</small><strong id="StoreProfileGames">0</strong></div>
          <div class="StoreProfileStat"><small>TASKS COMPLETED</small><strong id="StoreProfileTasks">0</strong></div>
          <div class="StoreProfileStat"><small>BEST AISLE</small><strong id="StoreProfileAisle">0</strong></div>
        </div>
        <p class="StoreNetworkSubtle">Game settings are attached to this account and saved on the server. Passwords are never saved in this browser.</p>
        <div class="StoreNetworkActions">
          <button id="StoreProfileSettings" class="StoreNetworkButton" type="button">SETTINGS</button>
          <button id="StoreProfileSwitch" class="StoreNetworkButton" type="button">SWITCH ACCOUNT</button>
          <button id="StoreProfileLogout" class="StoreNetworkButton Danger" type="button">LOG OUT</button>
        </div>
        <p id="StoreProfileStatus" class="StoreNetworkStatus"></p>
      </section>
    </div>
  </div>
`;
document.body.appendChild(NetworkOverlay);

const AccountNormal = document.getElementById("StoreAccountNormal");
const AccountOutdated = document.getElementById("StoreAccountOutdated");
const AccountChooser = document.getElementById("StoreAccountChooser");
const AccountChoices = document.getElementById("StoreAccountChoices");
const AccountChooserStatus = document.getElementById("StoreAccountChooserStatus");
const QuickAccount = document.getElementById("StoreQuickAccount");
const QuickAccountName = document.getElementById("StoreQuickAccountName");
const QuickPassword = document.getElementById("StoreQuickPassword");
const QuickSubmit = document.getElementById("StoreQuickSubmit");
const QuickStatus = document.getElementById("StoreQuickStatus");
const ManualAccount = document.getElementById("StoreManualAccount");
const AccountUsername = document.getElementById("StoreAccountUsername");
const AccountPassword = document.getElementById("StoreAccountPassword");
const AccountRepeatWrap = document.getElementById("StoreAccountRepeatWrap");
const AccountRepeat = document.getElementById("StoreAccountRepeat");
const AccountModeTitle = document.getElementById("StoreAccountModeTitle");
const AccountLoginSwitch = document.getElementById("StoreAccountLoginSwitch");
const AccountSubmit = document.getElementById("StoreAccountSubmit");
const AccountStatus = document.getElementById("StoreAccountStatus");
const MenuStatus = document.getElementById("StoreNetworkMenuStatus");
const JoinStatus = document.getElementById("StoreJoinStatus");
const JoinCode = document.getElementById("StoreJoinCode");
const CreateStatus = document.getElementById("StoreCreateStatus");
const CreateSubmit = document.getElementById("StoreCreateSubmit");
const LobbyStatus = document.getElementById("StoreLobbyStatus");
const LobbyPlayers = document.getElementById("StoreLobbyPlayers");
const LobbyHostSettings = document.getElementById("StoreLobbyHostSettings");
const LobbyStart = document.getElementById("StoreLobbyStart");
const ProfileStatus = document.getElementById("StoreProfileStatus");

let AccountMode = "login";
let SelectedAccountName = "";
let AccountChooserExcludedName = "";
let AccountFallbackMode = "create";
const MaskedSecrets = new WeakMap();

ConfigureMaskedSecret(QuickPassword);
ConfigureMaskedSecret(AccountPassword);
ConfigureMaskedSecret(AccountRepeat);

function SetMessage(Element, Message, Error = false) {
  if (!Element) return;
  Element.textContent = Message || "";
  Element.classList.toggle("Error", Boolean(Error));
}

function ReadMaskedSecret(Input) {
  return MaskedSecrets.get(Input) || "";
}

function SetMaskedSecret(Input, Value, Cursor = null) {
  const MaxLength = Number(Input?.maxLength) > 0 ? Number(Input.maxLength) : 20;
  const Secret = String(Value || "").slice(0, MaxLength);
  MaskedSecrets.set(Input, Secret);
  Input.value = "•".repeat(Secret.length);
  const Position = Cursor === null ? Secret.length : Math.max(0, Math.min(Number(Cursor) || 0, Secret.length));
  try { Input.setSelectionRange(Position, Position); } catch {}
}

function ReplaceMaskedSecret(Input, Text, Start, End) {
  const Current = ReadMaskedSecret(Input);
  const Insert = String(Text || "");
  const MaxLength = Number(Input?.maxLength) > 0 ? Number(Input.maxLength) : 20;
  const Left = Current.slice(0, Start);
  const Right = Current.slice(End);
  const Available = Math.max(0, MaxLength - Left.length - Right.length);
  const Added = Insert.slice(0, Available);
  const Next = Left + Added + Right;
  SetMaskedSecret(Input, Next, Left.length + Added.length);
}

function ConfigureMaskedSecret(Input) {
  if (!Input || Input.dataset.MaskedSecretReady) return;
  Input.dataset.MaskedSecretReady = "1";
  SetMaskedSecret(Input, "");

  Input.addEventListener("beforeinput", Event => {
    const Start = Input.selectionStart ?? ReadMaskedSecret(Input).length;
    const End = Input.selectionEnd ?? Start;
    const Type = String(Event.inputType || "");

    if (Type === "insertText" || Type === "insertCompositionText" || Type === "insertReplacementText") {
      Event.preventDefault();
      ReplaceMaskedSecret(Input, Event.data || "", Start, End);
      return;
    }

    if (Type === "deleteContentBackward") {
      Event.preventDefault();
      if (Start !== End) ReplaceMaskedSecret(Input, "", Start, End);
      else if (Start > 0) ReplaceMaskedSecret(Input, "", Start - 1, Start);
      return;
    }

    if (Type === "deleteContentForward") {
      Event.preventDefault();
      if (Start !== End) ReplaceMaskedSecret(Input, "", Start, End);
      else ReplaceMaskedSecret(Input, "", Start, Math.min(Start + 1, ReadMaskedSecret(Input).length));
      return;
    }

    if (Type.startsWith("delete")) {
      Event.preventDefault();
      ReplaceMaskedSecret(Input, "", Start, End);
    }
  });

  Input.addEventListener("paste", Event => {
    Event.preventDefault();
    const Text = Event.clipboardData?.getData("text") || "";
    const Start = Input.selectionStart ?? ReadMaskedSecret(Input).length;
    const End = Input.selectionEnd ?? Start;
    ReplaceMaskedSecret(Input, Text, Start, End);
  });

  Input.addEventListener("cut", Event => {
    Event.preventDefault();
    const Start = Input.selectionStart ?? 0;
    const End = Input.selectionEnd ?? Start;
    if (Start !== End) ReplaceMaskedSecret(Input, "", Start, End);
  });

  Input.addEventListener("copy", Event => Event.preventDefault());

  Input.addEventListener("input", () => {
    const Secret = ReadMaskedSecret(Input);
    if (Input.value !== "•".repeat(Secret.length)) SetMaskedSecret(Input, Secret);
  });
}

function SetAccountMode(Mode) {
  AccountMode = Mode === "create" ? "create" : "login";
  const Creating = AccountMode === "create";
  AccountRepeatWrap.hidden = !Creating;
  AccountModeTitle.textContent = Creating ? "CREATE ACCOUNT" : "LOG IN";
  AccountLoginSwitch.hidden = !Creating;
  SetMaskedSecret(AccountPassword, "");
  SetMaskedSecret(AccountRepeat, "");
  AccountSubmit.textContent = Creating ? "CREATE ACCOUNT" : "LOG IN";
  SetMessage(AccountStatus, "");
}

function ShowAccountStep(Name) {
  AccountChooser.hidden = Name !== "chooser";
  QuickAccount.hidden = Name !== "quick";
  ManualAccount.hidden = Name !== "manual";
}

function GetChooserAccounts() {
  const Excluded = String(AccountChooserExcludedName || "").toLowerCase();
  return ReadSavedAccounts().filter(Name => !Excluded || Name.toLowerCase() !== Excluded);
}

function RenderAccountChoices(Accounts = GetChooserAccounts()) {
  AccountChoices.replaceChildren();
  for (const Name of Accounts) {
    const Button = document.createElement("button");
    Button.type = "button";
    Button.className = "StoreAccountChoice";
    Button.dataset.accountName = Name;
    const Label = document.createElement("strong");
    Label.textContent = Name;
    const Continue = document.createElement("span");
    Continue.textContent = "CONTINUE";
    Button.append(Label, Continue);
    Button.addEventListener("click", () => {
      SelectedAccountName = Name;
      QuickAccountName.textContent = Name;
      SetMaskedSecret(QuickPassword, "");
      SetMessage(QuickStatus, "");
      ShowAccountStep("quick");
      requestAnimationFrame(() => QuickPassword.focus());
    });
    AccountChoices.appendChild(Button);
  }
}

function ShowManualAccount(Mode = "login", Message = "") {
  SelectedAccountName = "";
  SetAccountMode(Mode);
  AccountUsername.value = "";
  SetMaskedSecret(AccountPassword, "");
  SetMaskedSecret(AccountRepeat, "");
  document.getElementById("StoreManualBack").hidden = GetChooserAccounts().length === 0;
  SetMessage(AccountStatus, Message);
  ShowAccountStep("manual");
  requestAnimationFrame(() => AccountUsername.focus());
}

function ShowAccountChooser(Message = "") {
  const Accounts = GetChooserAccounts();
  if (!Accounts.length) {
    ShowManualAccount(AccountFallbackMode, Message);
    return;
  }
  RenderAccountChoices(Accounts);
  SelectedAccountName = "";
  SetMaskedSecret(QuickPassword, "");
  SetMaskedSecret(AccountPassword, "");
  SetMaskedSecret(AccountRepeat, "");
  ShowAccountStep("chooser");
  SetMessage(AccountChooserStatus, Message);
}

function ShowOutdated() {
  AccountOverlay.hidden = false;
  AccountNormal.hidden = true;
  AccountOutdated.hidden = false;
  SetStatus("outdated");
}

function ShowAccountScreen(Message = "", ExcludedName = "", FallbackMode = "create") {
  AccountChooserExcludedName = String(ExcludedName || "");
  AccountFallbackMode = FallbackMode === "login" ? "login" : "create";
  AccountOverlay.hidden = false;
  AccountNormal.hidden = false;
  AccountOutdated.hidden = true;
  ShowAccountChooser(Message);
}

function HideAccountScreen() {
  AccountOverlay.hidden = true;
}

function RenderNetworkStatus() {
  const ProfileConnection = document.getElementById("StoreProfileConnection");
  if (ProfileConnection) {
    ProfileConnection.textContent = Socket?.connected ? "ONLINE" : Status === "outdated" ? "SESSION OUTDATED" : "RECONNECTING";
  }
}

function RenderProfile() {
  document.getElementById("StoreProfileName").textContent = Account?.username || "PLAYER";
  document.getElementById("StoreProfileGames").textContent = String(Profile?.games_played ?? 0);
  document.getElementById("StoreProfileTasks").textContent = String(Profile?.tasks_completed ?? 0);
  document.getElementById("StoreProfileAisle").textContent = String(Profile?.best_aisle ?? 0);
  RenderNetworkStatus();
}

function ResetSharedRoomState() {
  SharedCompletedTasks.clear();
  PendingCompletedTasks.clear();
  Sequence = 0;
  LastSendAt = 0;
  HasLastSentPosition = false;
  LastAisleReport = 0;
  Game?.ResetTaskProgress?.();
}

function NormalizeRoomSeed(Value) {
  const NumberValue = Number(Value);
  if (!Number.isFinite(NumberValue)) return 0;
  return (Math.trunc(NumberValue) >>> 0) || 1;
}

async function SyncRoomSeed(Room = CurrentRoom) {
  const Seed = NormalizeRoomSeed(Room?.seed);
  if (!Seed) return { ok: false, error: "ROOM_SEED_REQUIRED" };

  window.__STORE_WORLD_SEED__ = Seed;
  window.__STORE_WORLD_SEED_SOURCE__ = "MULTIPLAYER_SERVER_ROOM";
  if (!GameAttached || !Game?.SetWorldSeed) return { ok: true, seed: Seed };
  if ((Number(Game.WorldSeed) >>> 0) === Seed) return { ok: true, seed: Seed };

  if (RoomSeedFlight) {
    await RoomSeedFlight.catch(() => {});
    if ((Number(Game.WorldSeed) >>> 0) === Seed) return { ok: true, seed: Seed };
  }

  RoomSeedFlight = Promise.resolve(Game.SetWorldSeed(Seed))
    .then(Result => ({ ok: Result !== false, seed: Seed }))
    .finally(() => {
      RoomSeedFlight = null;
    });
  return RoomSeedFlight;
}

function RestoreSinglePlayerSeed(Fresh = false) {
  if (Fresh || !Number.isFinite(SinglePlayerWorldSeed) || SinglePlayerWorldSeed <= 0) {
    SinglePlayerWorldSeed = GenerateWorldSeed();
  }

  window.__STORE_WORLD_SEED__ = SinglePlayerWorldSeed;
  window.__STORE_WORLD_SEED_SOURCE__ = "SOLO_RUNTIME";

  if (!GameAttached || !Game?.SetWorldSeed) return;
  if ((Number(Game.WorldSeed) >>> 0) === SinglePlayerWorldSeed) return;
  Promise.resolve(Game.SetWorldSeed(SinglePlayerWorldSeed)).catch(() => {});
}

function ClearRoomState() {
  const HadRoom = Boolean(CurrentRoom?.code || DesiredRoomCode);
  if (HadRoom) ResetSharedRoomState();
  else {
    SharedCompletedTasks.clear();
    PendingCompletedTasks.clear();
    Sequence = 0;
    LastSendAt = 0;
    HasLastSentPosition = false;
    LastAisleReport = 0;
  }
  CurrentRoom = null;
  CurrentRoomServerTime = 0;
  CurrentPlayers = [];
  SaveDesiredRoom("");
  RemoveAllRemotePlayers();
  RenderLobby();
  Dispatch("store-room-change", GetState());
  RestoreSinglePlayerSeed(HadRoom);
}

async function RefreshAccount() {
  if (!SessionToken) return { ok: false, error: "AUTH_REQUIRED" };
  const RequestedToken = SessionToken;
  const Result = await Api("/api/auth/me", { timeout: SERVER_WAKE_TIMEOUT_MS });
  if (SessionToken !== RequestedToken) return { ok: false, error: "SESSION_CHANGED" };
  if (!Result?.ok) {
    if (Result?.error === "AUTH_REQUIRED") {
      StoreSession("");
      Account = null;
      Profile = null;
      DisconnectSocket();
      ClearRoomState();
      Dispatch("store-account-change", GetState());
    }
    return Result;
  }
  Account = Result.account;
  Profile = Result.profile;
  ApplyProfileSettings();
  SaveAccountName(Account.username);
  Dispatch("store-account-change", GetState());
  RenderProfile();
  MountNavigation();
  return Result;
}

function FinishAuthentication() {
  if (!Account) return;
  AccountChooserExcludedName = "";
  ApplyProfileSettings();
  SaveAccountName(Account.username);
  HideAccountScreen();
  Dispatch("store-account-change", GetState());
  RenderProfile();
  MountNavigation();
  ConnectSocket().catch(() => {});
  if (!AccountGateResolved) {
    AccountGateResolved = true;
    ResolveAccountGate?.({ ok: true, account: Account, profile: Profile });
  }
}

async function Login(Username, Password) {
  const UsernameError = ValidateClientUsername(Username);
  const PasswordError = ValidateClientPassword(Password);
  if (UsernameError) return { ok: false, error: UsernameError };
  if (PasswordError) return { ok: false, error: PasswordError };

  SetStatus("authenticating");
  const Result = await Api("/api/auth/login", {
    method: "POST",
    auth: false,
    timeout: SERVER_WAKE_TIMEOUT_MS,
    body: { username: String(Username).trim(), password: String(Password) }
  });
  if (!Result?.ok) {
    SetStatus(Account ? "online" : "offline");
    return Result;
  }

  DisconnectSocket();
  StoreSession(Result.token);
  Account = Result.account;
  Profile = Result.profile || { games_played: 0, tasks_completed: 0, best_aisle: 0, settings: {} };
  ClearRoomState();
  ApplyProfileSettings();
  FinishAuthentication();
  return Result;
}

async function Register(Username, Password, RepeatPassword = Password) {
  const UsernameError = ValidateClientUsername(Username);
  const PasswordError = ValidateClientPassword(Password);
  if (UsernameError) return { ok: false, error: UsernameError };
  if (PasswordError) return { ok: false, error: PasswordError };
  if (Password !== RepeatPassword) return { ok: false, error: "PASSWORDS_DO_NOT_MATCH" };

  SetStatus("authenticating");
  const Result = await Api("/api/auth/register", {
    method: "POST",
    auth: false,
    timeout: SERVER_WAKE_TIMEOUT_MS,
    body: { username: String(Username).trim(), password: String(Password) }
  });
  if (!Result?.ok) {
    SetStatus(Account ? "online" : "offline");
    return Result;
  }

  DisconnectSocket();
  StoreSession(Result.token);
  Account = Result.account;
  Profile = Result.profile || { games_played: 0, tasks_completed: 0, best_aisle: 0, settings: {} };
  ClearRoomState();
  ApplyProfileSettings();
  FinishAuthentication();
  return Result;
}

async function RestoreSession() {
  if (!SessionToken) return { ok: false, error: "NO_SESSION" };
  SetStatus("waking");
  const Result = await RefreshAccount();
  if (!Result?.ok) {
    SetStatus("offline");
    return Result;
  }
  FinishAuthentication();
  return Result;
}

async function Logout(ShowAccount = true) {
  const LoggedOutUsername = Account?.username || "";
  clearTimeout(SessionRetryTimer);
  RestoreNotice.hidden = true;
  if (Socket?.connected && CurrentRoom) {
    await SocketAck("room:leave", {}).catch(() => {});
  }
  if (SessionToken) {
    await Api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  }
  DisconnectSocket();
  StoreSession("");
  ClearRoomState();
  Account = null;
  Profile = null;
  SetStatus("offline");
  Dispatch("store-account-change", GetState());
  NetworkOverlay.hidden = true;
  if (ShowAccount) ShowAccountScreen("Sign in to continue.", LoggedOutUsername, "login");
  return { ok: true };
}

async function SwitchAccount() {
  await Logout(true);
}

function DisconnectSocket() {
  ConnectFlight = null;
  if (!Socket) return;
  Socket.removeAllListeners();
  Socket.disconnect();
  Socket = null;
  SetStatus("offline");
}

function SocketAck(EventName, Payload = {}, Timeout = 10_000) {
  return new Promise(Resolve => {
    if (!Socket?.connected) {
      Resolve({ ok: false, error: "SOCKET_OFFLINE" });
      return;
    }
    Socket.timeout(Timeout).emit(EventName, Payload, (Error, Response) => {
      if (Error) Resolve({ ok: false, error: "SERVER_TIMEOUT" });
      else Resolve(Response || { ok: false, error: "EMPTY_RESPONSE" });
    });
  });
}

function BindSocketEvents(Target) {
  Target.on("connect", async () => {
    SetStatus("online");
    if (DesiredRoomCode) {
      const Result = await JoinRoom(DesiredRoomCode, false);
      if (!Result?.ok && ["ROOM_NOT_FOUND", "LATE_JOIN_DISABLED"].includes(Result?.error)) {
        ClearRoomState();
      }
    }
  });

  Target.on("disconnect", () => {
    if (Account) SetStatus("reconnecting");
  });

  Target.on("connect_error", Error => {
    const Message = String(Error?.message || "");
    if (/SESSION_OUTDATED/i.test(Message)) {
      Target.disconnect();
      ShowOutdated();
      return;
    }
    if (/RATE_LIMITED/i.test(Message)) {
      Target.disconnect();
      SetStatus("offline");
      return;
    }
    if (/AUTH_REQUIRED/i.test(Message)) {
      Target.disconnect();
      // Confirm rejection against the current token before clearing credentials.
      InitializeAccountGate().catch(() => {});
      return;
    }
    SetStatus("reconnecting");
  });

  Target.on("server:ready", Data => {
    if (Number(Data?.protocol) !== CLIENT_PROTOCOL) {
      Target.disconnect();
      ShowOutdated();
      return;
    }
    Dispatch("store-server-ready", Data || {});
  });

  Target.on("room:state", Payload => {
    if (!Payload?.room) return;
    ApplyRoomState(Payload.room, Payload.players || [], Payload.serverTime);
  });

  Target.on("room:host", Payload => {
    if (CurrentRoom && Payload?.hostUserId) {
      CurrentRoom.hostUserId = Payload.hostUserId;
      RenderLobby();
      Dispatch("store-room-change", GetState());
    }
  });

  Target.on("room:started", Payload => {
    if (!Payload?.room) return;
    ApplyRoomState(Payload.room, Payload.players || [], Payload.serverTime);
  });

  Target.on("player:joined", Data => {
    if (!Data?.id || Data.id === Target.id) return;
    EnsureRemotePlayer(Data);
  });

  Target.on("player:left", Data => {
    if (Data?.id) RemoveRemotePlayer(Data.id);
  });

  Target.on("movement:snapshot", Snapshot => {
    if (!Snapshot?.id || Snapshot.id === Target.id) return;
    PushRemoteSnapshot(Snapshot.id, Snapshot);
  });

  Target.on("movement:correction", Snapshot => {
    if (!Snapshot || !CurrentRoom?.started) return;
    if (Game?.Camera) {
      if (Number.isFinite(Number(Snapshot.x))) Game.Camera.position.x = Number(Snapshot.x);
      if (Number.isFinite(Number(Snapshot.z))) Game.Camera.position.z = Number(Snapshot.z);
    }
    Dispatch("store-movement-correction", Snapshot);
  });

  Target.on("task:completed", Payload => {
    if (Payload?.taskId) ApplyCompletedTask(Payload.taskId);
  });
}

async function ConnectSocket() {
  if (!SessionToken || !Account) return { ok: false, error: "AUTH_REQUIRED" };
  if (Socket?.connected) return { ok: true };
  if (ConnectFlight) return ConnectFlight;

  ConnectFlight = (async () => {
    if (!SocketIo) {
      try {
        const SocketModule = await import("https://cdn.socket.io/4.8.1/socket.io.esm.min.js");
        SocketIo = SocketModule.io;
      } catch {
        return { ok: false, error: "SERVER_UNREACHABLE" };
      }
    }

    if (!Socket) {
      SetStatus("connecting");
      Socket = SocketIo(SERVER_URL, {
        auth: { token: SessionToken, protocol: CLIENT_PROTOCOL },
        transports: ["websocket"],
        upgrade: false,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 600,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.35,
        timeout: 15_000
      });
      BindSocketEvents(Socket);
    }

    if (Socket.connected) return { ok: true };

    return new Promise(Resolve => {
      const Done = Result => {
        Socket?.off("connect", OnConnect);
        Socket?.off("connect_error", OnError);
        clearTimeout(Timer);
        Resolve(Result);
      };
      const OnConnect = () => Done({ ok: true });
      const OnError = Error => {
        const Message = String(Error?.message || "");
        if (/SESSION_OUTDATED/i.test(Message)) Done({ ok: false, error: "SESSION_OUTDATED" });
        else if (/AUTH_REQUIRED/i.test(Message)) Done({ ok: false, error: "AUTH_REQUIRED" });
        else if (/RATE_LIMITED/i.test(Message)) Done({ ok: false, error: "RATE_LIMITED" });
        else Done({ ok: false, error: "SOCKET_OFFLINE" });
      };
      const Timer = setTimeout(() => Done({ ok: Boolean(Socket?.connected), error: Socket?.connected ? undefined : "SERVER_TIMEOUT" }), 15_500);
      Socket.once("connect", OnConnect);
      Socket.once("connect_error", OnError);
      if (!Socket.active) Socket.connect();
    });
  })().finally(() => {
    ConnectFlight = null;
  });

  return ConnectFlight;
}

function ApplyRoomClock(Room = CurrentRoom, ReferenceServerTime = CurrentRoomServerTime) {
  if (!Room?.started || !Game?.SetStoreSeconds) return;
  const BaseSeconds = Number(Room.storeSeconds);
  if (!Number.isFinite(BaseSeconds)) return;
  const Reference = Number(ReferenceServerTime) || ServerNow();
  const TransitSeconds = Math.max(0, (ServerNow() - Reference) / 1000);
  Game.SetStoreSeconds((BaseSeconds + TransitSeconds * STORE_TIME_RATE) % DAY_SECONDS);
}

function ApplyRoomState(Room, Players, ServerTime = Date.now()) {
  const PreviousRoomCode = String(CurrentRoom?.code || "");
  const NextRoomCode = String(Room?.code || "");
  if (NextRoomCode && NextRoomCode !== PreviousRoomCode) ResetSharedRoomState();
  CurrentRoom = Room;
  CurrentRoomServerTime = Number(ServerTime) || Date.now();
  CurrentPlayers = Array.isArray(Players) ? Players : [];
  SaveDesiredRoom(NextRoomCode);
  SyncRoomSeed(Room).catch(Error => console.warn("Room seed sync failed", Error));
  if (Array.isArray(Room?.completedTasks)) ApplyCompletedTasks(Room.completedTasks);
  ApplyRoomClock(Room, CurrentRoomServerTime);
  ReconcileRemotePlayers(CurrentPlayers);
  RenderLobby();
  Dispatch("store-room-change", GetState());
  if (Room?.started) StartGameFromRoom().catch(() => {});
}

function ApplyJoinResult(Result) {
  if (!Result?.ok) return Result;
  ApplyRoomState(Result.room, Result.players || [], Result.serverTime);
  ShowNetworkView("lobby");
  return Result;
}

async function EnsureConnected() {
  if (!Socket?.connected) {
    const Connected = await ConnectSocket();
    if (!Connected?.ok) return Connected;
  }
  return { ok: true };
}

async function QuickJoin() {
  if (JoinFlight) return JoinFlight;
  JoinFlight = (async () => {
    const Connected = await EnsureConnected();
    if (!Connected?.ok) return Connected;
    return ApplyJoinResult(await SocketAck("room:quickJoin", {}));
  })().finally(() => {
    JoinFlight = null;
  });
  return JoinFlight;
}

async function CreateRoom(Settings = {}) {
  if (CreateRoomFlight) return CreateRoomFlight;
  CreateRoomFlight = (async () => {
    const Connected = await EnsureConnected();
    if (!Connected?.ok) return Connected;
    return ApplyJoinResult(await SocketAck("room:create", {
      maxPlayers: Number(Settings.maxPlayers),
      allowLateJoin: Boolean(Settings.allowLateJoin),
      allowRandomJoin: Boolean(Settings.allowRandomJoin)
    }));
  })().finally(() => {
    CreateRoomFlight = null;
  });
  return CreateRoomFlight;
}

async function JoinRoom(Code, Remember = true) {
  if (JoinFlight) return JoinFlight;
  JoinFlight = (async () => {
    const Connected = await EnsureConnected();
    if (!Connected?.ok) return Connected;
    const CleanCode = String(Code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const Result = ApplyJoinResult(await SocketAck("room:join", { code: CleanCode }));
    if (!Result?.ok && !Remember) return Result;
    return Result;
  })().finally(() => {
    JoinFlight = null;
  });
  return JoinFlight;
}

async function LeaveRoom() {
  const Result = Socket?.connected ? await SocketAck("room:leave", {}) : { ok: true };
  ClearRoomState();
  return Result;
}

async function UpdateRoomSettings(Settings) {
  const Connected = await EnsureConnected();
  if (!Connected?.ok) return Connected;
  const Result = await SocketAck("room:updateSettings", {
    maxPlayers: Number(Settings.maxPlayers),
    allowLateJoin: Boolean(Settings.allowLateJoin),
    allowRandomJoin: Boolean(Settings.allowRandomJoin)
  });
  if (Result?.ok && Result.room) {
    CurrentRoom = { ...CurrentRoom, ...Result.room };
    CurrentRoomServerTime = Number(Result.serverTime) || Date.now();
    ApplyRoomClock(CurrentRoom, CurrentRoomServerTime);
    RenderLobby();
  }
  return Result;
}

async function StartRoom() {
  const Connected = await EnsureConnected();
  if (!Connected?.ok) return Connected;
  const Result = await SocketAck("room:start", {});
  if (Result?.ok && Result.room) {
    CurrentRoom = { ...CurrentRoom, ...Result.room };
    CurrentRoomServerTime = Number(Result.serverTime) || Date.now();
    ApplyRoomClock(CurrentRoom, CurrentRoomServerTime);
    RenderLobby();
    StartGameFromRoom().catch(() => {});
  }
  return Result;
}

async function PingServer() {
  if (!Socket?.connected) return;
  const Sent = Date.now();
  const Result = await SocketAck("ping:client", Sent, 5000);
  const Received = Date.now();
  if (!Result?.serverTime) return;
  const Midpoint = (Sent + Received) * 0.5;
  const Sample = Number(Result.serverTime) - Midpoint;
  ServerClockOffset = ServerClockOffset * 0.75 + Sample * 0.25;
}

function ServerNow() {
  return Date.now() + ServerClockOffset;
}

function ShowNetworkView(Name) {
  for (const View of NetworkOverlay.querySelectorAll("[data-network-view]")) {
    View.hidden = View.dataset.networkView !== Name;
  }
  const Titles = {
    menu: ["MULTIPLAYER", "PLAY WITH OTHER PEOPLE"],
    join: ["MULTIPLAYER", "JOIN WITH GAME CODE"],
    create: ["MULTIPLAYER", "CREATE GAME"],
    lobby: ["MULTIPLAYER LOBBY", CurrentRoom?.started ? "GAME IN PROGRESS" : "WAITING TO START"],
    profile: ["PLAYER ACCOUNT", "PROFILE"]
  };
  const [Eyebrow, Title] = Titles[Name] || Titles.menu;
  document.getElementById("StoreNetworkEyebrow").textContent = Eyebrow;
  document.getElementById("StoreNetworkTitle").textContent = Title;
  if (Name === "lobby") RenderLobby();
  if (Name === "profile") RenderProfile();
}

function OpenMultiplayer() {
  if (!Account || !SessionToken) {
    ShowAccountScreen("Sign in to use multiplayer.", "", "login");
    return;
  }
  NetworkOverlay.hidden = false;
  SetMessage(MenuStatus, "");
  SetMessage(JoinStatus, "");
  SetMessage(CreateStatus, "");
  SetMessage(LobbyStatus, "");
  ShowNetworkView(CurrentRoom ? "lobby" : "menu");
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function OpenProfile() {
  if (!Account || !SessionToken) {
    ShowAccountScreen("Sign in to view your profile.", "", "login");
    return;
  }
  NetworkOverlay.hidden = false;
  SetMessage(ProfileStatus, "");
  ShowNetworkView("profile");
  RefreshAccount().catch(() => {});
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function CloseNetworkOverlay() {
  NetworkOverlay.hidden = true;
  if (!document.getElementById("Hud")?.classList.contains("Hidden")) {
    setTimeout(() => window.__STORE_POINTER_LOCK_RUNTIME__?.RequestFirstPersonLock?.(), 45);
  }
}

function IsHost() {
  return Boolean(Account?.id && CurrentRoom?.hostUserId === Account.id);
}

function RenderLobbyPlayers() {
  const Existing = new Map([...LobbyPlayers.querySelectorAll("[data-player-id]")].map(Row => [Row.dataset.playerId, Row]));
  const Seen = new Set();

  for (const Member of CurrentPlayers) {
    const Key = String(Member.userId || Member.id || "");
    if (!Key) continue;
    Seen.add(Key);
    let Row = Existing.get(Key);
    if (!Row) {
      Row = document.createElement("div");
      Row.className = "StorePlayerRow";
      Row.dataset.playerId = Key;
      const Name = document.createElement("span");
      Name.className = "StorePlayerName";
      Name.dataset.role = "name";
      const Badge = document.createElement("span");
      Badge.className = "StoreHostBadge";
      Badge.dataset.role = "host";
      Row.append(Name, Badge);
      LobbyPlayers.appendChild(Row);
    }
    Row.querySelector('[data-role="name"]').textContent = Member.name || "PLAYER";
    const Badge = Row.querySelector('[data-role="host"]');
    const Host = Member.userId === CurrentRoom?.hostUserId;
    Badge.hidden = !Host;
    Badge.textContent = "HOST";
  }

  for (const [Key, Row] of Existing) {
    if (!Seen.has(Key)) Row.remove();
  }
}

function RenderLobby() {
  const Room = CurrentRoom;
  const CodeElement = document.getElementById("StoreLobbyCode");
  const CountElement = document.getElementById("StoreLobbyCount");
  const StateElement = document.getElementById("StoreLobbyState");

  if (!Room) {
    CodeElement.textContent = "------";
    CountElement.textContent = "0 / 0";
    LobbyPlayers.replaceChildren();
    return;
  }

  CodeElement.textContent = Room.code || "------";
  CountElement.textContent = `${CurrentPlayers.length || Room.playerCount || 0} / ${Room.maxPlayers || 0}`;
  StateElement.textContent = Room.started ? "GAME IN PROGRESS" : "WAITING IN LOBBY";
  document.getElementById("StoreLobbyMaxSummary").textContent = String(Room.maxPlayers || 0);
  document.getElementById("StoreLobbyLateSummary").textContent = Room.allowLateJoin ? "ON" : "OFF";
  document.getElementById("StoreLobbyRandomSummary").textContent = Room.allowRandomJoin ? "ON" : "OFF";

  RenderLobbyPlayers();

  const Host = IsHost();
  LobbyHostSettings.hidden = !Host || Room.started;
  LobbyStart.hidden = !Host || Room.started;
  LobbyStart.disabled = (CurrentPlayers.length || Room.playerCount || 0) < (Room.minPlayers || 2);

  const MaxSelect = document.getElementById("StoreLobbyMaxPlayers");
  const LateToggle = document.getElementById("StoreLobbyLateJoin");
  const RandomToggle = document.getElementById("StoreLobbyRandomJoin");
  if (document.activeElement !== MaxSelect) MaxSelect.value = String(Room.maxPlayers || 4);
  if (document.activeElement !== LateToggle) LateToggle.checked = Boolean(Room.allowLateJoin);
  if (document.activeElement !== RandomToggle) RandomToggle.checked = Boolean(Room.allowRandomJoin);

  if (!Host && !Room.started) SetMessage(LobbyStatus, "Waiting for the host to start the game.");
  else if (Host && LobbyStart.disabled) SetMessage(LobbyStatus, "At least 2 players are required to start.");
  else if (Room.started) SetMessage(LobbyStatus, Room.allowLateJoin ? "Game started. Late joining is enabled." : "Game started.");
  else SetMessage(LobbyStatus, "Lobby ready.");
}

function StartGameFromRoom() {
  if (!CurrentRoom?.started || !CoreReady) return Promise.resolve();
  if (StartGameFlight) return StartGameFlight;

  StartGameFlight = (async () => {
    const SeedResult = await SyncRoomSeed(CurrentRoom);
    if (!SeedResult?.ok) return;

    if (window.__STORE_START_GATE__?.Ready !== true) {
      if (typeof window.__STORE_ENSURE_START_READY__ !== "function") return;
      const Ready = await window.__STORE_ENSURE_START_READY__();
      if (!Ready || window.__STORE_START_GATE__?.Ready !== true) return;
    }

    ApplyCompletedTasks(CurrentRoom?.completedTasks || []);
    const Finalizer = window.__STORE_PRESENTATION_READY_R83__?.FinalizeChunk;
    if (typeof Finalizer === "function") {
      const Chunks = [...Game.ActiveChunks.values()].filter(Chunk => Chunk?.Ready && !Chunk.Cancelled);
      await Promise.allSettled(Chunks.map(Chunk => Finalizer(Chunk)));
    }
    CloseNetworkOverlay();
    const Hud = document.getElementById("Hud");
    if (Hud && !Hud.classList.contains("Hidden")) return;
    const StartButton = document.getElementById("StartButton");
    if (!StartButton || StartButton.disabled) return;
    StartButton.click();
  })().finally(() => {
    StartGameFlight = null;
  });

  return StartGameFlight;
}

function CreateNavigationButton(Id, Text, Handler, ClassName = "StoreNavButton") {
  let Button = document.getElementById(Id);
  if (Button) return Button;
  Button = document.createElement("button");
  Button.id = Id;
  Button.type = "button";
  Button.className = ClassName;
  Button.textContent = Text;
  Button.addEventListener("click", Handler);
  return Button;
}

const ProfileChipIcon = `
  <span class="StoreProfileChipIcon" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.25"></circle>
      <path d="M5.5 19c.7-3.4 3-5.1 6.5-5.1s5.8 1.7 6.5 5.1"></path>
    </svg>
  </span>
`;

function CreateAccountNavigationButton(Id, ClassName) {
  let Button = document.getElementById(Id);
  if (Button) return Button;
  Button = document.createElement("button");
  Button.id = Id;
  Button.type = "button";
  Button.className = ClassName;
  Button.dataset.storeProfileChip = "1";
  Button.innerHTML = `${ProfileChipIcon}<span class="StoreProfileChipName"></span>`;
  Button.addEventListener("click", OpenProfile);
  return Button;
}

function UpdateAccountNavigation() {
  const Username = String(Account?.username || "PLAYER");
  for (const Button of document.querySelectorAll('[data-store-profile-chip="1"]')) {
    const Name = Button.querySelector(".StoreProfileChipName");
    if (Name && Name.textContent !== Username) Name.textContent = Username;
    const Label = `Open ${Username}'s profile`;
    if (Button.getAttribute("aria-label") !== Label) Button.setAttribute("aria-label", Label);
    if (Button.title !== Label) Button.title = Label;
  }
}

function MountInitialNavigation() {
  const Actions = document.getElementById("MainMenuActions");
  document.getElementById("StoreProfileMainButton")?.remove();

  if (Actions && !document.getElementById("StoreMultiplayerMainButton")) {
    const Button = CreateNavigationButton("StoreMultiplayerMainButton", "MULTIPLAYER", OpenMultiplayer, "MainMenuButton");
    const SettingsButton = document.getElementById("FirstMenuSettingsButton");
    Actions.insertBefore(Button, SettingsButton || null);
  }

  if (Actions && !document.getElementById("StoreAccountMainButton")) {
    const AccountButton = CreateAccountNavigationButton("StoreAccountMainButton", "MainMenuButton StoreAccountNavButton");
    const SettingsButton = document.getElementById("FirstMenuSettingsButton");
    Actions.insertBefore(AccountButton, SettingsButton || null);
  }

  const StartButton = document.getElementById("StartButton");
  if (StartButton && !StartButton.dataset.MultiplayerGuard) {
    StartButton.dataset.MultiplayerGuard = "1";
    StartButton.addEventListener("click", Event => {
      if (!CurrentRoom || CurrentRoom.started) return;
      Event.preventDefault();
      Event.stopImmediatePropagation();
      OpenMultiplayer();
      ShowNetworkView("lobby");
      SetMessage(LobbyStatus, IsHost() ? "Start the multiplayer game from the lobby." : "Waiting for the host to start the multiplayer game.");
    }, true);
  }
}

function MountRuntimeNavigation() {
  const Actions = document.querySelector("#RuntimeMainMenuR83 .RuntimeMenuActionsR84");
  if (!Actions) return;
  document.getElementById("StoreProfilePauseButton")?.remove();

  if (!document.getElementById("StoreMultiplayerPauseButton")) {
    Actions.appendChild(CreateNavigationButton("StoreMultiplayerPauseButton", "MULTIPLAYER", OpenMultiplayer));
  }
  if (!document.getElementById("StoreAccountPauseButton")) {
    Actions.appendChild(CreateAccountNavigationButton("StoreAccountPauseButton", "StoreNavButton StoreAccountNavButton"));
  }
}

function MountNavigation() {
  if (!CoreReady) return;
  MountInitialNavigation();
  MountRuntimeNavigation();
  UpdateAccountNavigation();
  if (!NavigationObserver) {
    NavigationObserver = new MutationObserver(() => {
      MountInitialNavigation();
      MountRuntimeNavigation();
      UpdateAccountNavigation();
    });
    NavigationObserver.observe(document.body, { childList: true, subtree: true });
  }
}

async function AttachGame() {
  if (GameAttached) return { ok: true };
  Game = window.__STORE_GAME__ || null;
  Player = window.__STORE_PLAYER__ || null;
  if (!Game?.Scene || !Game?.Camera || !Player) return { ok: false, error: "GAME_NOT_READY" };

  const ThreeModule = await import("three");
  const LoaderModule = await import("three/addons/loaders/GLTFLoader.js");
  const SkeletonModule = await import("three/addons/utils/SkeletonUtils.js");
  THREE = ThreeModule;
  GLTFLoader = LoaderModule.GLTFLoader;
  SkeletonUtils = SkeletonModule;
  Loader = new GLTFLoader();
  TempDirection = new THREE.Vector3();
  TempPosition = new THREE.Vector3();
  TempPositionB = new THREE.Vector3();
  LastSentPosition = new THREE.Vector3();
  GameAttached = true;
  if (CurrentRoom?.seed) await SyncRoomSeed(CurrentRoom);
  ApplyRoomClock();
  if (Array.isArray(CurrentRoom?.completedTasks)) ApplyCompletedTasks(CurrentRoom.completedTasks);
  StartRealtimeGameRuntime();
  ReconcileRemotePlayers(CurrentPlayers);
  return { ok: true };
}

function PickClip(Clips, Patterns) {
  for (const Pattern of Patterns) {
    const Match = Clips.find(Clip => Pattern.test(Clip.name));
    if (Match) return Match;
  }
  return null;
}

async function EnsureRemoteAsset() {
  if (RemoteAssetPromise) return RemoteAssetPromise;
  RemoteAssetPromise = Loader.loadAsync(PLAYER_MODEL_URL).then(Gltf => ({ scene: Gltf.scene, clips: Gltf.animations || [] }));
  return RemoteAssetPromise;
}

function CreateNameSprite(Name) {
  const Canvas = document.createElement("canvas");
  Canvas.width = 512;
  Canvas.height = 128;
  const Context = Canvas.getContext("2d");
  Context.clearRect(0, 0, Canvas.width, Canvas.height);
  Context.fillStyle = "rgba(9,11,10,.78)";
  Context.fillRect(22, 22, 468, 84);
  Context.strokeStyle = "rgba(238,228,207,.70)";
  Context.lineWidth = 4;
  Context.strokeRect(22, 22, 468, 84);
  Context.fillStyle = "#f0e7d4";
  Context.textAlign = "center";
  Context.textBaseline = "middle";
  Context.font = "900 42px Arial";
  Context.fillText(String(Name || "PLAYER").slice(0, 20), 256, 64);
  const Texture = new THREE.CanvasTexture(Canvas);
  Texture.colorSpace = THREE.SRGBColorSpace;
  const Material = new THREE.SpriteMaterial({ map: Texture, transparent: true, depthWrite: false });
  const Sprite = new THREE.Sprite(Material);
  Sprite.scale.set(2.15, 0.54, 1);
  Sprite.position.set(0, 2.12, 0);
  Sprite.name = "RemotePlayerName";
  return Sprite;
}

function PrepareRemoteModel(Source) {
  const Model = SkeletonUtils.clone(Source);
  Model.updateMatrixWorld(true);
  const RawBounds = new THREE.Box3().setFromObject(Model);
  const RawSize = RawBounds.getSize(new THREE.Vector3());
  const Scale = PLAYER_HEIGHT / Math.max(RawSize.y, 0.001);
  Model.scale.setScalar(Scale);
  Model.updateMatrixWorld(true);
  const Bounds = new THREE.Box3().setFromObject(Model);
  const Center = Bounds.getCenter(new THREE.Vector3());
  Model.position.x -= Center.x;
  Model.position.z -= Center.z;
  Model.updateMatrixWorld(true);
  const Grounded = new THREE.Box3().setFromObject(Model);
  Model.position.y -= Grounded.min.y;
  Model.traverse(Object => {
    if (!Object.isMesh) return;
    Object.castShadow = false;
    Object.receiveShadow = false;
    Object.frustumCulled = true;
  });
  return Model;
}

async function BuildRemoteAvatar(Record) {
  if (!GameAttached || Record.Building || Record.Pivot) return;
  Record.Building = true;
  try {
    const Asset = await EnsureRemoteAsset();
    if (!RemotePlayers.has(Record.id)) return;
    const Model = PrepareRemoteModel(Asset.scene);
    const Pivot = new THREE.Group();
    Pivot.name = `RemotePlayer-${Record.id}`;
    Pivot.userData.RemotePlayer = true;
    Pivot.userData.SocketId = Record.id;
    Pivot.add(Model);
    Pivot.add(CreateNameSprite(Record.name));
    Game.Scene.add(Pivot);

    Record.Pivot = Pivot;
    Record.Model = Model;
    Record.Mixer = new THREE.AnimationMixer(Model);
    Record.Actions = new Map();

    const Definitions = {
      idle: [/idle/i],
      walk: [/walk/i, /jog/i],
      sprint: [/run/i, /sprint/i]
    };

    for (const [Name, Patterns] of Object.entries(Definitions)) {
      const Clip = PickClip(Asset.clips, Patterns);
      if (!Clip) continue;
      const Action = Record.Mixer.clipAction(Clip);
      Action.enabled = true;
      Action.setLoop(THREE.LoopRepeat, Infinity);
      Record.Actions.set(Name, Action);
    }

    SetRemoteAnimation(Record, "idle");
    if (Record.Snapshots.length) ApplyRemoteTransform(Record, Record.Snapshots[Record.Snapshots.length - 1]);
  } catch (Error) {
    console.warn("Remote player model failed to load", Error);
  } finally {
    Record.Building = false;
  }
}

function EnsureRemotePlayer(Data) {
  if (!Data?.id || Data.id === Socket?.id) return null;
  let Record = RemotePlayers.get(Data.id);

  if (!Record) {
    Record = {
      id: Data.id,
      userId: Data.userId || "",
      name: Data.name || "PLAYER",
      Pivot: null,
      Model: null,
      Mixer: null,
      Actions: new Map(),
      ActiveAction: null,
      Animation: "",
      Snapshots: [],
      Building: false
    };
    RemotePlayers.set(Data.id, Record);
    if (GameAttached) BuildRemoteAvatar(Record);
  } else if (Data.name && Record.name !== Data.name) {
    Record.name = Data.name;
  }

  if (Data.movement) PushRemoteSnapshot(Data.id, { id: Data.id, userId: Data.userId, name: Data.name, ...Data.movement });
  Dispatch("store-network-change", GetState());
  return Record;
}

function RemoveRemotePlayer(Id) {
  const Record = RemotePlayers.get(Id);
  if (!Record) return;
  if (Record.Pivot?.parent) Record.Pivot.parent.remove(Record.Pivot);
  Record.Mixer?.stopAllAction?.();
  Record.Pivot?.traverse?.(Object => {
    if (Object.name !== "RemotePlayerName") return;
    Object.material?.map?.dispose?.();
    Object.material?.dispose?.();
  });
  RemotePlayers.delete(Id);
  Dispatch("store-network-change", GetState());
}

function RemoveAllRemotePlayers() {
  for (const Id of [...RemotePlayers.keys()]) RemoveRemotePlayer(Id);
}

function PushRemoteSnapshot(Id, Snapshot) {
  const Record = EnsureRemotePlayer({ id: Id, userId: Snapshot?.userId || "", name: Snapshot?.name || "PLAYER" });
  if (!Record || !Snapshot) return;

  const Clean = {
    x: Number(Snapshot.x) || 0,
    y: Number(Snapshot.y) || 1.68,
    z: Number(Snapshot.z) || 0,
    yaw: Number(Snapshot.yaw) || 0,
    pitch: Number(Snapshot.pitch) || 0,
    animation: ["idle", "walk", "sprint"].includes(Snapshot.animation) ? Snapshot.animation : "idle",
    sprinting: Boolean(Snapshot.sprinting),
    sequence: Number(Snapshot.sequence) || 0,
    serverTime: Number(Snapshot.serverTime) || ServerNow()
  };

  const Existing = Record.Snapshots[Record.Snapshots.length - 1];
  if (Existing && Clean.sequence && Clean.sequence <= Existing.sequence) return;
  Record.Snapshots.push(Clean);
  Record.Snapshots.sort((A, B) => A.serverTime - B.serverTime);
  while (Record.Snapshots.length > 28) Record.Snapshots.shift();
  const Cutoff = ServerNow() - MAX_SNAPSHOT_AGE_MS;
  while (Record.Snapshots.length > 2 && Record.Snapshots[1].serverTime < Cutoff) Record.Snapshots.shift();
}

function ReconcileRemotePlayers(Players) {
  if (!Array.isArray(Players)) return;
  const Seen = new Set();
  for (const Data of Players) {
    if (!Data?.id || Data.id === Socket?.id) continue;
    Seen.add(Data.id);
    EnsureRemotePlayer(Data);
  }
  for (const Id of [...RemotePlayers.keys()]) {
    if (!Seen.has(Id)) RemoveRemotePlayer(Id);
  }
}

function LerpAngle(From, To, Alpha) {
  const Difference = Math.atan2(Math.sin(To - From), Math.cos(To - From));
  return From + Difference * Alpha;
}

function SetRemoteAnimation(Record, Name) {
  if (!Record?.Mixer || Record.Animation === Name) return;
  Record.Animation = Name;
  const Next = Record.Actions.get(Name) || Record.Actions.get("idle");
  if (!Next) return;
  Next.reset().fadeIn(0.10).play();
  if (Record.ActiveAction && Record.ActiveAction !== Next) Record.ActiveAction.fadeOut(0.10);
  Record.ActiveAction = Next;
}

function ApplyRemoteTransform(Record, Snapshot) {
  if (!Record?.Pivot || !Snapshot) return;
  Record.Pivot.position.set(Snapshot.x, 0, Snapshot.z);
  Record.Pivot.rotation.y = Snapshot.yaw;
  SetRemoteAnimation(Record, Snapshot.animation);
}

function UpdateRemotePlayer(Record, Delta) {
  if (!Record.Pivot || !Record.Snapshots.length) return;
  Record.Mixer?.update?.(Delta);
  const TargetTime = ServerNow() - INTERPOLATION_DELAY_MS;
  const Snapshots = Record.Snapshots;

  while (Snapshots.length >= 3 && Snapshots[1].serverTime <= TargetTime) Snapshots.shift();
  const A = Snapshots[0];
  const B = Snapshots[1];

  if (!B) {
    ApplyRemoteTransform(Record, A);
    return;
  }

  const Span = Math.max(1, B.serverTime - A.serverTime);
  const Alpha = THREE.MathUtils.clamp((TargetTime - A.serverTime) / Span, 0, 1);
  TempPosition.set(A.x, 0, A.z);
  TempPositionB.set(B.x, 0, B.z);
  TempPosition.lerp(TempPositionB, Alpha);
  Record.Pivot.position.copy(TempPosition);
  Record.Pivot.rotation.y = LerpAngle(A.yaw, B.yaw, Alpha);
  SetRemoteAnimation(Record, Alpha < 0.5 ? A.animation : B.animation);
}

function LocalYaw() {
  const Pivot = Game.Scene.getObjectByName("PlayerCharacterPivot");
  if (Pivot) return Pivot.rotation.y;
  Game.Camera.getWorldDirection(TempDirection);
  TempDirection.y = 0;
  if (TempDirection.lengthSq() <= 0.000001) return 0;
  TempDirection.normalize();
  return Math.atan2(TempDirection.x, TempDirection.z);
}

function LocalPitch() {
  Game.Camera.getWorldDirection(TempDirection);
  return Math.asin(THREE.MathUtils.clamp(TempDirection.y, -1, 1));
}

function SendMovement(Now) {
  if (!GameAttached || !Socket?.connected || !CurrentRoom?.started || Now - LastSendAt < SEND_INTERVAL_MS) return;
  LastSendAt = Now;
  const Position = Game.Camera.position;
  let Moving = false;

  if (HasLastSentPosition) {
    const Distance = Math.hypot(Position.x - LastSentPosition.x, Position.z - LastSentPosition.z);
    Moving = Distance > 0.008;
  }

  LastSentPosition.copy(Position);
  HasLastSentPosition = true;
  const Sprinting = Boolean(Player.IsSprinting?.());
  Sequence += 1;

  Socket.volatile.emit("movement:update", {
    x: Position.x,
    y: Position.y,
    z: Position.z,
    yaw: LocalYaw(),
    pitch: LocalPitch(),
    animation: Moving ? (Sprinting ? "sprint" : "walk") : "idle",
    sprinting: Sprinting,
    sequence: Sequence
  });
}

function ApplyCompletedTask(TaskId) {
  const Id = String(TaskId || "");
  if (!Id) return;
  SharedCompletedTasks.add(Id);
  Game?.SetCompletedTaskCount?.(SharedCompletedTasks.size);

  const Task = Game?.Tasks?.get?.(Id);
  if (!Task) {
    PendingCompletedTasks.add(Id);
    return;
  }

  if (typeof Game?.CompleteSharedTask === "function") {
    Game.CompleteSharedTask(Id, SharedCompletedTasks.size);
  } else if (!Task.Completed) {
    Task.Completed = true;
    if (Task.Screen?.material) {
      Task.Screen.material = Task.Screen.material.clone();
      Task.Screen.material.color?.setHex?.(0x23522c);
      Task.Screen.material.emissive?.setHex?.(0x36d45b);
      Task.Screen.material.emissiveIntensity = 1.9;
    }
    const Chunk = Game.ActiveChunks?.get?.(Task.ChunkIndex);
    if (Task.Type === "breaker" && Chunk) {
      for (const Light of Chunk.Lights || []) {
        Light.userData.BaseIntensity = Math.max(Light.userData.BaseIntensity || 0, 2.0);
      }
    }
  }

  PendingCompletedTasks.delete(Id);
}

function ApplyCompletedTasks(Ids) {
  for (const Id of Ids || []) ApplyCompletedTask(Id);
}

function DetectLocalTaskCompletions() {
  if (!GameAttached || !Socket?.connected || !CurrentRoom?.started || !Game.Tasks) return;
  for (const Task of Game.Tasks.values()) {
    if (!Task?.Completed || SharedCompletedTasks.has(Task.Id)) continue;
    SharedCompletedTasks.add(Task.Id);
    Game?.SetCompletedTaskCount?.(SharedCompletedTasks.size);
    Socket.timeout(6000).emit("task:complete", { taskId: Task.Id }, (Error, Response) => {
      if (Error || !Response?.ok) {
        SharedCompletedTasks.delete(Task.Id);
        Game?.SetCompletedTaskCount?.(SharedCompletedTasks.size);
      }
    });
  }
  for (const Id of [...PendingCompletedTasks]) ApplyCompletedTask(Id);
}

function ReportAisleProgress() {
  if (!GameAttached || !Socket?.connected || !CurrentRoom?.started || !Game.ChunkIndexForZ) return;
  const Aisle = Math.max(0, Game.ChunkIndexForZ(Game.Camera.position.z) + 1);
  if (Aisle <= LastAisleReport) return;
  LastAisleReport = Aisle;
  Socket.emit("profile:aisle", { aisle: Aisle });
}

function RealtimeFrame() {
  const Now = performance.now();
  const Delta = Math.min((Now - LastFrameAt) / 1000, 0.05);
  LastFrameAt = Now;
  SendMovement(Now);
  for (const Record of RemotePlayers.values()) UpdateRemotePlayer(Record, Delta);
  requestAnimationFrame(RealtimeFrame);
}

function StartRealtimeGameRuntime() {
  if (GameRuntimeStarted) return;
  GameRuntimeStarted = true;
  requestAnimationFrame(RealtimeFrame);
}

async function SyncSettings(Settings) {
  if (!Socket?.connected || !Account || !Settings || typeof Settings !== "object") return;
  const Result = await SocketAck("profile:updateSettings", { settings: Settings }, 7000);
  if (Result?.ok) {
    Profile = { ...(Profile || {}), settings: Result.settings || Settings };
    Dispatch("store-account-change", GetState());
  }
}

function NotifyCoreReady() {
  CoreReady = true;
  MountNavigation();
  if (CurrentRoom?.started) StartGameFromRoom().catch(() => {});
}

async function WaitForAccount() {
  return AccountGate;
}

let SessionRestoreFlight = null;
let SessionRetryTimer = null;
const RestoreNotice = document.createElement("div");
RestoreNotice.className = "StoreNetworkOverlay";
RestoreNotice.hidden = true;
RestoreNotice.innerHTML = '<div class="StoreNetworkCard"><h2>Restoring your session</h2><p>Reconnecting to the store. You are still remembered; no password needed.</p></div>';
document.body.appendChild(RestoreNotice);

async function InitializeAccountGate() {
  if (SessionRestoreFlight) return SessionRestoreFlight;
  if (!SessionToken) {
    RestoreNotice.hidden = true;
    const Remembered = ReadSavedAccounts().length > 0;
    ShowAccountScreen(Remembered ? "Choose an account to continue." : "Create an account to continue.", "", Remembered ? "login" : "create");
    return;
  }
  clearTimeout(SessionRetryTimer);
  HideAccountScreen();
  RestoreNotice.hidden = AccountGateResolved;
  SessionRestoreFlight = (async () => {
    const Result = await RestoreSession();
    if (Result?.ok || Result?.error === "SESSION_CHANGED") {
      RestoreNotice.hidden = true;
      return;
    }
    if (Result?.error === "SESSION_OUTDATED") {
      RestoreNotice.hidden = true;
      return;
    }
    if (Result?.error === "AUTH_REQUIRED") {
      RestoreNotice.hidden = true;
      ShowAccountScreen("This saved session is no longer valid. Sign in to reconnect.", "", "login");
      return;
    }
    SetStatus("reconnecting");
    SessionRetryTimer = setTimeout(InitializeAccountGate, 5000);
  })().catch(() => {
    SetStatus("reconnecting");
    if (SessionToken) SessionRetryTimer = setTimeout(InitializeAccountGate, 5000);
  }).finally(() => { SessionRestoreFlight = null; });
  return SessionRestoreFlight;
}

addEventListener("online", () => { if (SessionToken) InitializeAccountGate(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && SessionToken) InitializeAccountGate();
});
setInterval(() => {
  if (!document.hidden && SessionToken && Account) InitializeAccountGate();
}, 5 * 60 * 1000);

AccountLoginSwitch.addEventListener("click", () => ShowManualAccount("login"));
document.getElementById("StoreAccountOther").addEventListener("click", () => ShowManualAccount("login"));
document.getElementById("StoreAccountCreateNew").addEventListener("click", () => ShowManualAccount("create"));
document.getElementById("StoreManualBack").addEventListener("click", () => ShowAccountChooser());
document.getElementById("StoreQuickBack").addEventListener("click", () => ShowAccountChooser());

document.getElementById("StoreQuickAccountForm").addEventListener("submit", async Event => {
  Event.preventDefault();
  if (!SelectedAccountName) {
    ShowAccountChooser();
    return;
  }
  QuickSubmit.disabled = true;
  SetMessage(QuickStatus, "Signing in...");
  const Result = await Login(SelectedAccountName, ReadMaskedSecret(QuickPassword));
  QuickSubmit.disabled = false;
  if (!Result?.ok) SetMessage(QuickStatus, ErrorText(Result?.error), true);
  else SetMaskedSecret(QuickPassword, "");
});

document.getElementById("StoreAccountForm").addEventListener("submit", async Event => {
  Event.preventDefault();
  AccountSubmit.disabled = true;
  SetMessage(AccountStatus, AccountMode === "create" ? "Creating account..." : "Signing in...");
  const Result = AccountMode === "create"
    ? await Register(AccountUsername.value, ReadMaskedSecret(AccountPassword), ReadMaskedSecret(AccountRepeat))
    : await Login(AccountUsername.value, ReadMaskedSecret(AccountPassword));
  AccountSubmit.disabled = false;
  if (!Result?.ok) SetMessage(AccountStatus, ErrorText(Result?.error), true);
  else {
    SetMaskedSecret(AccountPassword, "");
    SetMaskedSecret(AccountRepeat, "");
  }
});

document.getElementById("StoreAccountRetry").addEventListener("click", async () => {
  SetMessage(AccountStatus, "Checking server...");
  const Result = await CheckCompatibility(true);
  if (!Result?.ok) {
    SetMessage(AccountStatus, ErrorText(Result?.error), true);
    return;
  }
  SetMessage(AccountStatus, "Server is online. You can sign in.");
});

document.getElementById("StoreAccountRefresh").addEventListener("click", () => location.reload());

document.getElementById("StoreNetworkClose").addEventListener("click", CloseNetworkOverlay);

NetworkOverlay.querySelector('[data-network-action="quick"]').addEventListener("click", async () => {
  SetMessage(MenuStatus, "Finding an available game...");
  const Result = await QuickJoin();
  if (!Result?.ok) SetMessage(MenuStatus, ErrorText(Result?.error), true);
});

NetworkOverlay.querySelector('[data-network-action="join"]').addEventListener("click", () => {
  ShowNetworkView("join");
  JoinCode.focus();
});

NetworkOverlay.querySelector('[data-network-action="create"]').addEventListener("click", () => {
  ShowNetworkView("create");
});

NetworkOverlay.querySelectorAll("[data-network-back]").forEach(Button => {
  Button.addEventListener("click", () => ShowNetworkView("menu"));
});

JoinCode.addEventListener("input", () => {
  const Start = JoinCode.selectionStart;
  JoinCode.value = JoinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (Start !== null) JoinCode.setSelectionRange(Math.min(Start, JoinCode.value.length), Math.min(Start, JoinCode.value.length));
});

document.getElementById("StoreJoinForm").addEventListener("submit", async Event => {
  Event.preventDefault();
  const Code = JoinCode.value.trim().toUpperCase();
  if (Code.length !== 6) {
    SetMessage(JoinStatus, ErrorText("ROOM_CODE_REQUIRED"), true);
    return;
  }
  SetMessage(JoinStatus, "Joining game...");
  const Result = await JoinRoom(Code);
  if (!Result?.ok) SetMessage(JoinStatus, ErrorText(Result?.error), true);
});

CreateSubmit.addEventListener("click", async () => {
  CreateSubmit.disabled = true;
  SetMessage(CreateStatus, "Creating lobby...");
  const Result = await CreateRoom({
    maxPlayers: Number(document.getElementById("StoreCreateMaxPlayers").value),
    allowLateJoin: document.getElementById("StoreCreateLateJoin").checked,
    allowRandomJoin: document.getElementById("StoreCreateRandomJoin").checked
  });
  CreateSubmit.disabled = false;
  if (!Result?.ok) SetMessage(CreateStatus, ErrorText(Result?.error), true);
});

document.getElementById("StoreCopyCode").addEventListener("click", async () => {
  if (!CurrentRoom?.code) return;
  try {
    await navigator.clipboard.writeText(CurrentRoom.code);
    SetMessage(LobbyStatus, "Game code copied.");
  } catch {
    SetMessage(LobbyStatus, `Game code: ${CurrentRoom.code}`);
  }
});

document.getElementById("StoreLobbySaveSettings").addEventListener("click", async () => {
  SetMessage(LobbyStatus, "Updating lobby...");
  const Result = await UpdateRoomSettings({
    maxPlayers: Number(document.getElementById("StoreLobbyMaxPlayers").value),
    allowLateJoin: document.getElementById("StoreLobbyLateJoin").checked,
    allowRandomJoin: document.getElementById("StoreLobbyRandomJoin").checked
  });
  if (!Result?.ok) SetMessage(LobbyStatus, ErrorText(Result?.error), true);
  else SetMessage(LobbyStatus, "Lobby settings updated.");
});

LobbyStart.addEventListener("click", async () => {
  LobbyStart.disabled = true;
  SetMessage(LobbyStatus, "Starting game...");
  const Result = await StartRoom();
  if (!Result?.ok) {
    SetMessage(LobbyStatus, ErrorText(Result?.error), true);
    RenderLobby();
  }
});

document.getElementById("StoreLobbyLeave").addEventListener("click", async () => {
  await LeaveRoom();
  ShowNetworkView("menu");
  SetMessage(MenuStatus, "Left the multiplayer game.");
});

document.getElementById("StoreProfileSettings").addEventListener("click", () => {
  const SettingsOverlay = document.getElementById("SettingsOverlayR43");
  if (!SettingsOverlay) {
    SetMessage(ProfileStatus, "Settings are still loading.", true);
    return;
  }
  NetworkOverlay.hidden = true;
  SettingsOverlay.classList.add("Open");
  SettingsOverlay.setAttribute("aria-hidden", "false");
});
document.getElementById("StoreProfileSwitch").addEventListener("click", SwitchAccount);
document.getElementById("StoreProfileLogout").addEventListener("click", () => Logout(true));

addEventListener("store-account-change", UpdateAccountNavigation);

addEventListener("store-settings-change", Event => {
  const Settings = Event.detail || window.__STORE_USER_SETTINGS__;
  SyncSettings(Settings).catch(() => {});
});

setInterval(() => PingServer().catch(() => {}), 5000);
setInterval(DetectLocalTaskCompletions, 220);
setInterval(ReportAisleProgress, 1500);

window.__STORE_MULTIPLAYER__ = {
  ServerUrl: SERVER_URL,
  Protocol: CLIENT_PROTOCOL,
  WaitForAccount,
  AttachGame,
  NotifyCoreReady,
  Register,
  Login,
  Logout,
  SwitchAccount,
  RestoreSession,
  RefreshAccount,
  ConnectSocket,
  QuickJoin,
  CreateRoom,
  JoinRoom,
  LeaveRoom,
  UpdateRoomSettings,
  StartRoom,
  OpenMultiplayer,
  OpenProfile,
  GetState,
  GetSocket: () => Socket
};
window.__STORE_MULTIPLAYER_BUILD__ = "V0.35.41-START-AUTHORITY";

InitializeAccountGate().catch(Error => {
  SetStatus("offline");
  ShowAccountScreen(ErrorText(Error?.message || "SERVER_UNREACHABLE"));
});