import * as THREE from "three";

const StorageKey = "InfiniteFurnitureStoreSettingsV3";
const Defaults = {
  Sensitivity: 0.92,
  TrackpadSmoothing: 58,
  Fov: 70,
  Graphics: "balanced",
  AmbientVolume: 0.22,
  ShowFps: true
};

function Clamp(Value, Min, Max) {
  return Math.min(Max, Math.max(Min, Number(Value) || 0));
}

function LoadSettings() {
  let Saved = {};
  try { Saved = JSON.parse(localStorage.getItem(StorageKey) || "{}") || {}; } catch {}
  return {
    Sensitivity: Clamp(Saved.Sensitivity ?? Defaults.Sensitivity, 0.35, 2),
    TrackpadSmoothing: Clamp(Saved.TrackpadSmoothing ?? Defaults.TrackpadSmoothing, 0, 100),
    Fov: Clamp(Saved.Fov ?? Defaults.Fov, 58, 100),
    Graphics: ["performance", "balanced", "high"].includes(Saved.Graphics) ? Saved.Graphics : Defaults.Graphics,
    AmbientVolume: Clamp(Saved.AmbientVolume ?? Defaults.AmbientVolume, 0, 1),
    ShowFps: Saved.ShowFps === undefined ? Defaults.ShowFps : Boolean(Saved.ShowFps)
  };
}

const Settings = LoadSettings();
window.__STORE_USER_SETTINGS__ = Settings;

function SaveSettings() {
  try { localStorage.setItem(StorageKey, JSON.stringify(Settings)); } catch {}
  dispatchEvent(new CustomEvent("store-settings-change", { detail: { ...Settings } }));
}

function Game() {
  return window.__STORE_GAME__ || null;
}

function QualityProfile() {
  if (Settings.Graphics === "performance") return { PixelRatio: 0.88, PointLights: 2, Anisotropy: 1 };
  if (Settings.Graphics === "high") return { PixelRatio: 1.10, PointLights: 4, Anisotropy: 4 };
  return { PixelRatio: 0.96, PointLights: 3, Anisotropy: 2 };
}

const PerfState = {
  Width: 0,
  Height: 0,
  Ratio: -1,
  Quality: "",
  TextureStamp: ""
};

function ApplyCamera() {
  const CurrentGame = Game();
  if (!CurrentGame?.Camera) return;
  const Fov = Clamp(Settings.Fov, 58, 100);
  if (Math.abs(CurrentGame.Camera.fov - Fov) < 0.001) return;
  CurrentGame.Camera.fov = Fov;
  CurrentGame.Camera.updateProjectionMatrix();
}

function ApplySafeViewport(Renderer) {
  const Ratio = Math.max(0.01, Renderer.getPixelRatio?.() || 1);
  const BufferWidth = Math.max(1, Number(Renderer.domElement?.width) || 1);
  const BufferHeight = Math.max(1, Number(Renderer.domElement?.height) || 1);
  const SafeWidth = Math.max(1, (BufferWidth - 1) / Ratio);
  const SafeHeight = Math.max(1, (BufferHeight - 1) / Ratio);

  Renderer.setScissorTest(false);
  Renderer.setViewport(0, 0, SafeWidth, SafeHeight);
}

function ApplyRenderer() {
  const CurrentGame = Game();
  if (!CurrentGame?.Renderer) return;
  const Profile = QualityProfile();
  const Ratio = Math.min(devicePixelRatio || 1, Profile.PixelRatio);
  if (
    PerfState.Width === innerWidth &&
    PerfState.Height === innerHeight &&
    Math.abs(PerfState.Ratio - Ratio) < 0.001 &&
    PerfState.Quality === Settings.Graphics
  ) {
    ApplySafeViewport(CurrentGame.Renderer);
    return;
  }

  PerfState.Width = innerWidth;
  PerfState.Height = innerHeight;
  PerfState.Ratio = Ratio;
  PerfState.Quality = Settings.Graphics;

  CurrentGame.Renderer.setPixelRatio(Ratio);
  CurrentGame.Renderer.setSize(innerWidth, innerHeight, false);
  ApplySafeViewport(CurrentGame.Renderer);
}

function ApplyTextureBudgetToRoot(Root) {
  const CurrentGame = Game();
  if (!Root?.traverse || !CurrentGame?.Renderer) return;

  const Max = Math.min(
    QualityProfile().Anisotropy,
    CurrentGame.Renderer.capabilities.getMaxAnisotropy()
  );

  Root.traverse(Object => {
    if (!Object.isMesh) return;
    const Materials = Array.isArray(Object.material)
      ? Object.material
      : [Object.material];

    for (const Material of Materials) {
      if (!Material) continue;
      for (const Key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"]) {
        const Texture = Material[Key];
        if (!Texture?.isTexture || Texture.anisotropy === Max) continue;
        Texture.anisotropy = Max;
        Texture.needsUpdate = true;
      }
    }
  });
}

function ApplyTextureBudgetToChunk(Chunk) {
  if (!Chunk || Chunk.Cancelled) return;
  ApplyTextureBudgetToRoot(Chunk.Group);
  for (const Object of Chunk.ExternalObjects || []) {
    ApplyTextureBudgetToRoot(Object);
  }
}

function ApplyTextureBudget() {
  const CurrentGame = Game();
  if (!CurrentGame?.Scene || !CurrentGame?.Renderer) return;
  const Stamp = Settings.Graphics;
  if (Stamp === PerfState.TextureStamp) return;
  PerfState.TextureStamp = Stamp;
  ApplyTextureBudgetToRoot(CurrentGame.Scene);
}

function CullPointLights() {
  const CurrentGame = Game();
  if (!CurrentGame?.Scene || !CurrentGame?.Camera) return;

  const Lights = [];
  const Seen = new Set();

  for (const Chunk of CurrentGame.ActiveChunks?.values?.() || []) {
    for (const Object of Chunk?.Lights || []) {
      if (!Object?.isPointLight || Seen.has(Object)) continue;
      Seen.add(Object);
      const Position = Object.userData.R43LightWorld ||= new THREE.Vector3();
      Object.getWorldPosition(Position);
      Lights.push({
        Object,
        Distance: Position.distanceToSquared(CurrentGame.Camera.position)
      });
    }
  }

  for (const Object of CurrentGame.Scene.children || []) {
    if (!Object?.isPointLight || Seen.has(Object)) continue;
    Seen.add(Object);
    const Position = Object.userData.R43LightWorld ||= new THREE.Vector3();
    Object.getWorldPosition(Position);
    Lights.push({
      Object,
      Distance: Position.distanceToSquared(CurrentGame.Camera.position)
    });
  }

  Lights.sort((A, B) => A.Distance - B.Distance);
  const Limit = QualityProfile().PointLights;
  for (let Index = 0; Index < Lights.length; Index += 1) {
    Lights[Index].Object.visible = Index < Limit;
  }
}

function ApplyPerformance() {
  ApplyCamera();
  ApplyRenderer();
  ApplyTextureBudget();
  CullPointLights();
}

let Ambient = null;
function StartAmbient() {
  if (Ambient) return;
  const AudioClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioClass) return;
  const Context = new AudioClass();
  const Master = Context.createGain();
  Master.gain.value = 0.016 * Settings.AmbientVolume;
  Master.connect(Context.destination);
  const Filter = Context.createBiquadFilter();
  Filter.type = "lowpass";
  Filter.frequency.value = 245;
  Filter.Q.value = 0.55;
  Filter.connect(Master);
  const A = Context.createOscillator();
  const AGain = Context.createGain();
  A.type = "sine";
  A.frequency.value = 57.5;
  AGain.gain.value = 0.76;
  A.connect(AGain).connect(Filter);
  const B = Context.createOscillator();
  const BGain = Context.createGain();
  B.type = "triangle";
  B.frequency.value = 115;
  BGain.gain.value = 0.11;
  B.connect(BGain).connect(Filter);
  const Lfo = Context.createOscillator();
  const LfoGain = Context.createGain();
  Lfo.type = "sine";
  Lfo.frequency.value = 0.07;
  LfoGain.gain.value = 5;
  Lfo.connect(LfoGain).connect(Filter.frequency);
  A.start();
  B.start();
  Lfo.start();
  Context.resume().catch(() => {});
  Ambient = { Context, Master, A, B, Lfo };
  window.__STORE_AMBIENT_AUDIO__ = Ambient;
}

function UpdateAmbient() {
  if (!Ambient) return;
  Ambient.Master.gain.setTargetAtTime(0.016 * Settings.AmbientVolume, Ambient.Context.currentTime, 0.04);
}

function Icon(Path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${Path}"/></svg>`;
}

function OpenSettings(Open) {
  const Overlay = document.getElementById("SettingsOverlayR43");
  if (!Overlay) return;
  Overlay.classList.toggle("Open", Boolean(Open));
  Overlay.setAttribute("aria-hidden", Open ? "false" : "true");
}

function RangeControl(Min, Max, Step, Value, Format, OnChange) {
  const Element = document.createElement("input");
  Element.type = "range";
  Element.min = String(Min);
  Element.max = String(Max);
  Element.step = String(Step);
  Element.value = String(Value);
  const Output = document.createElement("output");
  const Update = () => {
    const NumberValue = Number(Element.value);
    Output.textContent = Format(NumberValue);
    OnChange(NumberValue);
  };
  Element.addEventListener("input", Update);
  Update();
  return { Element, Output };
}

function SettingRow(Title, Control, Description) {
  const Row = document.createElement("div");
  Row.className = "R43Setting";
  const Top = document.createElement("div");
  Top.className = "R43SettingTop";
  const Label = document.createElement("label");
  Label.textContent = Title;
  Top.append(Label, Control.Output || document.createElement("span"));
  Row.append(Top, Control.Element);
  const Text = document.createElement("p");
  Text.textContent = Description;
  Row.appendChild(Text);
  return Row;
}

function BuildSettings() {
  if (document.getElementById("SettingsOverlayR43")) return;
  const Overlay = document.createElement("section");
  Overlay.id = "SettingsOverlayR43";
  Overlay.className = "R43SettingsOverlay";
  Overlay.setAttribute("aria-hidden", "true");
  const Panel = document.createElement("div");
  Panel.className = "R43SettingsPanel";
  Panel.setAttribute("role", "dialog");
  Panel.setAttribute("aria-modal", "true");
  Panel.innerHTML = `<div class="R43SettingsHead"><div><small>PLAYER CONFIGURATION</small><h2>SETTINGS</h2></div><button type="button" class="R43Close" aria-label="Close settings">×</button></div>`;
  const Body = document.createElement("div");
  Body.className = "R43SettingsBody";

  const Sensitivity = RangeControl(0.35, 2, 0.05, Settings.Sensitivity, Value => `${Value.toFixed(2)}×`, Value => { Settings.Sensitivity = Value; SaveSettings(); });
  Body.appendChild(SettingRow("LOOK SENSITIVITY", Sensitivity, "Mouse and touchpad camera speed."));

  const Smoothing = RangeControl(0, 100, 1, Settings.TrackpadSmoothing, Value => `${Math.round(Value)}%`, Value => { Settings.TrackpadSmoothing = Value; SaveSettings(); });
  Body.appendChild(SettingRow("TRACKPAD SMOOTHING", Smoothing, "Filters tiny touchpad jumps without changing zoom distance."));

  const Fov = RangeControl(58, 100, 1, Settings.Fov, Value => `${Math.round(Value)}°`, Value => { Settings.Fov = Value; SaveSettings(); ApplyCamera(); });
  Body.appendChild(SettingRow("FIELD OF VIEW", Fov, "Changes camera FOV only."));

  const Graphics = document.createElement("select");
  for (const [Value, Label] of [["performance", "PERFORMANCE"], ["balanced", "BALANCED"], ["high", "HIGH"]]) {
    const Option = document.createElement("option");
    Option.value = Value;
    Option.textContent = Label;
    Graphics.appendChild(Option);
  }
  Graphics.value = Settings.Graphics;
  Graphics.addEventListener("change", () => { Settings.Graphics = Graphics.value; PerfState.TextureStamp = ""; PerfState.Quality = ""; SaveSettings(); ApplyPerformance(); });
  Body.appendChild(SettingRow("GRAPHICS", { Element: Graphics }, "Keeps the same furniture and collision density. Changes renderer and light cost only."));

  const AmbientControl = RangeControl(0, 1, 0.01, Settings.AmbientVolume, Value => `${Math.round(Value * 100)}%`, Value => { Settings.AmbientVolume = Value; SaveSettings(); UpdateAmbient(); });
  Body.appendChild(SettingRow("STORE AMBIENT", AmbientControl, "HVAC/electrical room tone."));

  const ToggleWrap = document.createElement("label");
  ToggleWrap.className = "R43Toggle";
  const ToggleText = document.createElement("span");
  ToggleText.textContent = Settings.ShowFps ? "VISIBLE" : "HIDDEN";
  const Toggle = document.createElement("input");
  Toggle.type = "checkbox";
  Toggle.checked = Settings.ShowFps;
  Toggle.addEventListener("change", () => { Settings.ShowFps = Toggle.checked; ToggleText.textContent = Settings.ShowFps ? "VISIBLE" : "HIDDEN"; SaveSettings(); });
  ToggleWrap.append(ToggleText, Toggle);
  Body.appendChild(SettingRow("FPS COUNTER", { Element: ToggleWrap }, "Shows measured FPS and average frame time."));

  const Foot = document.createElement("div");
  Foot.className = "R43SettingsFoot";
  const Reset = document.createElement("button");
  Reset.type = "button";
  Reset.className = "R43Button";
  Reset.textContent = "RESET DEFAULTS";
  Reset.addEventListener("click", () => { Object.assign(Settings, Defaults); SaveSettings(); location.reload(); });
  const Done = document.createElement("button");
  Done.type = "button";
  Done.className = "R43Button R43Primary";
  Done.textContent = "DONE";
  Done.addEventListener("click", () => OpenSettings(false));
  Foot.append(Reset, Done);
  Panel.append(Body, Foot);
  Overlay.appendChild(Panel);
  document.body.appendChild(Overlay);
  Panel.querySelector(".R43Close")?.addEventListener("click", () => OpenSettings(false));
  Overlay.addEventListener("mousedown", Event => { if (Event.target === Overlay) OpenSettings(false); });
}

function BuildMenu() {
  const Card = document.querySelector(".BootCard");
  const StartButton = document.getElementById("StartButton");
  const BootStatus = document.getElementById("BootStatus");
  const BuildVersion = document.getElementById("BuildVersion");
  const BootLoadPanel = document.getElementById("BootLoadPanel");
  if (!Card || !StartButton || !BootStatus || !BuildVersion || Card.dataset.R43Built) return;
  Card.dataset.R43Built = "1";
  Card.className = "BootCard R43Menu";
  StartButton.remove();
  BootStatus.remove();
  BuildVersion.remove();

  const Hero = document.createElement("section");
  Hero.className = "R43Panel R43Hero";
  Hero.innerHTML = `<p class="R43Kicker">GREAT OLD GAMES</p><h1 class="R43Title">ONE NIGHT,<br>ONE INFINITE<br>FURNITURE STORE</h1><p class="R43Subtitle">The doors are locked. The aisles keep changing. Make it until morning.</p><div class="R43Actions"></div><svg class="R43Vector" viewBox="0 0 420 280" aria-hidden="true"><rect x="22" y="44" width="376" height="192"/><line x1="22" y1="92" x2="398" y2="92"/><line x1="22" y1="188" x2="398" y2="188"/><line x1="104" y1="44" x2="104" y2="236"/><line x1="314" y1="44" x2="314" y2="236"/><polyline points="128,120 165,120 165,146 128,146 128,120"/><polyline points="244,116 288,116 288,150 244,150 244,116"/><polyline points="127,198 171,198 171,220 127,220 127,198"/><polyline points="244,198 290,198 290,220 244,220 244,198"/><line x1="210" y1="92" x2="210" y2="188"/></svg>`;

  const Side = document.createElement("aside");
  Side.className = "R43Panel R43Side";
  const Seed = Number.isFinite(window.__STORE_WORLD_SEED__) ? window.__STORE_WORLD_SEED__ >>> 0 : "----";
  Side.innerHTML = `<div class="R43SideTop"><span>STORE SYSTEM</span><code>SEED ${Seed}</code></div><div class="R43MiniStats"><div><small>WORLD</small><strong>DETERMINISTIC</strong></div><div><small>DETAIL</small><strong>FULL DENSITY</strong></div></div>`;

  StartButton.className = "R43Button R43Primary";
  StartButton.innerHTML = `${Icon("M8 5l10 7-10 7V5z")}<span>ENTER STORE</span>`;
  Hero.querySelector(".R43Actions").appendChild(StartButton);
  const SettingsButton = document.createElement("button");
  SettingsButton.type = "button";
  SettingsButton.className = "R43Button";
  SettingsButton.innerHTML = `${Icon("M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M18.4 5.6l-2.1 2.1m-8.6 8.6-2.1 2.1M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7z")}<span>SETTINGS</span>`;
  Hero.querySelector(".R43Actions").appendChild(SettingsButton);
  BootStatus.className = "R43Status";
  BootStatus.innerHTML = `<i></i>${BootStatus.textContent || "Store ready."}`;
  BuildVersion.className = "R43Build";
  if (BootLoadPanel) Side.appendChild(BootLoadPanel);
  Side.append(BootStatus, BuildVersion);
  Card.replaceChildren(Hero, Side);
  SettingsButton.addEventListener("click", () => OpenSettings(true));
  StartButton.addEventListener("click", StartAmbient, { once: true });
}

const FpsCounter = document.createElement("div");
FpsCounter.id = "FpsCounterR43";
FpsCounter.innerHTML = `FPS <strong>--</strong><span>-- ms</span>`;
document.body.appendChild(FpsCounter);
FpsCounter.style.flexWrap = "wrap";
FpsCounter.style.maxWidth = "290px";
const Samples = [];
document.addEventListener("visibilitychange", () => { Samples.length = 0; LastFrame = performance.now(); });
let LastFrame = performance.now();
let LastFpsPaint = 0;

function FpsFrame(Now) {
  const Delta = Now - LastFrame;
  LastFrame = Now;
  if (Delta > 0 && Delta < 250) Samples.push(Delta);
  while (Samples.length > 90) Samples.shift();
  if (Now - LastFpsPaint > 350 && Samples.length) {
    LastFpsPaint = Now;
    let Sum = 0;
    for (const Sample of Samples) Sum += Sample;
    const Average = Sum / Samples.length;
    const Fps = 1000 / Average;
    const Sorted = [...Samples].sort((A, B) => A - B);
    const P95 = Sorted[Math.floor((Sorted.length - 1) * 0.95)];
    const Calls = Game()?.Renderer?.info?.render?.calls ?? 0;
    FpsCounter.innerHTML = `FPS <strong>${Math.round(Fps)}</strong><span>${Average.toFixed(1)} ms</span><small style="display:block;flex-basis:100%;font-size:10px;margin-top:5px">95% frame ${P95.toFixed(1)} ms · ${Calls} draws</small>`;
  }
  FpsCounter.classList.toggle("R43Hidden", !Settings.ShowFps);
  requestAnimationFrame(FpsFrame);
}

BuildSettings();
BuildMenu();
addEventListener("resize", ApplyPerformance);
addEventListener("store-settings-change", () => { PerfState.TextureStamp = ""; PerfState.Quality = ""; UpdateAmbient(); ApplyPerformance(); });
setInterval(ApplyPerformance, 950);
setTimeout(ApplyPerformance, 0);
requestAnimationFrame(FpsFrame);
window.__STORE_APPLY_PERFORMANCE__ = ApplyPerformance;
window.__STORE_APPLY_TEXTURE_BUDGET_TO_CHUNK__ = ApplyTextureBudgetToChunk;
window.__STORE_PERFORMANCE_BUILD__ = "V0.35.39-FIXED-QUALITY";
window.__STORE_SETTINGS_BUILD__ = "V0.35.39-FIXED-QUALITY";
