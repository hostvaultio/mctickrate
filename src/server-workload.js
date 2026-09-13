import { observeWorkload } from './workload.js';

export const POSITION_COMMAND = 'execute as @a run data get entity @s Pos';

/** Paper's English /data output; concatenated responses need no newline. */
export function parseServerPositions(raw, names) {
  const text = String(raw ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '').trim();
  const number = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)[dD]';
  const record = new RegExp('([A-Za-z0-9_]{1,16}) has the following entity data: \\[' + number + ',\\s*' + number + ',\\s*' + number + '\\]', 'gy');
  const found = new Map();
  let offset = 0;
  while (offset < text.length) {
    record.lastIndex = offset;
    const match = record.exec(text);
    if (!match) throw new Error('Unsupported or truncated server position response');
    const [x, y, z] = match.slice(2).map(Number);
    if (![x, y, z].every(Number.isFinite) || found.has(match[1])) throw new Error('Invalid or duplicate server position');
    found.set(match[1], { name: match[1], x, y, z });
    offset = record.lastIndex;
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  }
  if (new Set(names).size !== names.length || names.some(name => !found.has(name))) throw new Error('Incomplete server positions');
  // Do not persist positions of players outside this swarm.
  return names.map(name => found.get(name));
}

/** Count horizontal progress from server observations, never client prediction. */
export class ServerMovementTracker {
  constructor(recentMs) { this.recentMs = recentMs; this.tracks = new Map(); }
  observe(positions, t) {
    let moving = 0;
    const next = new Map();
    for (const p of positions) {
      const prior = this.tracks.get(p.name);
      let movedAt = prior?.movedAt ?? -Infinity;
      if (prior && t > prior.t && t - prior.t <= this.recentMs && Math.hypot(p.x - prior.x, p.z - prior.z) > 2) movedAt = t;
      if (movedAt > t - this.recentMs) moving++;
      next.set(p.name, { ...p, t, movedAt });
    }
    this.tracks = next;
    return moving;
  }
}

/** One separate RCON connection; failed reads are explicit invalid observations. */
export class ServerWorkloadObserver {
  constructor(cfg, swarm, now = Date.now) {
    this.cfg = cfg; this.swarm = swarm; this.now = now;
    this.tracker = new ServerMovementTracker(cfg.bots.turnIntervalMs * 2);
    this.pending = null; this.stopped = false;
  }
  async start() {
    const { Rcon } = await import('rcon-client');
    const r = this.cfg.sampling.rcon;
    this.rcon = new Rcon({ host: r.host || this.cfg.server.host, port: r.port, password: r.password, timeout: 2000 });
    // rcon-client forwards socket errors through its own EventEmitter.
    this.rcon.on('error', () => {});
    await this.rcon.connect();
  }
  async observe() {
    if (this.stopped) return null;
    if (this.pending) return this.pending;
    this.pending = this.read();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async read() {
    const requestedAt = this.now();
    const names = this.swarm.bots.filter(b => b._alive).map(b => b.username);
    let positions = [], error;
    try { positions = parseServerPositions(await this.rcon.send(POSITION_COMMAND), names); }
    catch { error = 'server_position_read_failed'; }
    const t = this.now();
    if (t - requestedAt > 2000) error = 'server_position_read_too_slow';
    const client = observeWorkload(this.swarm, t);
    if (client.positions.length !== names.length || client.positions.some(p => !names.includes(p.name))) error = 'population_changed_during_read';
    const moving = this.tracker.observe(error ? [] : positions, t);
    return { t, requestedAt, durationMs: t - requestedAt, positionSource: 'server',
      joined: client.joined, moving, positions: error ? [] : positions, client, ...(error ? { error } : {}) };
  }
  async stop() {
    this.stopped = true;
    if (this.pending) await this.pending;
    if (this.rcon) { try { await this.rcon.end(); } catch { /* already disconnected */ } }
  }
}
