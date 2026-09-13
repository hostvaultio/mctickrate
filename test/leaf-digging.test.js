import test from 'node:test';
import assert from 'node:assert/strict';
import {restrictLeafDigging} from '../src/leaf-digging.js';
const leaf=()=>({name:'spruce_leaves',position:{x:1,y:2,z:3}});
test('successful removal records the original type even when block object becomes air',async()=>{
 const block=leaf();const bot={blockAt:()=>block,async dig(b){b.name='air';}};
 const restore=restrictLeafDigging(bot);await bot.dig(block);restore();
 assert.equal(bot._digEvents[0].name,'spruce_leaves');assert.equal(bot._digEvents[0].after,'air');assert.equal(bot._digEvents[0].completed,true);
});
test('a planned leaf replaced by stone is rejected before any dig command',async()=>{
 let sent=0;const bot={blockAt:()=>({...leaf(),name:'stone'}),async dig(){sent++;}};
 restrictLeafDigging(bot);await assert.rejects(bot.dig(leaf()),/refuses/);assert.equal(sent,0);
});
test('unknown blocks are refused and a failed removal is not successful evidence',async()=>{
 const bot={blockAt:()=>null,async dig(){throw Error('cancelled');}};restrictLeafDigging(bot);
 await assert.rejects(bot.dig(leaf()),/refuses/);bot.blockAt=()=>leaf();await assert.rejects(bot.dig(leaf()),/cancelled/);assert.equal(bot._digEvents[0].completed,false);
});
test('restoring the method is idempotent and preserves later owners',()=>{
 const original=()=>{};const bot={dig:original};const restore=restrictLeafDigging(bot);restore();restore();assert.equal(bot.dig,original);
 const restoreAgain=restrictLeafDigging(bot);const other=()=>{};bot.dig=other;restoreAgain();assert.equal(bot.dig,other);
});

test('leaf removal defaults off and non-boolean file values cannot enable it',async()=>{
 const {loadConfig,DEFAULTS,validate}=await import('../src/config.js');
 assert.equal(loadConfig([]).bots.allowLeafDigging,false);
 assert.equal(loadConfig(['--bots.allowLeafDigging=true']).bots.allowLeafDigging,true);
 for(const value of ['false','true',1,null]){
  const cfg=structuredClone(DEFAULTS);cfg.bots.allowLeafDigging=value;
  assert.throws(()=>validate(cfg),/allowLeafDigging must be boolean/);
 }
});
