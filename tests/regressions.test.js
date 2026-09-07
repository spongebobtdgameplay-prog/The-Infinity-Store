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


const { STREAM_RANGE, ChunkRange } = await import('../stream-range.js');
test('loaded geometry spans the unchanged 148m view distance in both directions',()=> {
  for(let index=0;index<100;index++) for(const offset of [0.001,15,29.999]) {
    const range=ChunkRange(index), z=10-index*30-offset;
    assert.ok(z-(10-(range.ActiveMax+1)*30)>148);
    if(range.ActiveMin>0) assert.ok((10-range.ActiveMin*30)-z>148);
    assert.ok(range.PrepareMax>range.ActiveMax);
    assert.ok(range.PrepareMin<=range.ActiveMin);
  }
  assert.equal(STREAM_RANGE.BootCount,STREAM_RANGE.ActiveRadius+1);
});

test('maintenance retains every visible aisle and prefetches all intervening indices',()=> {
 const requested=[],dropped=[];
 const active=new Map(Array.from({length:13},(_,i)=>[14+i,{Index:14+i}]));
 const prepared=new Map([11,12,13,27,28,29].map(i=>[i,{Index:i}]));
 const c=vm.createContext({Camera:{position:{z:-605}},ChunkIndexForZ:()=>20,performance:{now:()=>1000},
  MarkViewedChunks(){},UpdateObjectStreaming(){},UpdateChunkVisibility(){},LastMaintainedChunkIndex:-1,LastChunkMaintenanceAt:0,LastChunkIndex:0,
  ChunkRange,STREAM_RANGE,ActiveChunks:active,PreparedChunks:prepared,TryActivateIndex:()=>true,
  RequestChunk:i=>{requested.push(i);return Promise.resolve();},PREPARED_BACK_CACHE:9,VIEW_KEEP_HOLD_MS:2200,
  RestoreChunkStreamObjects(){},DeactivateChunk:i=>dropped.push(i),DropPreparedChunk:i=>dropped.push(i),AisleCounter:null});
 vm.runInContext(functionSource('game.js','EnsureChunksAroundPlayer'),c);
 vm.runInContext('EnsureChunksAroundPlayer()',c);
 assert.deepEqual(requested.sort((a,b)=>a-b),[11,12,13,27,28,29]);
 assert.deepEqual(dropped,[]);
});

test('generation budget makes progress even when every idle callback reports no spare time',async()=> {
 let now=0, callbacks=0;
 const c=vm.createContext({performance:{now:()=>now},window:{requestIdleCallback(){}},document:{visibilityState:'visible'},
  requestIdleCallback:callback=>{callbacks++;callback({didTimeout:false,timeRemaining:()=>0});},
  requestAnimationFrame:callback=>{now+=16;callback();},setTimeout:callback=>callback()});
 vm.runInContext(functionSource('render-work-budget.js','WaitForWorkSlice'),c);
 await vm.runInContext('WaitForWorkSlice(5,120)',c);
 assert.ok(now>=120&&now<150);assert.ok(callbacks<12);
});

test('FPS counter never changes renderer resolution under slow frames',()=> {
 let applied=0;
 const c=vm.createContext({LastFrame:0,LastFpsPaint:0,Samples:Array(89).fill(45),document:{hidden:false},
  Settings:{ShowFps:true},FpsCounter:{classList:{toggle(){}},innerHTML:''},Game:()=>({Renderer:{info:{render:{calls:120}}}}),
  ApplyRenderer:()=>{applied++;},requestAnimationFrame(){}});
 vm.runInContext(functionSource('performance-manager.js','FpsFrame'),c);
 for(let i=1;i<15;i++){c.LastFrame=i*5000-45;vm.runInContext(`FpsFrame(${i*5000})`,c);}
 assert.equal(applied,0);assert.match(c.FpsCounter.innerHTML,/95% frame/);
});
