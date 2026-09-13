import mineflayer from 'mineflayer';
import { TerrainNavigator } from './navigation.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_JOIN_FAILURES = 3;
const MOVED_THRESHOLD_BLOCKS = 2;
const JOIN_TIMEOUT_MS = 20000;

/**
 * Turn mineflayer's terser failures into something actionable. The protocol
 * one is by far the most common: minecraft-data lags new Minecraft releases,
 * so a server on the very latest version cannot be measured until support
 * lands upstream.
 */
function explain(message = '') {
  if (/No data available for version/i.test(message)) {
    const v = (message.match(/version\s+(\S+)/) || [])[1] || 'that version';
    return `mineflayer has no protocol data for Minecraft ${v}. `
      + 'Its data lags new releases — run the target on a supported version, '
      + "or pin one with --server.version=<ver>.";
  }
  if (/ECONNREFUSED/i.test(message)) return 'connection refused — is the server up on that port?';
  if (/ETIMEDOUT|EHOSTUNREACH/i.test(message)) return 'unreachable — firewall or wrong host?';
  if (/throttl/i.test(message)) {
    return 'connection throttled. Every bot shares one IP; raise bots.joinStaggerMs '
      + 'or set connection-throttle: -1 in the server\'s bukkit.yml.';
  }
  return message.slice(0, 200);
}

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

  /**
   * Grow the swarm to `target`. Bails out rather than looping forever when
   * bots cannot connect — an early version spun endlessly spawning clients
   * against a server whose protocol version mineflayer did not support,
   * printing nothing. Failing loudly after a few attempts is far more useful.
   */
  async growTo(target, onFirstBot) {
    let consecutiveFailures = 0;
    while (this.population < target) {
      const { bot, error } = await this._spawnOne();
      if (error) {
        consecutiveFailures += 1;
        this.log(`  ! join failed (${consecutiveFailures}/${MAX_JOIN_FAILURES}): ${error}`);
        if (consecutiveFailures >= MAX_JOIN_FAILURES) {
          throw new Error(
            `${MAX_JOIN_FAILURES} consecutive bots failed to join. Last error: ${error}`,
          );
        }
      } else {
        consecutiveFailures = 0;
        if (bot && this.bots.length === 1 && onFirstBot) onFirstBot(bot);
      }
      await sleep(this.cfg.bots.joinStaggerMs);
    }
  }

  /** Resolves {bot} on success or {error} with a reason — never swallows it. */
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
        return resolve({ error: explain(err.message) });
      }

      bot._corrections = 0;
      bot.on('forcedMove', () => { bot._corrections++; });
      bot._alive = false;
      bot._lastPos = null;
      bot._movedAt = 0;
      this.bots.push(bot);

      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ error: 'timed out before spawn (no response from server)' }),
        JOIN_TIMEOUT_MS,
      );

      bot.once('spawn', () => {
        bot._alive = true;
        this._drive(bot);
        finish({ bot });
      });
      bot.on('end', (reason) => {
        bot._alive = false;
        bot._navigation?.stop();
        if (bot._timer) clearInterval(bot._timer);
        finish({ error: `disconnected: ${String(reason).slice(0, 120)}` });
      });
      bot.on('kicked', (why) => {
        bot._alive = false;
        finish({ error: `kicked: ${String(JSON.stringify(why)).slice(0, 160)}` });
      });
      bot.on('error', (err) => {
        bot._alive = false;
        finish({ error: explain(err?.message || String(err)) });
      });
    });
  }

  /**
   * Walk, turn, jump, and unwedge.
   *
   * Bots WILL get stuck — measured against a real server, a bot walks a few
   * seconds, drops off terrain and then sits at zero displacement with
   * onGround=false while still holding 'forward'. A wedged bot loads no new
   * chunks, so it contributes almost nothing to the load the benchmark is
   * supposed to be generating. Detect it and break out.
   */
  _drive(bot) {
    const { move, turnIntervalMs, jumpChance, spreadRadius } = this.cfg.bots;
    if (!move) return;
    if (this.cfg.bots.navigation === 'pathfinder') {
      bot._navigation = new TerrainNavigator(bot, this.cfg.bots);
      bot._navigation.start();
      bot._timer = setInterval(() => {
        if (!bot._alive || !bot.entity?.position) return;
        const p = bot.entity.position;
        if (bot._lastPos && p.distanceTo(bot._lastPos) > MOVED_THRESHOLD_BLOCKS) bot._movedAt = Date.now();
        bot._lastPos = p.clone();
      }, turnIntervalMs);
      return;
    }

    const bearing = Math.random() * Math.PI * 2;
    const disperseUntil = Date.now() + (spreadRadius > 0 ? (spreadRadius / 4.3) * 1000 : 0);
    bot._heading = bearing;
    bot._stuckTicks = 0;

    bot.setControlState('forward', true);
    bot.look(bearing, 0, true).catch(() => {});

    bot._timer = setInterval(() => {
      if (!bot._alive) return;
      try {
        const p = bot.entity?.position;
        const moved = p && bot._lastPos ? p.distanceTo(bot._lastPos) : Infinity;
        if (p) {
          if (moved > MOVED_THRESHOLD_BLOCKS) {
            bot._movedAt = Date.now();
            bot._stuckTicks = 0;
          } else {
            bot._stuckTicks += 1;
          }
          bot._lastPos = p.clone();
        }

        if (bot._stuckTicks >= 1) {
          // Wedged: reverse, hop, and briefly walk backwards to peel off
          // whatever it is caught on.
          bot._heading = (bot._heading + Math.PI + (Math.random() - 0.5)) % (Math.PI * 2);
          bot.setControlState('jump', true);
          bot.setControlState('forward', false);
          bot.setControlState('back', true);
          setTimeout(() => {
            bot.setControlState('back', false);
            bot.setControlState('jump', false);
            bot.setControlState('forward', true);
          }, 600);
        } else {
          bot._heading = Date.now() < disperseUntil
            ? bearing + (Math.random() - 0.5) * 0.3
            : Math.random() * Math.PI * 2;
          if (Math.random() < jumpChance) {
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 400);
          }
        }
        bot.look(bot._heading, 0, true).catch(() => {});
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
      bot._navigation?.stop();
      try { bot.quit(); } catch { /* already disconnected */ }
    }
    await sleep(500);
  }
}
