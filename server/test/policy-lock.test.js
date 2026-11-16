'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RoutingManager}=require('/app/routing');
test('Rules remain editable while globally disabled without enabling the policy gate',async()=>{
 const r=new RoutingManager({});r.state={policiesEnabled:false,policies:{p:{id:'p',name:'Keep',enabled:false,createdAt:'old'}}};let writes=0;r.save=async()=>writes++;r.reconcile=async()=>{};r.normalizePolicy=input=>input;
 await r.updatePolicy('p',{name:'Edited',enabled:false});assert.equal(r.state.policies.p.name,'Edited');assert.equal(r.state.policies.p.createdAt,'old');
 await r.setPolicyEnabled('p',true);assert.equal(r.state.policies.p.enabled,true);assert.equal(r.state.policiesEnabled,false);
 await r.deletePolicy('p');assert.equal(r.state.policies.p,undefined);assert.equal(r.state.policiesEnabled,false);assert.equal(writes,3);
});
