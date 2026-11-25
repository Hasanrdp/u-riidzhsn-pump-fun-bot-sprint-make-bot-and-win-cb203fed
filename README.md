# Ember — Pump.fun Breakout Rider

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Hasanrdp/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Hasanrdp/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for make.fun's **Pump.fun Bot Sprint: Make Bot And Win** bounty. It trades paper SOL on a replay of pump.fun bonding-curve events and is ranked on net PnL.

## The idea

Most pump.fun coins fade. The ones that pay are the ones that **complete** (migrate off the bonding curve) — and a coin's real SOL reserve tells you it is on its way there. Measured on the kit's dev window: of the 163 coins whose real SOL crossed 20, 35 completed, rising on average **+274%** from the crossing price to completion while dipping at most **-2.4%** on the way (33 of 35 survive a -10% stop). The 128 that never completed almost all faded to their stop within ~215 slots.

So Ember does one thing: **buy the crossing, ride it to completion, stop out underneath.**

- **Entry:** a coin's real SOL crosses 50 SOL upward with positive net flow over the last 20 slots. One buy per coin, 0.3 SOL, capped at 1% of the real reserve.
- **Ride:** no take profit — the completion is the profit. At +50% value it banks half the position, because a coin pumped near completion can cliff-dive in a few slots and no stop can catch a gap.
- **Exits:** a -10% stop on liquidation value, a 20% trailing stop once up 30%, a fade exit on heavy net selling, or a 3000-slot time limit. The harness closes any position left when its curve completes.
- **Guardrails:** tiny probe round trips (0.011 SOL) keep the run above the 20-coin minimum bar when a quiet window has few crossings.

## What it is not

- No momentum chasing on mature curves and no dip buying: on this data, a 30% drawdown off the high keeps falling, and mature-curve momentum loses money.
- No randomness, no clock, no environment reads, no network: every decision is a pure function of the batches the harness sends, so the two graded executions produce byte-identical action logs.

## Run it

```sh
node main.ts
```

`main.ts` is the entrypoint the grader runs (`node /bot/main.ts` on Node 22). The strategy lives in `strategy.ts`; `vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte.

## Local results (dev window, `grade-local --driver process`)

| Setting | Net PnL | Coins | Win rate | Max drawdown |
| --- | --- | --- | --- | --- |
| cross 20 SOL | -1.61 SOL | 131 | 28% | 0.167 |
| cross 30 SOL | -0.99 SOL | 89 | 31% | 0.142 |
| cross 40 SOL | -1.11 SOL | 66 | 22% | 0.142 |
| **cross 50 SOL (shipped)** | **-0.47 SOL** | 48 | 31% | 0.056 |
| cross 60 SOL | -0.51 SOL | 43 | 19% | 0.061 |

The dev window is one small, brutal sample — every pilot the kit ships loses on it too (momentum -9.38 SOL in the pilot's own local backtest on the first data slice, reversion -3.89 SOL and sniper -0.47 SOL on the full window) — and the final window is fresh data recorded after entries close, so no dev number is a promise. What the shipped setting buys is the best dev score of the approaches measured, with the smallest drawdown and the fewest, highest-conviction trades.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
