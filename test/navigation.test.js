import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TerrainNavigator } from '../src/navigation.js';

const position = (x, z) => ({ x, y: 64, z, clone() { return position(this.x, this.z); },
  distanceTo(p) { return Math.hypot(this.x - p.x, this.z - p.z); } });
function fixture(t) {
  const bot = new EventEmitter();
  bot.entity = { position: position(0, 0) };
  bot.loadPlugin = () => {};
  const goals = [];
  bot.pathfinder = { setMovements(m) { this.movements = m; }, setGoal(g) { goals.push(g); } };
  const api = { pathfinder() {}, Movements: class {}, goals: { GoalXZ: class { constructor(x, z) { this.x = x; this.z = z; } } } };
  let now = 0;
  const navigator = new TerrainNavigator(bot, { spreadRadius: 500 }, api, () => 0.5, () => now);
  t.after(() => navigator.stop());
  return { bot, goals, navigator, time: value => { now = value; } };
}

test('terrain policy cannot dig, build towers, place scaffolding or sprint', t => {
  const { bot, navigator, goals } = fixture(t); navigator.start();
  assert.deepEqual({ ...bot.pathfinder.movements }, { canDig: false, allow1by1towers: false, scafoldingBlocks: [], allowSprinting: false, maxDropDown: 3 });
  assert.equal(bot.pathfinder.tickTimeout, 5); assert.equal(bot.pathfinder.searchRadius, 40);
  assert.equal(goals.length, 1); assert.ok(Math.hypot(goals[0].x, goals[0].z) <= 17);
});
test('unreachable waypoints choose an alternate route on the next bounded tick', t => {
  const { bot, navigator, goals } = fixture(t); navigator.start(); const first = goals[0];
  bot.emit('path_update', { status: 'noPath' });
  assert.equal(goals.length, 1); navigator.tick();
  assert.equal(goals.length, 2); assert.notDeepEqual(goals[1], first);
});
test('stalled motion triggers route recovery even without a path error', t => {
  const { navigator, goals, time } = fixture(t); navigator.start();
  time(9000); navigator.tick(); assert.equal(goals.length, 2);
  time(9500); navigator.tick(); assert.equal(goals.length, 2);
});
test('genuine progress prevents premature replanning; reached goals keep travel going', t => {
  const { bot, navigator, goals, time } = fixture(t); navigator.start();
  time(9000); bot.entity.position = position(4, 0); navigator.tick(); assert.equal(goals.length, 1);
  bot.emit('goal_reached'); navigator.tick(); assert.equal(goals.length, 2);
});
test('stop is idempotent and cannot resume movement after disconnect', t => {
  const { bot, navigator, goals } = fixture(t); navigator.start(); navigator.start();
  assert.equal(bot.listenerCount('path_update'), 1);
  navigator.stop(); navigator.stop(); const count = goals.length;
  bot.emit('path_update', { status: 'noPath' }); navigator.tick();
  assert.equal(goals.length, count); assert.equal(goals.at(-1), null);
  assert.equal(bot.listenerCount('goal_reached'), 0); assert.equal(bot.listenerCount('path_update'), 0);
});

test('repeated unreachable routes continue exploring distinct bearings', t => {
  const { bot, navigator, goals } = fixture(t); navigator.start();
  for(let i=0;i<12;i++){bot.emit('path_update',{status:'noPath'});navigator.tick();}
  assert.ok(new Set(goals.map(g=>`${g.x},${g.z}`)).size >= 10);
  assert.ok(Math.hypot(goals.at(-1).x,goals.at(-1).z)<4);
});

test('client contact clearance is restricted to the verified protocol version', t => {
  const a=fixture(t);a.bot.version='1.21.11';a.bot.physics={playerHalfWidth:0.3,playerHeight:1.8};a.navigator.start();
  assert.equal(a.bot.physics.playerHalfWidth,0.30001);assert.equal(a.bot.physics.playerHeight,1.80001);
  const b=fixture(t);b.bot.version='1.20.6';b.bot.physics={playerHalfWidth:0.3,playerHeight:1.8};b.navigator.start();
  assert.equal(b.bot.physics.playerHalfWidth,0.3);assert.equal(b.bot.physics.playerHeight,1.8);
});
