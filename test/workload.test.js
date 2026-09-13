import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkload } from '../src/workload.js';
import { headline, toCsv, toMarkdown } from '../src/report.js';
import { DEFAULTS } from '../src/config.js';

function observations() {
  return Array.from({ length: 25 }, (_, i) => ({ t: i * 5000, positionSource: 'client', joined: 5, moving: 5,
    positions: Array.from({ length: 5 }, (_, n) => ({ name: `bot${n}`, corrections: 0, x: n * 30 + i * 5, y: 64, z: n * 50 })) }));
}
const qualify = rows => assessWorkload(rows, 0, 120000, 5);

test('sustained population, movement and travel qualify the workload', () => {
  const result = qualify(observations());
  assert.equal(result.valid, true); assert.equal(result.minMoving, 5);
  assert.equal(result.travel.length, 5); assert.equal(result.travel[0].spanBlocks, 120);
});
test('one stalled observation is enough to invalidate a capacity inference', () => {
  const rows = observations(); rows[12].moving = 3;
  assert.equal(qualify(rows).valid, false);
  assert.ok(qualify(rows).reasons.includes('insufficient_movement'));
});
test('disconnected clients cannot retain the pre-measurement joined count', () => {
  const rows = observations(); rows[12].joined = 4; rows[12].moving = 4;
  assert.ok(qualify(rows).reasons.includes('incomplete_population'));
});
test('oscillation around an obstacle does not count as travelling load', () => {
  const rows = observations();
  for (const row of rows) row.positions = row.positions.map(p => ({ ...p, x: (row.t / 5000) % 2 ? 3 : 0, z: 0 }));
  assert.ok(qualify(rows).reasons.includes('insufficient_travel'));
});
test('empty, duplicated and clustered observations cannot qualify', () => {
  for (const rows of [[], [...observations(), ...observations()], observations().filter(r => r.t < 110000),
    observations().map((r, i) => ({ ...r, t: i * 1000 }))]) {
    assert.equal(qualify(rows).valid, false);
    assert.ok(qualify(rows).reasons.includes('insufficient_workload_observations'));
  }
});
test('movement off, missing trajectories and impossible counts fail closed', () => {
  assert.equal(assessWorkload(observations(), 0, 120000, 5, false).valid, false);
  assert.equal(qualify(observations().map(r => ({ ...r, positions: [] }))).valid, false);
  assert.equal(qualify(observations().map(r => ({ ...r, moving: 6 }))).valid, false);
});
test('good final movement does not conceal an earlier understated window', () => {
  const rows = observations(); rows[1].moving = 1;
  const step = { target: 5, joined: 5, moving: 5, workload: qualify(rows), tps: { p5: 20 } };
  assert.match(headline([step]), /Workload unverified/);
  assert.doesNotMatch(headline([step]), /ceiling is above|test higher/);
});
test('legacy records without workload evidence cannot claim capacity', () => {
  assert.match(headline([{ target: 20, joined: 20, moving: 20, tps: { p5: 20 } }]), /Workload unverified/);
});
test('every report format retains the invalid workload result', () => {
  const rows = observations(); rows[2].moving = 2;
  const step = { target: 5, joined: 5, moving: 5, workload: qualify(rows), tps: { mean: 20, p5: 20, min: 20 } };
  const result = { config: DEFAULTS, steps: [step], headline: headline([step]) };
  assert.match(toMarkdown(result), /UNVERIFIED/);
  assert.match(toCsv(result), /workload_valid,min_joined,min_moving/);
  assert.match(toCsv(result), /false,5,2/);
});

test('missing timing at any measured step cannot be silently skipped', () => {
  const valid = { target: 5, workload: { valid: true }, tps: { p5: 20 } };
  assert.match(headline([valid, { ...valid, target: 10, tps: { p5: null } }]), /Incomplete TPS/);
});
test('invalid windows and populations never qualify', () => {
  for (const args of [[0,0,5], [120000,0,5], [0,120000,0], [0,120000,1.5]]) {
    assert.equal(assessWorkload(observations(), ...args).valid, false);
  }
});
