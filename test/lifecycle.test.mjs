import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineConsequentialTool, defineReadTool } from '../dist/index.js';
const request = { title: 'Open tickets?', detail: 'Open the official page.', confirmLabel: 'Open tickets', timeoutMs: 15 };
const result = value => JSON.parse(value.content[0].text);
const make = overrides => defineConsequentialTool({name:'handoff',description:'Open tickets',inputSchema:{type:'object'},parseArgs:()=>({}),describeConsent:()=>request,consent:async()=>({decision:'confirmed'}),execute:async()=>({ok:true}),...overrides});
test('a custom surface that never settles is bounded by the gate deadline', {timeout:500}, async()=>{
  const tool=make({consent:()=>new Promise(()=>{})});
  assert.equal(result(await tool.execute({})).code,'consent_timeout');
});
test('a confirmation after the deadline never performs the action', async()=>{
  let confirm; let calls=0;
  const tool=make({consent:()=>new Promise(r=>{confirm=r}),execute:async()=>{calls++;return {ok:true}}});
  assert.equal(result(await tool.execute({})).code,'consent_timeout');
  confirm({decision:'confirmed'}); await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,0);
});
test('pre-cancelled calls do not open consent or execute',async()=>{
  let prompts=0;let calls=0;const ac=new AbortController();ac.abort();
  const tool=make({consent:async()=>{prompts++;return {decision:'confirmed'}},execute:async()=>{calls++}});
  assert.equal(result(await tool.execute({}, {signal:ac.signal})).code,'tool_cancelled');
  assert.equal(prompts,0);assert.equal(calls,0);
});
test('cancelling an open prompt aborts its surface and blocks late consent',async()=>{
  const ac=new AbortController();let surfaceSignal;let confirm;let calls=0;
  const tool=make({consent:(_request,options)=>{surfaceSignal=options.signal;return new Promise(r=>{confirm=r})},execute:async()=>{calls++}});
  const pending=tool.execute({}, {signal:ac.signal});ac.abort();
  assert.equal(result(await pending).code,'tool_cancelled');assert.equal(surfaceSignal.aborted,true);
  confirm({decision:'confirmed'});await Promise.resolve();assert.equal(calls,0);
});
test('execution context reaches reads and confirmed actions',async()=>{
  const ac=new AbortController();let context;
  const read=defineReadTool({name:'read',description:'Read',inputSchema:{},parseArgs:()=>({}),execute:async(_args,options)=>{context=options;return {ok:true}}});
  await read.execute({}, {signal:ac.signal});assert.equal(context.signal,ac.signal);
  await make({execute:async(_args,_consent,options)=>{context=options;return {ok:true}}}).execute({}, {signal:ac.signal});
  assert.equal(context.signal,ac.signal);
});
test('an abort during execution reports tool_cancelled, not tool_unavailable',async()=>{
  const abortable=signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  const readAc=new AbortController();
  const read=defineReadTool({name:'read',description:'Read',inputSchema:{},parseArgs:()=>({}),execute:(_args,options)=>abortable(options.signal)});
  const readPending=read.execute({}, {signal:readAc.signal});readAc.abort();
  assert.equal(result(await readPending).code,'tool_cancelled');
  const actAc=new AbortController();let started;const running=new Promise(r=>{started=r});
  const act=make({execute:(_args,_consent,options)=>{started();return abortable(options.signal)}});
  const actPending=act.execute({}, {signal:actAc.signal});await running;actAc.abort();
  assert.equal(result(await actPending).code,'tool_cancelled');
});
// The host is untyped: null or a signal-shaped object must not throw on the
// way in, nor arm a listener that throws later from the consent timer.
test('non-AbortSignal execution options are ignored, never thrown on', async()=>{
  const uncaught=[];const onUncaught=e=>uncaught.push(e);process.on('uncaughtException',onUncaught);
  try{
    const read=defineReadTool({name:'r',description:'r',inputSchema:{type:'object'},parseArgs:()=>({}),execute:async()=>({ok:true})});
    assert.deepEqual(result(await read.execute({}, null)),{ok:true});
    const tool=make({consent:()=>new Promise(()=>{})});
    assert.equal(result(await tool.execute({}, null)).code,'consent_timeout');
    assert.equal(result(await tool.execute({}, {signal:{}})).code,'consent_timeout');
    await new Promise(r=>setTimeout(r,40));
    assert.deepEqual(uncaught,[]);
  }finally{process.off('uncaughtException',onUncaught);}
});
