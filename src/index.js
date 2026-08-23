#!/usr/bin/env node
import { loadConfig, DEFAULTS } from './config.js';
import { createSampler, summarise } from './sampler.js';
import { Swarm } from './swarm.js';
import { write, headline, CAVEATS } from './report.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const HELP = `
mctickrate — measure how many players a Minecraft server can actually hold.

  mctickrate --config=my.json
  mctickrate --server.host=play.example.com --ramp=1,5,10,20 --holdSeconds=120

Options (any config key works as --dotted.path=value):
  --config=FILE            JSON config; CLI flags override it
  --server.host, --server.port
  --ramp=1,5,10,20         player counts to step through
  --holdSeconds=180        time at each step
  --settleSeconds=30       samples discarded after each step change
  --sampling.method=time   'time' (no server setup) or 'rcon' (needs RCON)
  --bots.move=false        disable movement (understates load — see README)
  --dry-run                print the resolved config and exit
  --help

Only run this against servers you own or have explicit permission to test.
It generates real load and looks like a bot swarm to any operator watching.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { log(HELP); return; }

  let cfg;
  try {
    cfg = loadConfig(argv);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--dry-run')) {
    log(JSON.stringify(cfg, null, 2));
    return;
  }

  log(`\nmctickrate → ${cfg.server.host}:${cfg.server.port}`);
  log(`ramp ${cfg.ramp.join(' → ')} | hold ${cfg.holdSeconds}s (settle ${cfg.settleSeconds}s) | sampling '${cfg.sampling.method}'`);
  if (!cfg.bots.move) log('WARNING: bots.move=false — stationary bots massively understate real load.');

  const sampler = createSampler(cfg);
  const swarm = new Swarm(cfg, log);
  const startedAt = new Date().toISOString();
  const steps = [];
  let interrupted = false;

  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await sampler.start();

    for (const target of cfg.ramp) {
      if (interrupted) break;
      log(`\n─ ${target} players ─`);
      await swarm.growTo(target, (firstBot) => sampler.attach(firstBot));

      const joined = swarm.population;
      if (joined < target) log(`  ! only ${joined}/${target} connected`);

      log(`  settling ${cfg.settleSeconds}s…`);
      await sleep(cfg.settleSeconds * 1000);

      const from = Date.now();
      const holdMs = (cfg.holdSeconds - cfg.settleSeconds) * 1000;
      await sleep(holdMs);
      const to = Date.now();

      const moving = swarm.movingCount();
      const summary = summarise(sampler.samples, from, to);
      const step = { target, joined, moving, ...summary };
      steps.push(step);

      log(`  TPS mean ${summary.tps.mean ?? '—'} | p5 ${summary.tps.p5 ?? '—'} | min ${summary.tps.min ?? '—'}`
        + (summary.mspt ? ` | MSPT ${summary.mspt.mean}ms (p95 ${summary.mspt.p95}ms)` : '')
        + ` | ${summary.samples} samples | ${moving}/${joined} moving`);

      if (moving < joined * 0.5 && cfg.bots.move) {
        log('  ! fewer than half the bots are displacing — they may be stuck. Load is understated.');
      }
      if (summary.samples === 0) {
        log("  ! no samples in window. With method='time', check the server sends time updates.");
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await swarm.shutdown();
    await sampler.stop();
  }

  if (!steps.length) { log('\nNo steps completed.'); process.exitCode = 1; return; }

  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    interrupted,
    metadata: cfg.output.metadata,
    config: cfg,
    steps,
    headline: headline(steps),
    caveats: CAVEATS,
  };

  const files = write(result, cfg);
  log(`\n${result.headline}`);
  for (const f of files) log(`  wrote ${f}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
