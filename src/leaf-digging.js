/** Guard execution as well as route planning: a planned leaf may have changed. */
export function restrictLeafDigging(bot) {
  const original = bot.dig;
  bot._digEvents ??= [];
  const guarded = async (block, ...args) => {
    const current = block?.position && bot.blockAt(block.position);
    if (!current?.name?.endsWith('_leaves')) throw new Error('Leaf-only navigation refuses this block');
    const event = { name: current.name, position: { x: current.position.x, y: current.position.y, z: current.position.z }, startedAt: Date.now(), completed: false };
    bot._digEvents.push(event);
    try {
      await original.call(bot, current, ...args);
      event.completed = true;
      event.after = bot.blockAt(current.position)?.name ?? null;
    } catch (error) { event.failed = true; throw error; }
  };
  bot.dig = guarded;
  return () => { if (bot.dig === guarded) bot.dig = original; };
}
