/**
 * TPS/MSPT sampling.
 *
 * Two methods, and the choice matters for what you can compare:
 *
 *   'time'  A vanilla server sends a time-sync packet every 20 ticks. At a
 *           healthy 20 TPS those arrive 1s apart; at 10 TPS, 2s apart. So
 *           TPS = 20 / interval. This needs NOTHING enabled on the server,
 *           which is the whole point — it works against a host you do not
 *           control, so results are comparable across providers.
 *           It cannot see MSPT, and it is a coarse 20-tick average.
 *
 *   'rcon'  Ask Paper directly (/tps, /mspt). Accurate, gives the tick-time
 *           window averages and maxima, but requires RCON
 *           enabled — so it only works on servers you administer.
 */

export class TimePacketSampler {
  constructor() {
    this.samples = [];
    this._last = null;
    this._attached = false;
  }

  /** Attach to one bot only — every client receives the same packet. */
  attach(bot) {
    if (this._attached) return;
    this._attached = true;
    bot._client.on('update_time', () => {
      const now = process.hrtime.bigint();
      if (this._last !== null) {
        const seconds = Number(now - this._last) / 1e9;
        // 20 ticks per time packet. Guard against absurd values from a
        // reconnect or a stalled server resuming.
        if (seconds > 0.05 && seconds < 60) {
          this.samples.push({ t: Date.now(), tps: Math.min(20, 20 / seconds) });
        }
      }
      this._last = now;
    });
    bot.on('end', () => { this._last = null; });
  }

  detachable() { return true; }
  supportsMspt() { return false; }
  async start() {}
  async stop() {}
}

/** Parse only the documented Paper windows, never numbers from a header/error. */
export function parsePaperMetrics(tpsRaw, msptRaw) {
  const clean = (value) => String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '').trim();
  const number = '(\\d+(?:\\.\\d+)?)';
  const tpsMatch = clean(tpsRaw).match(new RegExp(
    '^TPS from last 1m,\\s*5m,\\s*15m:\\s*\\*?' + number
      + ',\\s*\\*?' + number + ',\\s*\\*?' + number + '$', 'i'));
  const result = {};
  if (tpsMatch) {
    const values = tpsMatch.slice(1).map(Number);
    if (values.every((n) => Number.isFinite(n) && n >= 0 && n <= 21)) result.tps = Math.min(20, values[0]);
  }
  const triple = number + '/' + number + '/' + number;
  const msptMatch = clean(msptRaw).match(new RegExp(
    '^Server tick times \\(avg/min/max\\) from last 5s,\\s*10s,\\s*1m:\\s*(?:◴\\s*)?'
      + triple + ',\\s*' + triple + ',\\s*' + triple + '$', 'i'));
  if (msptMatch) {
    const values = msptMatch.slice(1).map(Number);
    const valid = values.every(Number.isFinite) && [0, 3, 6].every((i) =>
      values[i + 1] <= values[i] && values[i] <= values[i + 2]);
    if (valid) [result.msptMean, result.msptMin, result.msptMax] = values.slice(0, 3);
  }
  return result;
}

export class RconSampler {
  constructor({ host, port, password, intervalMs }) {
    this.opts = { host, port, password };
    this.intervalMs = intervalMs;
    this.samples = [];
    this._timer = null;
    this._rcon = null;
    this._pending = null;
    this._stopping = false;
  }

  attach() {}
  supportsMspt() { return true; }

  async start() {
    const { Rcon } = await import('rcon-client');
    this._rcon = await Rcon.connect({
      host: this.opts.host,
      port: this.opts.port,
      password: this.opts.password,
    });
    this._timer = setInterval(() => this._poll(), this.intervalMs);
  }

  async _poll() {
    if (this._pending || this._stopping) return;
    this._pending = this._read();
    try { await this._pending; } finally { this._pending = null; }
  }

  async _read() {
    try {
      // Sequential requests keep response association explicit on one RCON socket.
      const tpsRaw = await this._rcon.send('tps');
      const msptRaw = await this._rcon.send('mspt').catch(() => '');
      const values = parsePaperMetrics(tpsRaw, msptRaw);
      if (Object.keys(values).length) this.samples.push({ t: Date.now(), ...values });
    } catch {
      /* a failed poll is not a sample; reports expose each metric's sample count */
    }
  }

  async stop() {
    this._stopping = true;
    if (this._timer) clearInterval(this._timer);
    if (this._pending) await this._pending;
    if (this._rcon) { try { await this._rcon.end(); } catch { /* already gone */ } }
  }
}

export function createSampler(cfg) {
  if (cfg.sampling.method === 'rcon') {
    const r = cfg.sampling.rcon;
    return new RconSampler({
      host: r.host || cfg.server.host,
      port: r.port,
      password: r.password,
      intervalMs: cfg.sampling.intervalMs,
    });
  }
  return new TimePacketSampler();
}

/** Percentile over a sorted-on-demand copy. q in [0,1]. */
function pct(values, q) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * q))];
}

/**
 * Reduce raw samples in [from, to] to the shape a reader needs.
 * TPS percentiles are over the observed samples. RCON MSPT is a summary
 * of rolling five-second windows, not a per-tick distribution.
 */
export function summarise(samples, from, to) {
  const win = samples.filter((s) => s.t >= from && s.t <= to);
  const tps = win.map((s) => s.tps).filter(Number.isFinite);
  const msptMean = win.map((s) => s.msptMean).filter(Number.isFinite);
  const msptMax = win.map((s) => s.msptMax).filter(Number.isFinite);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

  return {
    samples: win.length,
    tpsSamples: tps.length,
    msptSamples: msptMean.length,
    tps: {
      mean: round(mean(tps)),
      min: tps.length ? round(Math.min(...tps)) : null,
      p5: round(pct(tps, 0.05)),
      p50: round(pct(tps, 0.5)),
    },
    mspt: msptMean.length
      ? { mean: round(mean(msptMean)), max: msptMax.length ? round(Math.max(...msptMax)) : null }
      : null,
  };
}
