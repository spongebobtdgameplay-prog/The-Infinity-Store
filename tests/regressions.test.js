import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
function functionSource(file, name) {
  const source = read(file);
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const next = source.indexOf('\n}', start);
  return source.slice(start, next + 2);
}
globalThis.window = {};
const { CreateChunkLayout } = await import('../store-layout.js');
const themes = ['LIVING ROOM','BEDROOMS','KITCHENS','BATHROOMS','WAREHOUSE','STORAGE','SHOWROOM','CLEARANCE'];
for (const Theme of themes) test(`${Theme}: dense deterministic layouts preserve walkways and spacing`, () => {
  for (let Seed = 1; Seed <= 40; Seed++) for (const Index of [0, 1, 20]) {
    const args = { Theme, Seed, Index, CenterZ: 10 - 30 * (Index + 0.5) };
    const layout = CreateChunkLayout(args);
    assert.deepEqual(layout, CreateChunkLayout(args));
    const additions = layout.Base.filter(x => x.Slot.startsWith('Endcap.'));
    assert.ok(additions.length >= 4, `${Theme} ${Seed}/${Index}: ${additions.length} added`);
    const solids = layout.Reservations.filter(x => x.Kind !== 'Protected');
    for (let i = 0; i < solids.length; i++) {
      const a = solids[i].Bounds;
      assert.ok(a.MaxX <= -3.4 || a.MinX >= 3.4);
      for (const other of solids.slice(i + 1)) {
        const b = other.Bounds;
        assert.ok(!(a.MaxX > b.MinX && a.MinX < b.MaxX && a.MaxZ > b.MinZ && a.MinZ < b.MaxZ), `${solids[i].Slot}/${other.Slot}`);
      }
    }
  }
});
function fogContext(indices, current = 0, z = 0, pending = []) {
  const scene = {};
  const chunks = new Map(indices.map(i => [i, {Active:true, TopZ:10-i*30, BottomZ:10-(i+1)*30,
    Group:{parent:scene,visible:true,userData:{PresentationReadyR83:!pending.includes(i)}}}]));
  const ctx = vm.createContext({Game:{Scene:scene,Camera:{position:{z}},ActiveChunks:chunks,ChunkIndexForZ:()=>current}});
  vm.runInContext(functionSource('distance-haze-r82.js','LoadedDistance'),ctx);
  return ctx;
}
test('fog ends before the first unloaded gap even with a distant ready chunk',()=> {
  const c=fogContext([0,1,3]); assert.equal(vm.runInContext('LoadedDistance()',c),47);
});
test('unfinished visible aisle is excluded from visibility range',()=> {
  const c=fogContext([0,1,2],0,0,[1]); assert.equal(vm.runInContext('LoadedDistance()',c),17);
});
test('walking back cannot expose retired aisles',()=> {
  const c=fogContext([3,4,5],4,-120); assert.equal(vm.runInContext('LoadedDistance()',c),37);
});
test('no ready current chunk fails closed',()=> {
  const c=fogContext([]); assert.equal(vm.runInContext('LoadedDistance()',c),2);
});
function authContext(result, deferred) {
  const ctx=vm.createContext({SessionToken:'old', Account:{id:1}, Profile:{}, SERVER_WAKE_TIMEOUT_MS:45000,
    Api: deferred || (async()=>result), StoreSession:t=>{ctx.SessionToken=t;}, DisconnectSocket:()=>{},
    ClearRoomState:()=>{}, Dispatch:()=>{}, GetState:()=>({}),ApplyProfileSettings:()=>{},SaveAccountName:()=>{},RenderProfile:()=>{},MountNavigation:()=>{}});
  vm.runInContext(functionSource('multiplayer.js','RefreshAccount'),ctx);
  return ctx;
}
for(const error of ['SERVER_TIMEOUT','SERVER_UNREACHABLE','AUTH_UNAVAILABLE','HTTP_503']) test(`session survives ${error}`,async()=>{
  const c=authContext({ok:false,error}); await vm.runInContext('RefreshAccount()',c);assert.equal(c.SessionToken,'old');assert.equal(c.Account.id,1);
});
test('verified invalid session is cleared',async()=>{
 const c=authContext({ok:false,error:'AUTH_REQUIRED'});await vm.runInContext('RefreshAccount()',c);assert.equal(c.SessionToken,'');assert.equal(c.Account,null);
});
test('stale rejection cannot erase a newer login',async()=>{
 let resolve;const c=authContext(null,()=>new Promise(r=>{resolve=r;}));const flight=vm.runInContext('RefreshAccount()',c);
 c.SessionToken='new';resolve({ok:false,error:'AUTH_REQUIRED'});await flight;assert.equal(c.SessionToken,'new');assert.equal(c.Account.id,1);
});
test('active session renews expiry and does not rotate the token',async()=>{
 const queries=[];const row={id:'user',session_id:'session',last_seen_at:new Date(Date.now()-600000),expires_at:new Date()};
 const c=vm.createContext({Date, SESSION_DAYS:365,ValidSessionTokenShape:()=>true,SessionTokenHash:t=>t,
 Database:{query:async(...args)=>{queries.push(args);return {rows:[row]};}}});
 vm.runInContext(functionSource('server.js','AccountFromToken'),c);const result=await vm.runInContext('AccountFromToken("remembered")',c);
 assert.equal(queries.length,2);assert.match(queries[1][0],/expires_at = \$2/);assert.ok(result.expiresAt.getTime()>Date.now()+364*86400000);assert.equal(result.sessionId,'session');
});
test('activation waits for presentation and GPU readiness',()=>{
 const c=vm.createContext({window:{__STORE_REQUIRE_TRAVERSAL_READY__:true},Renderer:{compileAsync(){}},WarmChunkGpu:async()=>{},
 PreparedChunks:new Map(),ActiveChunks:new Map(),CollisionBoxes:[],Tasks:new Map(),Scene:{add(){}},
 chunk:{Index:1,Ready:true,Group:{userData:{TraversalReadyR83:true}},ExternalObjects:[],CollisionEntries:[],TaskRecords:[]}});
 vm.runInContext(functionSource('game.js','ActivateChunk'),c);
 assert.equal(vm.runInContext('ActivateChunk(chunk)',c),false);
 c.chunk.Group.userData.PresentationReadyR83=true;assert.equal(vm.runInContext('ActivateChunk(chunk)',c),false);
 c.chunk.Group.userData.GpuWarmReadyR92=true;assert.equal(vm.runInContext('ActivateChunk(chunk)',c),true);
});

test('session restoration retries outages without showing login, then recovers', async()=> {
  let result={ok:false,error:'SERVER_TIMEOUT'},chooser=0,retry;
  const context=vm.createContext({SessionToken:'saved',AccountGateResolved:false,Account:null,
    document:{createElement:()=>({}),body:{appendChild(){}},addEventListener(){}},addEventListener(){},setInterval(){},
    setTimeout:f=>{retry=f;return 1;},clearTimeout(){},HideAccountScreen(){},ShowAccountScreen(){chooser++;},
    SetStatus(){},ReadSavedAccounts:()=>[],RestoreSession:async()=>result});
  const source=read('multiplayer.js');
  vm.runInContext(source.slice(source.indexOf('let SessionRestoreFlight = null;'),source.indexOf('\nAccountLoginSwitch.addEventListener')),context);
  await vm.runInContext('InitializeAccountGate()',context);
  assert.equal(chooser,0);assert.equal(typeof retry,'function');assert.equal(context.SessionToken,'saved');
  result={ok:true};await retry();assert.equal(chooser,0);assert.equal(vm.runInContext('RestoreNotice.hidden',context),true);
});

test('FPS adaptation reduces GPU resolution with a floor and slow recovery',()=> {
  let applied=0;
  const context=vm.createContext({LastFrame:0,LastFpsPaint:0,Samples:Array(89).fill(35),
    PerfState:{ResolutionScale:1,LastAdaptation:0},document:{hidden:false},
    window:{__STORE_GAMEPLAY_STARTED__:true},Settings:{ShowFps:true},
    FpsCounter:{classList:{toggle(){}},innerHTML:''},Game:()=>({Renderer:{info:{render:{calls:120}}}}),
    ApplyRenderer:()=>{applied++;},requestAnimationFrame(){}});
  vm.runInContext(functionSource('performance-manager.js','FpsFrame'),context);
  for(let n=1;n<=10;n++) {context.LastFrame=n*5000-35;vm.runInContext(`FpsFrame(${n*5000})`,context);}
  assert.equal(context.PerfState.ResolutionScale,0.65);assert.ok(applied>0);
  assert.match(context.FpsCounter.innerHTML,/95% frame/);
  context.Samples=Array(89).fill(16);context.LastFrame=55000-16;vm.runInContext('FpsFrame(55000)',context);
  assert.ok(Math.abs(context.PerfState.ResolutionScale-0.69)<0.001);
  context.document.hidden=true;context.Samples=Array(89).fill(35);context.LastFrame=60000-35;vm.runInContext('FpsFrame(60000)',context);
  assert.ok(Math.abs(context.PerfState.ResolutionScale-0.69)<0.001);
});
