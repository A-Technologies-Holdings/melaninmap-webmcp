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

test('legacy scope reservations prevent duplicate registration across bundles',()=>{
 globalThis.__webmcpAgentToolsRegistered = { '["legacy"]': true };
 let calls=0; host({registerTool(){calls++}});
 try {
  assert.equal(registerAgentTools([tool('legacy')]).reason,'already_registered');
  assert.equal(registerAgentTools([tool('legacy'),tool('extra')]).reason,'tool_conflict');
  assert.equal(calls,0);
 } finally { delete globalThis.__webmcpAgentToolsRegistered; }
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const hostAt = (target, value) => Object.defineProperty(globalThis, target, { configurable: true, value: { modelContext: value } });

test('document.modelContext wins over a stale navigator.modelContext', () => {
 const seen = [];
 hostAt('navigator', { registerTool(t) { seen.push(`navigator:${t.name}`) } });
 hostAt('document', { registerTool(t) { seen.push(`document:${t.name}`) } });
 try {
  assert.equal(registerAgentTools([tool('spec_location')]).registered, true);
  assert.deepEqual(seen, ['document:spec_location']);
 } finally { hostAt('document', undefined) }
});
test('navigator.modelContext is still used when document has none', () => {
 const seen = [];
 hostAt('document', {});
 host({ registerTool(t) { seen.push(t.name) } });
 try {
  assert.equal(registerAgentTools([tool('legacy_location')]).registered, true);
  assert.deepEqual(seen, ['legacy_location']);
 } finally { hostAt('document', undefined) }
});
test('the sync API releases a reservation the host rejected, so a retry registers', async () => {
 let attempts = 0;
 host({ registerTool() { attempts += 1; return attempts === 1 ? Promise.reject(Error('Invalid tool name')) : Promise.resolve() } });
 assert.deepEqual(registerAgentTools([tool('rejected_once')]), { registered: false, reason: 'async_registration_pending' });
 await settle();
 assert.deepEqual(registerAgentTools([tool('rejected_once')]), { registered: false, reason: 'async_registration_pending' });
 assert.equal(attempts, 2);
 await settle();
 assert.deepEqual(registerAgentTools([tool('rejected_once')]), { registered: false, reason: 'already_registered' });
});
test('the sync API keeps the scope when only part of the set was rejected', async () => {
 host({ registerTool(t) { return t.name === 'part_bad' ? Promise.reject(Error('no')) : Promise.resolve() } });
 registerAgentTools([tool('part_good'), tool('part_bad')]);
 await settle();
 assert.deepEqual(registerAgentTools([tool('part_good'), tool('part_bad')]), { registered: false, reason: 'already_registered' });
 assert.equal(registerAgentTools([tool('part_bad')], { scope: 'retry-bad' }).reason, 'async_registration_pending');
});
test('a rejection after abort cannot release a remount\'s reservation', async () => {
 let reject; let calls = 0;
 host({ registerTool() { calls += 1; return calls === 1 ? new Promise((_, r) => reject = r) : Promise.resolve() } });
 const first = new AbortController();
 registerAgentTools([tool('remounted')], { signal: first.signal });
 first.abort();
 assert.equal(registerAgentTools([tool('remounted')]).reason, 'async_registration_pending');
 reject(Error('aborted')); await settle();
 assert.deepEqual(registerAgentTools([tool('remounted')]), { registered: false, reason: 'already_registered' });
 assert.equal(calls, 2);
});
test('a rejected bulk registration releases the host for a retry', async () => {
 let calls = 0;
 host({ provideContext() { calls += 1; return calls === 1 ? Promise.reject(Error('no')) : Promise.resolve() } });
 registerAgentTools([tool('bulk_retry')]);
 await settle();
 assert.equal(registerAgentTools([tool('bulk_retry')]).reason, 'async_registration_pending');
 assert.equal(calls, 2);
});
test('an abort while async registration is pending reports aborted, not unsupported', async () => {
 const { registerAgentToolsAsync } = await import('../dist/index.js');
 const controller = new AbortController();
 host({ registerTool(_t, options) { return new Promise((_, r) => options.signal.addEventListener('abort', () => r(options.signal.reason))) } });
 const pending = registerAgentToolsAsync([tool('abort_pending')], { signal: controller.signal });
 controller.abort();
 assert.deepEqual(await pending, { registered: false, reason: 'aborted' });
 host({ registerTool() {} });
 assert.equal((await registerAgentToolsAsync([tool('abort_pending')])).registered, true);
});
test('an abort after part of the set landed reports aborted and frees the names', async () => {
 const { registerAgentToolsAsync } = await import('../dist/index.js');
 const controller = new AbortController();
 const h = { registerTool(t, options) { if (t.name === 'abort_first') return Promise.resolve(); return new Promise((_, r) => options.signal.addEventListener('abort', () => r(options.signal.reason))) } };
 host(h);
 const pending = registerAgentToolsAsync([tool('abort_first'), tool('abort_second')], { signal: controller.signal });
 await settle(); controller.abort();
 assert.deepEqual(await pending, { registered: false, reason: 'aborted' });
 h.registerTool = () => undefined;
 assert.equal((await registerAgentToolsAsync([tool('abort_first'), tool('abort_second')])).registered, true);
});
test('a partial abort releases only its invocation on the same host, despite late settlement', async () => {
 const { registerAgentToolsAsync } = await import('../dist/index.js');
 let rejectLate;
 let pendingSecond = true;
 const calls = [];
 const sameHost = {
  registerTool(t) {
   calls.push(t.name);
   if (t.name === 'abort_two' && pendingSecond) {
    pendingSecond = false;
    return new Promise((_, reject) => { rejectLate = reject });
   }
   return Promise.resolve();
  },
 };
 host(sameHost);
 const controller = new AbortController();
 const aborted = registerAgentToolsAsync(
  [tool('abort_one'), tool('abort_two')],
  { signal: controller.signal, scope: 'aborted-scope' },
 );
 await settle();
 assert.deepEqual(await registerAgentToolsAsync([tool('other_owner')], { scope: 'other-scope' }), {
  registered: true, toolCount: 1, style: 'incremental',
 });
 controller.abort();
 assert.deepEqual(await registerAgentToolsAsync(
  [tool('abort_one'), tool('abort_two')],
  { scope: 'aborted-scope' },
 ), { registered: true, toolCount: 2, style: 'incremental' });
 rejectLate(Error('late abort rejection'));
 assert.deepEqual(await aborted, { registered: false, reason: 'aborted' });
 assert.equal((await registerAgentToolsAsync([tool('abort_one')], { scope: 'third-scope' })).reason, 'tool_conflict');
 assert.equal((await registerAgentToolsAsync([tool('other_owner')], { scope: 'other-scope' })).reason, 'already_registered');
 assert.deepEqual(calls, ['abort_one', 'abort_two', 'other_owner', 'abort_one', 'abort_two']);
});
test('a name the spec forbids is refused before the host is touched', async () => {
 const { registerAgentToolsAsync } = await import('../dist/index.js');
 let calls = 0; host({ registerTool() { calls += 1 } });
 assert.deepEqual(registerAgentTools([tool('fine_name'), tool('bad name!')]), { registered: false, reason: 'invalid_tool', toolName: 'bad name!' });
 assert.deepEqual(await registerAgentToolsAsync([tool('x'.repeat(129))]), { registered: false, reason: 'invalid_tool', toolName: 'x'.repeat(129) });
 assert.deepEqual(registerAgentTools([{ ...tool('blank_description'), description: '  ' }]), { registered: false, reason: 'invalid_tool', toolName: 'blank_description' });
 assert.deepEqual(registerAgentTools([{ ...tool('n'), name: 7 }]), { registered: false, reason: 'invalid_tool', toolName: '' });
 assert.equal(calls, 0);
 assert.equal(registerAgentTools([tool('fine_name'), tool('dotted.name-1')]).registered, true);
});
test('invalid tools are reported even where WebMCP is unsupported', () => {
 hostAt('document', undefined); host(undefined);
 assert.equal(registerAgentTools([tool('has space')]).reason, 'invalid_tool');
 assert.equal(registerAgentTools([tool('valid_but_no_host')]).reason, 'unsupported');
});
