import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseServerPositions, ServerMovementTracker, ServerWorkloadObserver, POSITION_COMMAND } from '../src/server-workload.js';
import { assessWorkload } from '../src/workload.js';
import { DEFAULTS, validate } from '../src/config.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/paper-1.21.11-positions.json',import.meta.url)));

test('actual Paper concatenated response yields all 20 requested player positions',()=>{
 const positions=parseServerPositions(fixture.response,fixture.names);
 assert.equal(positions.length,20);assert.deepEqual(positions[0],{name:'load1',x:29.532874650241162,y:122,z:3.508046297981935});
 assert.deepEqual(parseServerPositions(fixture.response,['load20']),[positions.at(-1)]);
});
test('truncated, denied, missing, duplicated and non-finite positions fail closed',()=>{
 for(const response of [fixture.response.slice(0,-4),'No entity was found','Unknown command',fixture.response+fixture.response,
  'load1 has the following entity data: [1e999d, 64.0d, 0.0d]']){
  assert.throws(()=>parseServerPositions(response,fixture.names));
 }
 assert.throws(()=>parseServerPositions(fixture.response,['missing']));
 assert.throws(()=>parseServerPositions(fixture.response,['load1','load1']));
});
test('signed, exponent and formatting variants remain strictly scoped to positions',()=>{
 assert.deepEqual(parseServerPositions('§aload1 has the following entity data: [-1.2E2d, +64.0d, .25d]\n',['load1']),[{name:'load1',x:-120,y:64,z:0.25}]);
});
test('server movement needs horizontal progress and cannot bridge missing observations',()=>{
 const tracker=new ServerMovementTracker(6000);
 const p=(x,y=64)=>[{name:'load1',x,y,z:0}];
 assert.equal(tracker.observe(p(0),0),0);assert.equal(tracker.observe(p(0,80),5000),0);
 assert.equal(tracker.observe(p(4),10000),1);assert.equal(tracker.observe(p(4),15000),1);
 assert.equal(tracker.observe(p(4),20000),0);
 tracker.observe([],25000);assert.equal(tracker.observe(p(100),30000),0);
 assert.equal(tracker.observe(p(120),50000),0);
});
function observer(){
 let now=0;
 const swarm={bots:[{username:'load1',_alive:true,entity:{position:{x:999,y:64,z:999}},_corrections:90}],get population(){return this.bots.filter(b=>b._alive).length;},movingCount:()=>1};
 const result=new ServerWorkloadObserver(DEFAULTS,swarm,()=>now);
 return {result,swarm,time:n=>{now=n;}};
}
test('client prediction never supplies RCON positions or movement',async()=>{
 const {result,time}=observer();let x=0;
 result.rcon={async send(command){assert.equal(command,POSITION_COMMAND);return `load1 has the following entity data: [${x}.0d, 64.0d, 0.0d]`;}};
 const first=await result.observe();assert.equal(first.positions[0].x,0);assert.equal(first.client.positions[0].x,999);assert.equal(first.moving,0);
 time(5000);assert.equal((await result.observe()).moving,0);
 x=5;time(10000);assert.equal((await result.observe()).moving,1);
});
test('failed/slow reads are retained as invalid observations, without raw exception text',async()=>{
 const {result,time}=observer();result.rcon={async send(){throw Error('private input must not be retained');}};
 const failed=await result.observe();assert.equal(failed.error,'server_position_read_failed');assert.deepEqual(failed.positions,[]);
 result.rcon.send=async()=>{time(2001);return fixture.response;};
 assert.equal((await result.observe()).error,'server_position_read_too_slow');
});
test('overlapping reads share a single query and stop drains it before closing',async()=>{
 const {result}=observer();let resolve,sent=0,ended=0;
 result.rcon={send(){sent++;return new Promise(r=>{resolve=r;});},async end(){ended++;}};
 const a=result.observe(),b=result.observe(),stop=result.stop();
 assert.equal(sent,1);assert.equal(ended,0);resolve(fixture.response);
 assert.deepEqual(await a,await b);await stop;assert.equal(ended,1);assert.equal(await result.observe(),null);
});
test('a disconnect during the query invalidates the observation',async()=>{
 const {result,swarm}=observer();result.rcon={async send(){swarm.bots[0]._alive=false;return fixture.response;}};
 assert.equal((await result.observe()).error,'population_changed_during_read');
});
test('corrected client traces cannot qualify; server traces may prove real travel',()=>{
 const rows=Array.from({length:25},(_,i)=>({t:i*5000,positionSource:'client',joined:1,moving:1,
  positions:[{name:'load1',x:i*5,y:64,z:0,corrections:i}]}));
 assert.ok(assessWorkload(rows,0,120000,1).reasons.includes('server_corrected_client_movement'));
 const server=rows.map(r=>({...r,positionSource:'server',client:r}));
 assert.equal(assessWorkload(server,0,120000,1,true,'server').valid,true);
 assert.equal(assessWorkload(rows,0,120000,1,true,'server').valid,false);
 server[10].error='server_position_read_failed';assert.equal(assessWorkload(server,0,120000,1,true,'server').valid,false);
});
test('unknown correction counters and incomplete per-observation trajectories cannot qualify',()=>{
 const rows=Array.from({length:25},(_,i)=>({t:i*5000,positionSource:'client',joined:1,moving:1,positions:[{name:'load1',x:i*5,y:64,z:0}]}));
 assert.ok(assessWorkload(rows,0,120000,1).reasons.includes('missing_correction_observations'));
 const server=rows.map(r=>({...r,positionSource:'server'}));server[12].positions=[];
 assert.ok(assessWorkload(server,0,120000,1,true,'server').reasons.includes('incomplete_positions'));
});

test('non-finite or invalid timing cannot create an unbounded observation loop',()=>{
 for(const [key,values] of [['holdSeconds',[0,-1,NaN,Infinity]],['settleSeconds',[-1,NaN,Infinity]]]){
  for(const value of values){const cfg=structuredClone(DEFAULTS);cfg[key]=value;assert.throws(()=>validate(cfg));}
 }
 for(const value of [0,-1,NaN,Infinity]){const cfg=structuredClone(DEFAULTS);cfg.bots.turnIntervalMs=value;assert.throws(()=>validate(cfg));}
});
