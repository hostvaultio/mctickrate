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
 *           distribution that actually predicts felt lag, but requires RCON
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

export class RconSampler {
  constructor({ host, port, password, intervalMs }) {
    this.opts = { host, port, password };
    this.intervalMs = intervalMs;
    this.samples = [];
    this._timer = null;
    this._rcon = null;
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
    try {
      const [tpsRaw, msptRaw] = await Promise.all([
        this._rcon.send('tps'),
        this._rcon.send('mspt').catch(() => ''),
      ]);
      const tps = parseFloat((tpsRaw.replace(/§./g, '').match(/[\d.]+/) || [])[0]);
      const nums = msptRaw.replace(/§./g, '').match(/[\d.]+/g) || [];
      const sample = { t: Date.now() };
      if (Number.isFinite(tps)) sample.tps = Math.min(20, tps);
      // Paper's /mspt prints 5s/10s/1m blocks of mean/median/95%ile.
      if (nums.length >= 3) {
        sample.msptMean = parseFloat(nums[0]);
        sample.msptP95 = parseFloat(nums[2]);
      }
      if (sample.tps !== undefined || sample.msptMean !== undefined) this.samples.push(sample);
    } catch {
      /* a failed poll is not fatal; the run continues and n drops */
    }
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
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
 * Deliberately reports the LOW percentiles for TPS and the HIGH ones for
 * MSPT — the bad tail is what players feel, and a mean hides it.
 */
export function summarise(samples, from, to) {
  const win = samples.filter((s) => s.t >= from && s.t <= to);
  const tps = win.map((s) => s.tps).filter(Number.isFinite);
  const msptMean = win.map((s) => s.msptMean).filter(Number.isFinite);
  const msptP95 = win.map((s) => s.msptP95).filter(Number.isFinite);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

  return {
    samples: win.length,
    tps: {
      mean: round(mean(tps)),
      min: tps.length ? round(Math.min(...tps)) : null,
      p5: round(pct(tps, 0.05)),
      p50: round(pct(tps, 0.5)),
    },
    mspt: msptMean.length
      ? { mean: round(mean(msptMean)), p95: round(mean(msptP95)), max: round(Math.max(...msptP95)) }
      : null,
  };
}
