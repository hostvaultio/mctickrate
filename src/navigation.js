import { restrictLeafDigging } from './leaf-digging.js';
import pathfinding from 'mineflayer-pathfinder';

/** Bounded terrain navigation. Leaf removal requires explicit permission. */
export class TerrainNavigator {
  constructor(bot, { spreadRadius, allowLeafDigging = false }, api = pathfinding, random = Math.random, now = Date.now) {
    this.allowLeafDigging = allowLeafDigging === true;
    this.bot = bot; this.spreadRadius = spreadRadius; this.api = api;
    this.random = random; this.now = now; this.running = false;
    this.bearing = random() * Math.PI * 2;
    this.failures = 0; this.replans = 0; this.needsGoal = true;
    this.onReached = () => { this.needsGoal = true; this.failures = 0; };
    this.onPath = result => {
      if (result.status === 'noPath' || result.status === 'timeout') {
        this.needsGoal = true; this.failures += 1;
      }
    };
  }

  start() {
    if (this.running) return;
    const { bot, api } = this;
    // Paper 1.21.11 contact clearance: PrismarineJS/mineflayer-pathfinder#364.
    if (bot.version === '1.21.11') {
      bot.physics.playerHalfWidth = 0.30001;
      bot.physics.playerHeight = 1.80001;
    }
    if (this.allowLeafDigging) this.restoreDig = restrictLeafDigging(bot);
    bot.loadPlugin(api.pathfinder);
    const movement = new api.Movements(bot);
    movement.canDig = this.allowLeafDigging;
    if (this.allowLeafDigging) movement.exclusionAreasBreak.push(block => block?.name?.endsWith('_leaves') ? 0 : Infinity);
    movement.allow1by1towers = false;
    movement.scafoldingBlocks = [];
    movement.allowSprinting = false;
    movement.maxDropDown = 3;
    bot.pathfinder.setMovements(movement);
    bot.pathfinder.thinkTimeout = 1000;
    bot.pathfinder.tickTimeout = 5;
    bot.pathfinder.searchRadius = 40;
    this.origin = bot.entity.position.clone();
    this.lastProgress = this.origin.clone();
    this.lastProgressAt = this.now();
    this.running = true;
    bot.on('goal_reached', this.onReached);
    bot.on('path_update', this.onPath);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  tick() {
    if (!this.running || !this.bot.entity?.position) return;
    const position = this.bot.entity.position;
    if (position.distanceTo(this.lastProgress) >= 2) {
      this.lastProgress = position.clone(); this.lastProgressAt = this.now();
    } else if (this.now() - this.lastProgressAt > 8000) {
      this.needsGoal = true; this.failures += 1; this.lastProgressAt = this.now();
    }
    if (!this.needsGoal) return;
    this.needsGoal = false; this.replans += 1;
    // A persistent radial bearing disperses clients; short waypoints bound A*.
    // Failed routes fan out instead of repeatedly steering into the same block.
    const displaced = Math.hypot(position.x - this.origin.x, position.z - this.origin.z);
    const base = displaced < this.spreadRadius ? this.bearing : this.random() * Math.PI * 2;
    const turn = this.failures * Math.PI * (3 - Math.sqrt(5));
    const angle = base + turn + (this.random() - 0.5) * 0.3;
    const distance = Math.max(2, 16 / (2 ** Math.floor(this.failures / 3)));
    this.goal = { x: Math.floor(position.x + Math.cos(angle) * distance), z: Math.floor(position.z + Math.sin(angle) * distance) };
    this.bot.pathfinder.setGoal(new this.api.goals.GoalXZ(this.goal.x, this.goal.z));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.bot.removeListener('goal_reached', this.onReached);
    this.bot.removeListener('path_update', this.onPath);
    this.bot.pathfinder.setGoal(null);
    this.restoreDig?.();
  }
}
