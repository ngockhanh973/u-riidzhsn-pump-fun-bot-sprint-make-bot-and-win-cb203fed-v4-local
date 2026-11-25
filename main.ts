// Second-Wind Dip-Recovery Bot v4-local ("5x Runner Hunt") — entrypoint.
// Only hunts coins that already ran >= 5x, buys the 12-30% dip while fresh
// buyers return, sizes up, stops wide, holds long for a real runner.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(`done ${done.reason} cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`);
  },
});
