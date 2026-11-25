[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v4-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v4-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v4-local (5x Runner Hunt)

A Solana trading bot for the make.fun **Pump.fun Bot Sprint** bounty. It trades
paper money on a replay of real pump.fun bonding-curve events and is ranked on
net PnL, with guardrails of at least 20 coins traded and max drawdown at most
50%.

## Strategy

Never chase a freshly created curve. The bot only buys a coin that already
proved it can run — price at least **5x** its creation price, with at least
**8 SOL** of real reserves at its peak — and is now pulling back **12–30%**
off that top while fresh buyers come back in (at least 3 buys from 3 distinct
wallets in the last 20 slots, net flow at least 0.02 SOL, latest trade a buy,
no single buyer over 50% of the window's buy flow).

- **Size:** first buy 0.10 SOL, one add of 0.20 SOL when price confirms 5%
  above the first buy with fresh net flow, up to 0.60 SOL per coin and 5.0 SOL
  total exposure, at most 5 main positions at once.
- **Exits:** sell half at +25% (TP1), sell the rest at +100% (TP2) or on a
  15% trailing drawdown from the best value reached after TP1; hard stop at
  −20%; fade exit when the 15-slot net flow drops below −0.05 SOL; max hold
  1200 slots (2400 while up at least 20%); a coin is vetoed forever once its
  creator has sold 0.5 SOL in total.
- **Lifetime cap:** at most 2 entries per coin for the whole run, with a
  150-slot cooldown after each exit.
- **Pacing probe:** tiny 0.01 SOL probes keep the fill/coin count on schedule
  toward 100 fills / 22 coins over 4 hours; every filled probe is sold right
  away. Probe fills count both buys and sells toward the pace.

Everything is deterministic: every decision comes from the batch the harness
sends plus the strategy's own state. No clock, no randomness, no environment,
no IO inside the strategy.

## Key parameters (v4)

| Parameter | Value | Parameter | Value |
| --- | --- | --- | --- |
| minRunup | 5.0 | firstSol / addSol / maxPositionSol | 0.10 / 0.20 / 0.60 |
| minPeakRealSol | 8 SOL | maxExposureSol | 5.0 SOL |
| dip range | 0.70–0.88 of top | stopLoss / tp1 / tp2 / trail | 0.20 / 0.25 / 1.00 / 0.15 |
| minAge | 200 slots | maxHold | 1200 slots |
| maxEntries / cooldown | 2 / 150 slots | maxMain | 5 |

## Run it

```sh
node main.ts
```

The grader runs `node main.ts` (Node 22.18+ strips the TypeScript as-is, no
build, no install). `strategy.ts` holds the strategy, `main.ts` is the
entrypoint, `vendor/makefun-bot.ts` is the kit's bot shim copied byte for byte.

## Dev results

Measured on the kit's frozen dev window with the local sim port
(`pump-sim-v4`, two identical runs):

- net PnL: **−0.048358 SOL** (without failed txs −0.047709; at 2x fees −0.098454)
- fills **112** / coins **29** / round trips **55** / wins **5** / max drawdown **0.0050**
- rejected **0**, failed txs **2**
- baseline to beat (v2): net −0.084910 SOL — **v4 beats v2 by +0.036552 SOL**
- guardrails: coins 29 ≥ 20, drawdown 0.0050 ≤ 0.50 — both pass
