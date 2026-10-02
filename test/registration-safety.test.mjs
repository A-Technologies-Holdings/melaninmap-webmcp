import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerAgentTools, detectModelContext } from '../dist/index.js';
const tool = name => ({name,description:name,inputSchema:{type:'object'},execute:async()=>({content:[]})});
const host = value => Object.defineProperty(globalThis,'navigator',{configurable:true,value:{modelContext:value}});
test('a throwing browser getter cannot break the page',()=>{
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{get modelContext(){throw Error('blocked')}}});
 assert.doesNotThrow(()=>registerAgentTools([tool('safe')]));
 assert.equal(detectModelContext(),null);
});
test('overlapping scopes are rejected before touching the host',()=>{
 const names=[];host({registerTool(t){names.push(t.name)}});
 assert.equal(registerAgentTools([tool('search'),tool('details')]).registered,true);
 assert.deepEqual(registerAgentTools([tool('search'),tool('verify')]),{registered:false,reason:'tool_conflict'});
 assert.deepEqual(names,['search','details']);
});
test('a fresh host can register the same names',()=>{
 const names=[];host({registerTool(t){names.push(t.name)}});
 assert.equal(registerAgentTools([tool('search'),tool('details')]).registered,true);
 assert.deepEqual(names,['search','details']);
});
test('async registration waits for the browser and reports rejected registration truthfully',async()=>{
 const { registerAgentToolsAsync }=await import('../dist/index.js');
 host({async registerTool(t){if(t.name==='bad')throw Error('host rejected')}});
 assert.deepEqual(await registerAgentToolsAsync([tool('async_good'),tool('bad')]),{registered:false,reason:'partial_registration',toolCount:1});
 assert.deepEqual(await registerAgentToolsAsync([tool('async_good'),tool('bad')]),{registered:false,reason:'already_registered'});
});
test('concurrent async registration reserves names before waiting',async()=>{
 const { registerAgentToolsAsync }=await import('../dist/index.js');
 let finish; host({registerTool(){return new Promise(resolve=>finish=resolve)}});
 const first=registerAgentToolsAsync([tool('pending')]);
 assert.deepEqual(await registerAgentToolsAsync([tool('pending')]),{registered:false,reason:'already_registered'});
 finish(); assert.equal((await first).registered,true);
});
test('the synchronous compatibility API observes promise rejection without claiming acceptance',async()=>{
 host({registerTool(){return Promise.reject(Error('not accepted'))}});
 assert.deepEqual(registerAgentTools([tool('legacy_promise')]),{registered:false,reason:'async_registration_pending'});
 await Promise.resolve();
});
test('bare compatibility registration observes rejection without claiming acceptance',async()=>{
 host({registerTool(_tool,options){if(options)throw TypeError('options unsupported');return Promise.reject(Error('not accepted'))}});
 const controller=new AbortController();
 assert.deepEqual(registerAgentTools([tool('bare_promise')],{signal:controller.signal}),{registered:false,reason:'async_registration_pending'});
 controller.abort();
 assert.deepEqual(registerAgentTools([tool('bare_promise')]),{registered:false,reason:'already_registered'});
 await Promise.resolve();
});
test('bulk compatibility registration observes rejection without claiming acceptance',async()=>{
 host({provideContext(){return Promise.reject(Error('not accepted'))}});
 assert.deepEqual(registerAgentTools([tool('bulk_promise')]),{registered:false,reason:'async_registration_pending'});
 assert.deepEqual(registerAgentTools([tool('bulk_promise')]),{registered:false,reason:'already_registered'});
 await Promise.resolve();
});
