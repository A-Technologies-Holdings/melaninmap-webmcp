import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
for (const cardPath of ['../reference/HandoffConsentCard.tsx']) {
 test(`${cardPath}: only a trusted current request opens a hand-off; rejected resolution closes it`, () => {
  const card = readFileSync(new URL(cardPath, import.meta.url), 'utf8');
  const start = card.indexOf('function confirm(');
  const end = card.indexOf('export default function', start);
  assert.ok(start >= 0 && end > start);
  const compiledConfirm = ts.transpileModule(card.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const request = {targetName:'Displayed'};
  let pending = request, opens = 0, closes = 0, resolutions = 0, accepted = true;
  const handle = {opener:{},close(){closes++}};
  const confirm = new Function('getPendingConsentRequest', 'resolvePendingConsentRequest', 'window', 'CONSENT_TOKEN', `${compiledConfirm}; return confirm;`)(
   () => pending,
   (answer, displayed) => {resolutions++; assert.equal(displayed, request); assert.equal(answer.status,'confirmed'); return accepted},
   {open(){opens++; return handle}}, 'test-proof',
  );
  confirm(request,{nativeEvent:{isTrusted:false}});
  pending = {targetName:'Replacement'};
  confirm(request,{nativeEvent:{isTrusted:true}});
  assert.equal(opens,0); assert.equal(resolutions,0);
  pending = request;
  confirm(request,{nativeEvent:{isTrusted:true}});
  assert.equal(opens,1); assert.equal(handle.opener,null); assert.equal(closes,0);
  accepted = false;
  confirm(request,{nativeEvent:{isTrusted:true}});
  assert.equal(opens,2); assert.equal(resolutions,2); assert.equal(closes,1);
 });
}

test('reference bridge ignores a delayed timeout and stale answer after replacement', async () => {
 const source = readFileSync(new URL('../reference/consentBridge.ts', import.meta.url), 'utf8');
 const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod = {exports:{}}, callbacks = [];
 new Function('module','exports','crypto','setTimeout','clearTimeout',compiled)(mod,mod.exports,{randomUUID:()=>`id-${callbacks.length}`},callback=>{callbacks.push(callback);return callbacks.length},()=>{});
 const bridge = mod.exports;
 const first = {targetName:'First'}, second = {targetName:'Second'};
 const firstAnswer = bridge.requestHandoffConsent(first);
 bridge.resolvePendingConsentRequest({status:'declined'},first);
 assert.equal((await firstAnswer).status,'declined');
 const secondAnswer = bridge.requestHandoffConsent(second);
 callbacks[0]();
 assert.equal(bridge.getPendingConsentRequest(),second);
 assert.equal(bridge.resolvePendingConsentRequest({status:'confirmed',consentToken:'proof',navigationHandle:null},first),false);
 bridge.resolvePendingConsentRequest({status:'declined'},second);
 assert.equal((await secondAnswer).status,'declined');
});
