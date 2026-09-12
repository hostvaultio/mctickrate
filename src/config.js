import { readFileSync } from 'node:fs';

/**
 * Everything is configurable and nothing is host-specific. The defaults are
 * chosen to produce a *conservative* number: bots that move, spread out, and
 * are given time to settle before sampling. A benchmark that flatters the
 * server under test is worthless.
 */
export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 25565,
    version: false,          // false = auto-negotiate from the server
    auth: 'offline',         // online-mode servers need real accounts; out of scope
  },

  // Player counts to walk through, in order. Each is held for holdSeconds
  // while samples are taken.
  ramp: [1, 5, 10, 15, 20],
  holdSeconds: 180,
  settleSeconds: 30,         // discard samples for this long after a step change

  bots: {
    usernamePrefix: 'bench',
    joinStaggerMs: 2000,     // joining 20 bots at once is its own load spike
    // Movement is what actually costs the server. A stationary bot holds a
    // few chunks resident and costs almost nothing; a walking one forces
    // continuous chunk load/unload, which is the expensive path.
    move: true,
    turnIntervalMs: 5000,    // re-randomise heading this often
    jumpChance: 0.15,        // helps unstick bots on terrain
    spreadRadius: 500,       // metres bots try to disperse across; 0 = huddle
  },

  sampling: {
    // 'time'  — derive TPS from the server's time-sync packet interval.
    //           Works against ANY server with zero server-side setup, which
    //           is what makes cross-host comparison possible. No MSPT.
    // 'rcon'  — ask the server directly. Accurate, gives MSPT, needs RCON
    //           enabled and credentials.
    method: 'time',
    intervalMs: 5000,        // rcon poll interval; ignored for 'time'
    rcon: { host: null, port: 25575, password: null },
  },

  output: {
    dir: './results',
    formats: ['json', 'markdown'],
    // Echoed verbatim into the report. Publishing a benchmark without this is
    // publishing an anecdote — record what you tested so somebody can repeat it.
    metadata: {
      label: '',
      serverSoftware: '',
      serverVersion: '',
      javaVersion: '',
      planRamGb: null,
      planCpuPercent: null,
      hardware: '',
      notes: '',
    },
  },
};

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (base === null || Array.isArray(base) || typeof base !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** CLI: --server.host=x --ramp=1,5,10 --holdSeconds=60 */
function applyCliOverrides(cfg, argv) {
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) continue;
    const [rawKey, rawVal] = arg.slice(2).split(/=(.*)/s);
    if (rawKey === 'config') continue;
    let val = rawVal;
    if (rawKey === 'ramp') val = rawVal.split(',').map((n) => parseInt(n, 10));
    else if (/^\d+$/.test(rawVal)) val = parseInt(rawVal, 10);
    else if (/^\d*\.\d+$/.test(rawVal)) val = parseFloat(rawVal);
    else if (rawVal === 'true' || rawVal === 'false') val = rawVal === 'true';

    const path = rawKey.split('.');
    let node = cfg;
    for (const seg of path.slice(0, -1)) {
      if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
      node = node[seg];
    }
    node[path.at(-1)] = val;
  }
  return cfg;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const fileArg = argv.find((a) => a.startsWith('--config='));
  let cfg = structuredClone(DEFAULTS);
  if (fileArg) {
    const path = fileArg.split('=')[1];
    cfg = deepMerge(cfg, JSON.parse(readFileSync(path, 'utf8')));
  }
  cfg = applyCliOverrides(cfg, argv);
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errs = [];
  if (!cfg.server.host) errs.push('server.host is required');
  if (!Array.isArray(cfg.ramp) || cfg.ramp.length === 0) errs.push('ramp must be a non-empty array');
  if (cfg.ramp.some((n) => !Number.isInteger(n) || n < 1)) errs.push('ramp entries must be positive integers');
  if (![...cfg.ramp].every((n, i, a) => i === 0 || n >= a[i - 1])) {
    errs.push('ramp must be non-decreasing — the harness adds bots between steps, it never removes them');
  }
  if (!['time', 'rcon'].includes(cfg.sampling.method)) errs.push("sampling.method must be 'time' or 'rcon'");
  if (cfg.sampling.method === 'rcon' && !cfg.sampling.rcon.password) {
    errs.push('sampling.method=rcon requires sampling.rcon.password');
  }
  if (!Number.isFinite(cfg.sampling.intervalMs) || cfg.sampling.intervalMs < 1) errs.push('sampling.intervalMs must be a positive number');
  if (cfg.settleSeconds >= cfg.holdSeconds) errs.push('settleSeconds must be less than holdSeconds');
  if (errs.length) throw new Error(`Invalid config:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

/** Reports and dry runs may be shared; never include the RCON credential. */
export function publicConfig(cfg) {
  const copy = structuredClone(cfg);
  if (copy.sampling?.rcon?.password) copy.sampling.rcon.password = '[REDACTED]';
  return copy;
}
