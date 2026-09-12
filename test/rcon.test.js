import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePaperMetrics, RconSampler, summarise } from '../src/sampler.js';
import { DEFAULTS, loadConfig, publicConfig } from '../src/config.js';
import { toCsv, toMarkdown, write } from '../src/report.js';

// Paper 1.21.11 build 132 output observed on ReliableSite, 2026-09-12.
const TPS = 'TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0';
const MSPT = 'Server tick times (avg/min/max) from last 5s, 10s, 1m:\n◴ 0.3/0.0/6.0, 0.3/0.0/6.0, 0.3/0.0/6.0';

test('live Paper response excludes numeric window labels and preserves maximum', () => {
  assert.deepEqual(parsePaperMetrics(TPS, MSPT), { tps: 20, msptMean: 0.3, msptMin: 0, msptMax: 6 });
});
test('formatting, saturated TPS marker and different window values', () => {
  const tps = '\x1b[32m§aTPS from last 1m, 5m, 15m: §a*20.01, 19.0, 18.0\x1b[0m';
  const mspt = '§6Server tick times (avg/min/max) from last 5s, 10s, 1m:\n§e◴ 30.3/10.0/60.0, 5.0/1.0/8.0, 4.0/0.0/9.0';
  assert.deepEqual(parsePaperMetrics(tps, mspt), { tps: 20, msptMean: 30.3, msptMin: 10, msptMax: 60 });
});
test('errors, malformed windows and inconsistent min/mean/max do not become data', () => {
  for (const value of ['', 'Unknown command 1', 'Error 500', 'TPS from last 1m, 5m, 15m:',
    'TPS from last 1m, 5m, 15m: 999, 20, 20', 'TPS from last 1m, 5m, 15m: -1, 20, 20']) {
    assert.deepEqual(parsePaperMetrics(value, value), {});
  }
  assert.deepEqual(parsePaperMetrics('', MSPT.replace('0.3/0.0/6.0', '0.3/2.0/6.0')), {});
  assert.deepEqual(parsePaperMetrics(TPS, 'Unknown command 42'), { tps: 20 });
});
test('zero TPS and zero tick duration are valid', () => {
  assert.deepEqual(parsePaperMetrics(TPS.replaceAll('20.0', '0.0'), MSPT.replaceAll('0.3', '0.0').replaceAll('6.0', '0.0')),
    { tps: 0, msptMean: 0, msptMin: 0, msptMax: 0 });
});
test('summary separates metric coverage and does not invent tick percentiles', () => {
  const result = summarise([
    { t: 0, tps: 1, msptMean: 999, msptMax: 999 },
    { t: 2, tps: 20, msptMean: 10, msptMax: 60 },
    { t: 3, tps: 18 },
    { t: 4, msptMean: 20, msptMax: 90 },
  ], 1, 5);
  assert.deepEqual(result, { samples: 3, tpsSamples: 2, msptSamples: 2,
    tps: { mean: 19, min: 18, p5: 18, p50: 20 }, mspt: { mean: 15, max: 90 } });
  assert.equal(summarise([], 0, 1).mspt, null);
});
test('slow polling cannot overlap; stop drains the pending request', async () => {
  const sampler = new RconSampler({});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  sampler._rcon = {
    async send(command) { calls.push(command); if (command === 'tps') { await gate; return TPS; } return MSPT; },
    async end() { calls.push('end'); },
  };
  const first = sampler._poll();
  await sampler._poll();
  const stopped = sampler.stop();
  assert.deepEqual(calls, ['tps']);
  release(); await first; await stopped;
  assert.deepEqual(calls, ['tps', 'mspt', 'end']);
  assert.equal(sampler.samples.length, 1);
  await sampler._poll(); assert.equal(sampler.samples.length, 1);
});
test('failed RCON commands produce no synthetic measurement', async () => {
  const sampler = new RconSampler({});
  sampler._rcon = { async send() { throw new Error('connection lost'); } };
  await sampler._poll(); assert.deepEqual(sampler.samples, []);
  sampler._rcon = { async send(command) { if (command === 'tps') return TPS; throw new Error('no mspt'); } };
  await sampler._poll(); assert.equal(sampler.samples[0].tps, 20);
  assert.equal(sampler.samples[0].msptMean, undefined);
});
test('file configuration keeps numerical metadata and RCON strings intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mctickrate-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ sampling: { method: 'rcon', rcon: { password: 'fixture-secret' } },
      output: { metadata: { planRamGb: 4, planCpuPercent: 200 } } }));
    const cfg = loadConfig(['--config=' + path]);
    assert.equal(cfg.sampling.rcon.password, 'fixture-secret');
    assert.equal(cfg.output.metadata.planRamGb, 4); assert.equal(cfg.output.metadata.planCpuPercent, 200);
    assert.equal(publicConfig(cfg).sampling.rcon.password, '[REDACTED]');
    assert.equal(cfg.sampling.rcon.password, 'fixture-secret');
  } finally { rmSync(dir, { recursive: true }); }
});
test('JSON, CSV and markdown expose maxima and metric counts without credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mctickrate-report-'));
  try {
    const cfg = structuredClone(DEFAULTS); cfg.sampling.method = 'rcon';
    cfg.sampling.rcon.password = 'fixture-secret'; cfg.output.dir = dir;
    cfg.output.formats = ['json', 'csv', 'markdown'];
    const step = { target: 1, joined: 1, moving: 1, ...summarise([{ t: 1, ...parsePaperMetrics(TPS, MSPT) }], 0, 2) };
    const result = { startedAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T00:01:00Z', config: cfg, steps: [step] };
    for (const path of write(result, cfg)) assert.ok(!readFileSync(path, 'utf8').includes('fixture-secret'));
    assert.match(toCsv(result), /mspt_max,samples,tps_samples,mspt_samples/);
    assert.ok(!toCsv(result).includes('mspt_p95'));
    assert.match(toMarkdown(result), /MSPT max/); assert.match(toMarkdown(result), /1 \/ 1/);
    assert.equal(cfg.sampling.rcon.password, 'fixture-secret');
  } finally { rmSync(dir, { recursive: true }); }
});

test('actual RCON wire response strips every Paper formatting code', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/paper-1.21.11-rcon.json', import.meta.url), 'utf8'));
  assert.deepEqual(parsePaperMetrics(fixture.tps, fixture.mspt), fixture.parsed);
});
