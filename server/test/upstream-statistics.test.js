'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RoutingManager}=require('/app/routing'),{ClientStatistics}=require('/app/client-statistics');
test('upstream totals use distinct identities, persist and accumulate across process generations',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-stats-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'stats.json');const r=new RoutingManager({});r.state={upstreams:{b:{id:'b'},c:{id:'c'}}};r.upstreamStatistics=new ClientStatistics(file);r.upstreamIdentity=u=>({id:u.id,publicKey:u.id+':same-server-key',protocol:'AWG3'});let gen='one',rx=100;
 r.readUpstreamStats=u=>({status:'up',connectionStatus:'connected',transferRx:u.id==='b'?rx:10,transferTx:20,latestHandshakeAt:null});r.upstreamGeneration=()=>gen;
 r.collectUpstreamStatistics();r.collectUpstreamStatistics();assert.equal(r.upstreamStats({id:'b'}).transferRx,100);assert.equal(r.upstreamStats({id:'c'}).transferRx,10);
 gen='two';rx=150;r.upstreamStatistics=new ClientStatistics(file);r.collectUpstreamStatistics();assert.equal(r.upstreamStats({id:'b'}).transferRx,250);assert.equal(r.upstreamStats({id:'c'}).transferRx,20);
 r.enqueue=fn=>fn();
 const handshake='2026-11-16T00:00:00.000Z';r.upstreamStatistics.entries.b.latestHandshakeAt=handshake;
 return (async()=>{
  const cBefore=r.upstreamStats({id:'c'}).transferRx;
  await r.resetUpstreamTraffic('b');assert.equal(r.upstreamStats({id:'b'}).transferRx,0);assert.equal(r.upstreamStats({id:'c'}).transferRx,cBefore);
  await assert.rejects(r.resetUpstreamTraffic('missing'),e=>e.status===404);
  await r.resetUpstreamTraffic();assert.equal(r.upstreamStats({id:'b'}).transferRx,0);assert.equal(r.upstreamStats({id:'c'}).transferRx,0);
  assert.equal(r.upstreamStatistics.values(r.upstreamIdentity({id:'b'})).latestHandshakeAt,handshake);
  r.upstreamStatistics=new ClientStatistics(file);r.collectUpstreamStatistics();assert.equal(r.upstreamStats({id:'b'}).transferRx,0);
  rx+=7;r.collectUpstreamStatistics();assert.equal(r.upstreamStats({id:'b'}).transferRx,7);
  assert.ok(fs.readdirSync(dir).some(x=>x.includes('.before-reset-')));
 })();

});
