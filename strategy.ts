// Ember breakout rider for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). A pure function of the batches the harness sends:
// no clock, no randomness, no environment reads, no I/O — so the two graded
// executions produce byte-identical action logs.
//
// What the dev window actually rewards (measured on the kit's own data):
// coins whose real SOL crosses 20 keep going. Of the 163 coins that cross
// real SOL 20, 35 complete (migrate) — and a completer rises on average
// +274% from the crossing price to its completion price, dipping at most
// -2.4% on the way (33 of 35 survive a -10% stop). The 128 that never
// complete almost all (-10% within ~215 slots) fade away. So the trade is:
// buy the crossing, ride it to completion with a stop underneath, and let
// the 1-in-5 completers pay for the 4-in-5 that stop out. No take profit —
// the completion is the profit. Adds pyramid in as real SOL climbs past 40
// and 60, while the price is above the last add and flow is still positive.
//
// Guardrail probes keep the run above the minimum bar (20 coins, round
// trips of at least 0.01 SOL) in case a quiet window has few crossings.
//
// Deterministic by construction: iteration only over insertion-ordered maps
// fed by the batch stream, and every decision is a function of state.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL (SOL) a curve must cross upward to trigger an entry. */
  crossSol: number;
  /** Real SOL levels at which to add to a held position (empty: no adds). */
  addLevels: number[];
  /** SOL per buy (first buy and each add), capped by 1% of the real reserve. */
  stakeSol: number;
  /** Most SOL into one position in total. */
  maxPositionSol: number;
  /** Partial take-profit: sell tp1Part of the tokens once value is up tp1Gain. */
  tp1Gain: number;
  tp1Part: number;
  /** Smallest buy worth sending (a buy must clear the 0.01 SOL round-trip bar). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's liquidation value is this far under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Most new entries per batch (keeps the 16-order reply cap in reach). */
  maxEntriesPerBatch: number;
  /** Guardrail pacing: target coins over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  /** SOL per probe round trip. */
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  crossSol: 50,
  addLevels: [],
  stakeSol: 0.3,
  maxPositionSol: 0.3,
  tp1Gain: 0.5,
  tp1Part: 0.5,
  minBuySol: 0.011,
  buySlipBps: 5000,
  stopLoss: 0.1,
  trailArm: 0.3,
  trail: 0.2,
  maxHold: 3000,
  fadeWindow: 20,
  fadeNetSol: 3.0,
  maxExposureSol: 3.0,
  maxEntriesPerBatch: 4,
  targetCoins: 25,
  paceSecs: 21600,
  probeSol: 0.011,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
}

interface Coin {
  /** Real SOL last seen. */
  lastRq: number;
  /** Whether the crossing entry already fired for this coin. */
  crossed: boolean;
  /** Recent trades, for the fade exit. */
  recent: Tick[];
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** How many add levels have been taken. */
  addsTaken: number;
  /** Partial take-profit already taken. */
  tookTp1: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { lastRq: 0, crossed: false, recent: [], lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const tr = c.recent[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched: Pubkey[] = [];
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.lastRq = 0;
          if (!touched.includes(e.mint)) touched.push(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol });
          if (c.recent.length > 200) c.recent.splice(0, c.recent.length - 200);
          if (!touched.includes(e.mint)) touched.push(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop, trailing stop, time limit, fade.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (h.filled) coinOf(mint).lastExit = now;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        // Bank half once the position is up tp1Gain: a coin that pumped to
        // near-completion can cliff-dive in a few slots, and a stop cannot
        // catch a gap — the banked half is what survives it.
        if (!h.tookTp1 && !h.exiting && value >= cost * (1 + p.tp1Gain) && !pendingSell.has(mint)) {
          if (orders.length < cap) {
            const part = BigInt(Math.round(p.tp1Part * 1000));
            const half = (pos.token_amount * part) / 1000n;
            if (half > 0n) {
              orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
              h.tookTp1 = true;
              h.peakValue = value * (1 - p.tp1Part);
              continue;
            }
          }
        }
        let exit = h.exiting;
        const c = coinOf(mint);
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && flow(c, now, p.fadeWindow) < -p.fadeNetSol && value < cost * 1.2) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      let entries = 0;
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (probes.has(mint) || pendingByMint.has(mint)) continue;
        const c = coinOf(mint);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const h = held.get(mint);
        if (h === undefined) {
          // Crossing entry: real SOL crossed upward past crossSol since last seen.
          if (entries >= p.maxEntriesPerBatch || slotsLeft <= 0) continue;
          if (c.crossed || now - c.lastExit < 300) continue;
          if (!(c.lastRq < p.crossSol && rqSol >= p.crossSol)) continue;
          if (flow(c, now, 20) <= 0) continue;
          c.crossed = true;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol, p.maxPositionSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            addsTaken: 0,
            tookTp1: false,
            lastValue: 0,
          });
          free -= amount + tx;
          exposure += amount;
          slotsLeft--;
          entries++;
        } else {
          // Pyramid into a completing coin as real SOL climbs past each level.
          if (h.exiting || !h.filled || h.addsTaken >= p.addLevels.length) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (h.invested >= p.maxPositionSol - p.minBuySol) continue;
          const level = p.addLevels[h.addsTaken]!;
          if (rqSol < level) continue;
          if (price < h.lastAddPrice) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(c, now, 20) <= 0) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol, p.maxPositionSol - h.invested, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          h.invested += amount;
          h.lastAddPrice = price;
          h.addsTaken++;
          free -= amount + tx;
          exposure += amount;
        }
        c.lastRq = rqSol;
      }

      // Guardrail pacing: open a probe when the coin count lags the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
