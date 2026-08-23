import mineflayer from 'mineflayer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A pool of simulated players.
 *
 * The load a Minecraft server carries is dominated by how many DISTINCT chunks
 * it has to keep resident and tick. That means two things this class has to get
 * right, or the whole benchmark is a lie:
 *
 *   1. Bots must MOVE. A stationary bot pins a handful of chunks and costs
 *      almost nothing. A walking one forces continuous load/unload, which is
 *      the expensive path and the one real players exercise.
 *   2. Bots must SPREAD. Twenty players standing together share one working
 *      set; twenty scattered multiply it. Huddled bots understate load badly.
 *
 * Bots that get wedged in terrain stop loading new chunks, so `movingCount()`
 * reports how many actually displaced recently. If that number is well under
 * the population, the result is not measuring what it claims to.
 */
export class Swarm {
  constructor(cfg, log = console.log) {
    this.cfg = cfg;
    this.log = log;
    this.bots = [];
    this._n = 0;
  }

  get population() { return this.bots.filter((b) => b._alive).length; }

  async growTo(target, onFirstBot) {
    while (this.population < target) {
      const bot = await this._spawnOne();
      if (bot && this.bots.length === 1 && onFirstBot) onFirstBot(bot);
      await sleep(this.cfg.bots.joinStaggerMs);
    }
  }

  _spawnOne() {
    return new Promise((resolve) => {
      const name = `${this.cfg.bots.usernamePrefix}${++this._n}`;
      let bot;
      try {
        bot = mineflayer.createBot({
          host: this.cfg.server.host,
          port: this.cfg.server.port,
          username: name,
          auth: this.cfg.server.auth,
          ...(this.cfg.server.version ? { version: this.cfg.server.version } : {}),
          hideErrors: true,
        });
      } catch (err) {
        this.log(`  ! ${name} failed to create: ${err.message}`);
        return resolve(null);
      }

      bot._alive = false;
      bot._lastPos = null;
      bot._movedAt = 0;
      this.bots.push(bot);

      const settled = setTimeout(() => resolve(bot), 20000); // never hang the run

      bot.once('spawn', () => {
        bot._alive = true;
        clearTimeout(settled);
        this._drive(bot);
        resolve(bot);
      });
      bot.on('end', () => { bot._alive = false; });
      bot.on('kicked', (why) => {
        bot._alive = false;
        this.log(`  ! ${name} kicked: ${String(why).slice(0, 120)}`);
      });
      bot.on('error', () => { bot._alive = false; });
    });
  }

  /** Walk, turn, occasionally jump. Track displacement so we can report it. */
  _drive(bot) {
    const { move, turnIntervalMs, jumpChance, spreadRadius } = this.cfg.bots;
    if (!move) return;

    // Push outward from spawn first so the swarm disperses, then wander.
    const bearing = Math.random() * Math.PI * 2;
    const disperseUntil = Date.now() + (spreadRadius > 0 ? (spreadRadius / 4.3) * 1000 : 0);

    bot.setControlState('forward', true);
    bot.look(bearing, 0, true).catch(() => {});

    bot._timer = setInterval(() => {
      if (!bot._alive) return;
      try {
        const yaw = Date.now() < disperseUntil
          ? bearing + (Math.random() - 0.5) * 0.3   // hold a heading while dispersing
          : Math.random() * Math.PI * 2;            // then wander
        bot.look(yaw, 0, true).catch(() => {});
        if (Math.random() < jumpChance) {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 400);
        }
        const p = bot.entity?.position;
        if (p) {
          if (bot._lastPos && p.distanceTo(bot._lastPos) > 2) bot._movedAt = Date.now();
          bot._lastPos = p.clone();
        }
      } catch { /* bot died or disconnected mid-tick */ }
    }, turnIntervalMs);
  }

  /** Bots that displaced >2 blocks within the last two turn intervals. */
  movingCount() {
    const cutoff = Date.now() - this.cfg.bots.turnIntervalMs * 2;
    return this.bots.filter((b) => b._alive && b._movedAt > cutoff).length;
  }

  async shutdown() {
    for (const bot of this.bots) {
      if (bot._timer) clearInterval(bot._timer);
      try { bot.quit(); } catch { /* already disconnected */ }
    }
    await sleep(500);
  }
}
