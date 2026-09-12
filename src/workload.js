/** Qualify the observed workload before interpreting server timing as capacity. */
export const WORKLOAD_INTERVAL_MS = 5000;
export const MIN_MOVING_FRACTION = 0.8;
export const MIN_TRAVEL_BLOCKS = 16;

export function observeWorkload(swarm, t = Date.now()) {
  return { t, joined: swarm.population, moving: swarm.movingCount(),
    positions: swarm.bots.filter(b => b._alive && b.entity?.position).map(b => ({
      name: b.username, x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z,
    })) };
}

export function assessWorkload(observations, from, to, target, move = true) {
  const rows = observations.filter(s => s.t >= from && s.t <= to).sort((a, b) => a.t - b.t);
  const reasons = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !Number.isInteger(target) || target < 1) {
    reasons.push('invalid_workload_window');
  }
  const requiredMoving = Math.ceil(target * MIN_MOVING_FRACTION);
  const expected = Math.floor((to - from) / WORKLOAD_INTERVAL_MS);
  const times = [from, ...rows.map(r => r.t), to];
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  if (!move) reasons.push('movement_disabled');
  if (!rows.length || rows.length < Math.max(1, Math.ceil(expected * 0.9)) ||
      new Set(rows.map(r => r.t)).size !== rows.length || Math.max(...gaps) > WORKLOAD_INTERVAL_MS * 2) {
    reasons.push('insufficient_workload_observations');
  }
  if (rows.some(r => !Number.isInteger(r.joined) || r.joined !== target)) reasons.push('incomplete_population');
  if (rows.some(r => !Number.isInteger(r.moving) || r.moving < requiredMoving || r.moving > r.joined)) reasons.push('insufficient_movement');
  const tracks = new Map();
  for (const row of rows) {
    for (const p of row.positions ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const track = tracks.get(p.name) ?? { minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z, chunks: new Set() };
      track.minX = Math.min(track.minX, p.x); track.maxX = Math.max(track.maxX, p.x);
      track.minZ = Math.min(track.minZ, p.z); track.maxZ = Math.max(track.maxZ, p.z);
      track.chunks.add(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`);
      tracks.set(p.name, track);
    }
  }
  const travel = [...tracks].map(([name, t]) => ({ name,
    spanBlocks: Math.round(Math.hypot(t.maxX - t.minX, t.maxZ - t.minZ) * 100) / 100, chunks: t.chunks.size }));
  if (travel.filter(p => p.spanBlocks >= MIN_TRAVEL_BLOCKS).length < requiredMoving) reasons.push('insufficient_travel');
  return { valid: reasons.length === 0, reasons, observations: rows.length,
    minJoined: rows.length ? Math.min(...rows.map(r => r.joined)) : 0,
    minMoving: rows.length ? Math.min(...rows.map(r => r.moving)) : 0,
    requiredMoving, minimumTravelBlocks: MIN_TRAVEL_BLOCKS, travel };
}
