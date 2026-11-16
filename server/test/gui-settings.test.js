'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {GuiSettings}=require('../app/gui-settings');
test('GUI settings persist, validate atomically, retain backups and migrate defaults',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'awg-settings-'));
 try {const file=path.join(dir,'settings.json'),defaults={serverName:'Тестовый сервер',dnsUpstreams:['1.1.1.1','8.8.8.8','1.0.0.1'],qrFormat:'conf'};const s=new GuiSettings(file,defaults);
 s.save(s.next({serverName:'Новое имя',qrFormat:'amnezia'}));assert.equal(new GuiSettings(file,defaults).value.serverName,'Новое имя');assert.equal(JSON.parse(fs.readFileSync(file+'.bak')).serverName,'Тестовый сервер');
 for(const patch of [{serverName:'x\ny'},{serverName:''},{dnsUpstreams:[]},{dnsUpstreams:['1.1.1.1','1.1.1.1']},{dnsUpstreams:['127.0.0.1']},{dnsUpstreams:['224.0.0.1']},{qrFormat:'other'},{other:1}])assert.throws(()=>s.next(patch));assert.equal(s.value.serverName,'Новое имя');
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
