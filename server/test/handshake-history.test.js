'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HandshakeHistory}=require('/app/handshake-history');
const client={id:'a',publicKey:'public-a',protocol:'AWG3'};
const live=t=>new Map([['public-a',{latestHandshakeAt:t}]]);
test('timestamp survives new process instance, zero runtime and older samples; no writes without changes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handshake-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json');
 const h=new HandshakeHistory(file);h.observe([client],live('2026-11-13T12:00:00Z'));assert.equal(fs.statSync(file).mode&0o777,0o600);
 const before=fs.statSync(file).mtimeMs;h.observe([client],live(null));assert.equal(fs.statSync(file).mtimeMs,before);
 const restarted=new HandshakeHistory(file);assert.equal(restarted.latest(client,null),'2026-11-13T12:00:00.000Z');
 restarted.observe([client],live('2026-11-13T11:00:00Z'));assert.equal(restarted.latest(client),'2026-11-13T12:00:00.000Z');
 restarted.observe([client],live('2026-11-13T13:00:00Z'));assert.equal(new HandshakeHistory(file).latest(client),'2026-11-13T13:00:00.000Z');
});
test('rename preserves history; deletion, key replacement and protocol changes cannot inherit it',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handshake-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json');const h=new HandshakeHistory(file);
 h.observe([client],live('2026-11-13T12:00:00Z'));assert.ok(h.latest({...client,name:'renamed'}));assert.equal(h.latest({...client,publicKey:'other'}),null);assert.equal(h.latest({...client,protocol:'AWG2'}),null);
 h.observe([],new Map());assert.equal(new HandshakeHistory(file).latest(client),null);
 h.observe([{...client,id:'new-id'}],new Map());assert.equal(h.latest({...client,id:'new-id'}),null);
});
test('invalid samples ignored; failed write does not claim persistence',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handshake-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json');const h=new HandshakeHistory(file);
 h.observe([client],live('invalid'));assert.equal(h.latest(client),null);assert.ok(!fs.existsSync(file));
 h.filename=path.join(dir,'missing','history.json');assert.throws(()=>h.observe([client],live('2026-11-13T12:00:00Z')));assert.equal(h.latest(client),null);
});
