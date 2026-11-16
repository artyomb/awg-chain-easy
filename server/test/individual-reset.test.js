'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ClientStatistics}=require('../app/client-statistics');
test('Individual reset changes only selected identity and persists raw baselines and handshake floors',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'selected-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'stats.json');
 const clients=[{id:'a',publicKey:'ka',protocol:'AWG3'},{id:'b',publicKey:'kb',protocol:'AWG3'}];const stamp='2026-11-16T10:00:00.000Z';let stats=new Map(clients.map((c,i)=>[c.publicKey,{transferRx:100+i,transferTx:200+i,generation:'one',latestHandshakeAt:stamp}]));let store=new ClientStatistics(file);store.observe(clients,stats);const other={...store.entries.b};
 store.reset(clients,stats,new Set(['a']));assert.equal(store.values(clients[0]).transferRx,0);assert.equal(store.values(clients[0]).latestHandshakeAt,null);assert.deepEqual(store.entries.b,other);
 store=new ClientStatistics(file);store.observe(clients,stats);assert.equal(store.values(clients[0]).transferTx,0);assert.equal(store.values(clients[0]).latestHandshakeAt,null);assert.deepEqual(store.entries.b,other);
 stats.get('ka').transferRx+=7;stats.get('ka').latestHandshakeAt='2026-11-16T10:01:00.000Z';store.observe(clients,stats);assert.equal(store.values(clients[0]).transferRx,7);
 const last=store.values(clients[0]).latestHandshakeAt;store.resetTraffic(clients,stats,new Set(['a']));assert.equal(store.values(clients[0]).transferRx,0);assert.equal(store.values(clients[0]).latestHandshakeAt,last);assert.deepEqual(store.entries.b,other);
 store=new ClientStatistics(file);store.observe(clients,stats);assert.equal(store.values(clients[0]).transferRx,0);
});
