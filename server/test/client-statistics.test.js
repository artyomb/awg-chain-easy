'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ClientStatistics}=require('/app/client-statistics');
const c={id:'a',publicKey:'public-a',protocol:'AWG3'};
const sample=(rx,tx,generation='first',latestHandshakeAt='2026-11-13T12:00:00Z')=>new Map([[c.publicKey,{transferRx:rx,transferTx:tx,generation,latestHandshakeAt}]]);
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'client-stats-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'stats.json');return {file,s:new ClientStatistics(file)}}
test('accumulates deltas once and detects container epochs even if new counters exceed previous values',t=>{
 const {s,file}=setup(t);s.observe([c],sample(100,200));s.observe([c],sample(150,250));s.observe([c],sample(150,250));assert.equal(s.values(c).transferRx,150);
 const restarted=new ClientStatistics(file);restarted.observe([c],sample(300,400,'new-container'));assert.deepEqual(restarted.values(c),{transferRx:450,transferTx:650,latestHandshakeAt:'2026-11-13T12:00:00.000Z'});assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('counter decreases, disabled peers, missing samples and explicit peer recreation keep totals',t=>{
 const {s}=setup(t);s.observe([c],sample(100,200));s.observe([c],new Map());s.observe([c],sample(10,20));assert.equal(s.values(c).transferRx,110);
 s.observe([c],sample(150,250),new Set([c.id]));assert.equal(s.values(c).transferRx,260);assert.equal(s.values(c).transferTx,470);
});
test('reset establishes baseline and suppresses old handshake after polling and process restart',t=>{
 const {s,file}=setup(t);s.observe([c],sample(100,200));s.reset([c],sample(100,200));let next=new ClientStatistics(file);next.observe([c],sample(100,200));assert.deepEqual(next.values(c),{transferRx:0,transferTx:0,latestHandshakeAt:null});
 next.observe([c],sample(107,211));assert.equal(next.values(c).transferRx,7);assert.equal(next.values(c).latestHandshakeAt,null);
 next=new ClientStatistics(file);next.observe([c],sample(10,15,'new-container','2026-11-13T12:02:00Z'));assert.deepEqual(next.values(c),{transferRx:17,transferTx:26,latestHandshakeAt:'2026-11-13T12:02:00.000Z'});
});
test('reset while peer offline, all directions, identity changes and deletion cannot revive previous values',t=>{
 const {s,file}=setup(t);s.observe([c],sample(100,200));s.reset([c],new Map());s.observe([c],sample(3,4,'next',null));assert.deepEqual(s.values(c),{transferRx:3,transferTx:4,latestHandshakeAt:null});
 assert.equal(s.values({...c,publicKey:'new-key'}).transferRx,0);s.observe([],new Map());assert.equal(new ClientStatistics(file).values(c).transferRx,0);
});
test('migrates saved handshake without inventing traffic and avoids unnecessary writes',t=>{
 const {file}=setup(t);const legacy=file+'.legacy';fs.writeFileSync(legacy,JSON.stringify({version:1,entries:{a:{publicKey:c.publicKey,protocol:c.protocol,latestHandshakeAt:'2026-11-13T10:00:00Z'}}}));
 const s=new ClientStatistics(file,legacy);s.observe([c],sample(50,70,'first',null));assert.equal(s.values(c).latestHandshakeAt,'2026-11-13T10:00:00.000Z');assert.equal(s.values(c).transferRx,50);
 const before=fs.statSync(file).mtimeMs;s.observe([c],sample(50,70,'first',null));assert.equal(fs.statSync(file).mtimeMs,before);
});
test('write failure and overflow do not apply unpersisted values',t=>{
 const {s,file}=setup(t);s.observe([c],sample(100,200));s.filename=path.join(file,'missing');assert.throws(()=>s.reset([c],sample(100,200)));assert.equal(s.values(c).transferRx,100);s.filename=file;
 s.entries.a.transferRx=Number.MAX_SAFE_INTEGER;assert.throws(()=>s.observe([c],sample(101,201)),/overflow/);
});
