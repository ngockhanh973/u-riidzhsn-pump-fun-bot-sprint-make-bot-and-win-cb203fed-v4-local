// Second-Wind Dip-Recovery Bot v4-local ("5x Runner Hunt").
//
// Idea: never chase a freshly created curve. Only buy a coin that already
// proved it can run (>= 5x from its creation price) and is now pulling back
// 12-30% off its top while fresh buyers come back in. v4 hunts runners only:
// a higher runup bar, bigger size per coin, a wider stop to survive noise and
// a longer hold so a real runner has room to pay. The creator may take a
// small profit, but once the creator has sold 0.5 SOL in total the coin is
// vetoed for good.
//
// Deterministic by construction: every decision comes from the batch the
// harness sent plus this strategy's own state. No clock, no randomness,
// no environment, no IO inside the strategy.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minRunup: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  dipMax: number;
  dipMin: number;
  minRealSol: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  tp1: number;
  tp2: number;
  trail: number;
  stopLoss: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 5.0,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.88,
  dipMin: 0.7,
  minRealSol: 3,
  minPeakRealSol: 8,
  firstSol: 0.1,
  addSol: 0.2,
  maxPositionSol: 0.6,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.25,
  tp2: 1.0,
  trail: 0.15,
  stopLoss: 0.2,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  maxHold: 1200,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  maxExposureSol: 5.0,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000;
const FEE_RATE = 0.0125;
const SELL_SLIP_BPS = 10000;

const toLam = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS));
const toSol = (lam: bigint): number => Number(lam) / LAMPORTS;

interface TradeNote {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface CoinBook {
  born: number;
  creator: string;
  startPx: number;
  topPx: number;
  topReal: number;
  makerSold: number;
  notes: TradeNote[];
  complete: boolean;
  // Lifetime entry count: never reset, the cap is per coin for the whole run.
  entries: number;
  lastExit: number;
  held: boolean;
  entrySlot: number;
  firstBuyPx: number;
  added: boolean;
  tp1Done: boolean;
  best: number;
  everFilled: boolean;
  lastTradeSlot: number;
}

interface FlowStats {
  buys: number;
  buyers: number;
  net: number;
  lastBuy: boolean;
  maxShare: number;
  buySol: number;
}

function newBook(born: number, creator: string, startPx: number): CoinBook {
  return {
    born,
    creator,
    startPx,
    topPx: startPx,
    topReal: 0,
    makerSold: 0,
    notes: [],
    complete: false,
    entries: 0,
    lastExit: -1,
    held: false,
    entrySlot: -1,
    firstBuyPx: 0,
    added: false,
    tp1Done: false,
    best: 0,
    everFilled: false,
    lastTradeSlot: -1,
  };
}

function flowStats(book: CoinBook, slot: number, window: number): FlowStats {
  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  let lastBuy = false;
  let lastSlot = -1;
  const perBuyer = new Map<string, number>();
  for (const n of book.notes) {
    if (n.slot <= slot - window) continue;
    if (n.buy) {
      buys++;
      buySol += n.sol;
      perBuyer.set(n.user, (perBuyer.get(n.user) ?? 0) + n.sol);
    } else {
      sellSol += n.sol;
    }
    if (n.slot >= lastSlot) {
      lastSlot = n.slot;
      lastBuy = n.buy;
    }
  }
  let maxShare = 0;
  for (const v of perBuyer.values()) if (buySol > 0 && v / buySol > maxShare) maxShare = v / buySol;
  return { buys, buyers: perBuyer.size, net: buySol - sellSol, lastBuy, maxShare, buySol };
}

export function createStrategy(params: Params): Bot {
  const p = params;
  const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;
  const books = new Map<string, CoinBook>();
  const firstBuys = new Map<string, string>();
  const addBuys = new Map<string, string>();
  const probeBuys = new Map<string, string>();
  const tp1Sells = new Map<string, string>();
  const probeToSell = new Set<string>();
  const filledCoins = new Set<string>();
  let filledFills = 0;
  let firstBlockTime = -1;
  let lastBlockTime = -1;
  let orderNo = 0;

  const nextId = (tag: string): string => {
    orderNo++;
    return `${tag}${orderNo}`;
  };
  const priceOf = (state: BotState, mint: string): number => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  };
  const realSolOf = (state: BotState, mint: string): number => {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    return Number(c.real_quote_reserves) / LAMPORTS;
  };
  const netValue = (state: BotState, mint: string, tokens: bigint, costLam: bigint): number => {
    const px = priceOf(state, mint);
    if (px <= 0) return 0;
    const gross = Number(tokens) * px / LAMPORTS;
    return gross * (1 - FEE_RATE) - toSol(state.txFeeLamports());
  };
  const pendingMint = (state: BotState, mint: string, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };
  const investedSol = (state: BotState): number => {
    let total = 0;
    for (const pos of state.positions.values()) total += toSol(pos.cost_lamports);
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') total += toSol(BigInt(po.order.quote_lamports));
    }
    return total;
  };

  const ingest = (state: BotState, batch: Batch): void => {
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime < 0) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const startPx = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (!books.has(e.mint)) books.set(e.mint, newBook(e.slot, e.creator, startPx));
      } else if (e.event === 'TradeEvent') {
        let book = books.get(e.mint);
        if (book === undefined) {
          book = newBook(e.slot, e.creator, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
          books.set(e.mint, book);
        }
        const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        const realSol = Number(e.real_quote_reserves) / LAMPORTS;
        const solAmt = Number(BigInt(e.sol_amount)) / LAMPORTS;
        if (px > book.topPx) book.topPx = px;
        if (realSol > book.topReal) book.topReal = realSol;
        if (!e.is_buy && e.user === book.creator) book.makerSold += solAmt;
        book.notes.push({ slot: e.slot, buy: e.is_buy, sol: solAmt, user: e.user });
        book.lastTradeSlot = e.slot;
        while (book.notes.length > 0 && book.notes[0]!.slot <= e.slot - horizon) book.notes.shift();
      } else if (e.event === 'CompleteEvent') {
        const book = books.get(e.mint);
        if (book !== undefined) book.complete = true;
      }
    }
  };

  const settleFills = (state: BotState, batch: Batch): void => {
    for (const f of batch.fills) {
      if (f.status === 'filled') {
        filledFills++;
        filledCoins.add(f.mint);
        const book = books.get(f.mint);
        if (book !== undefined) book.everFilled = true;
      }
      const firstMint = firstBuys.get(f.client_id);
      if (firstMint !== undefined) {
        firstBuys.delete(f.client_id);
        if (f.status === 'filled') {
          const book = books.get(firstMint);
          if (book !== undefined) {
            book.entries++;
            book.entrySlot = batch.slot;
            book.firstBuyPx = priceOf(state, firstMint);
            book.held = true;
            book.added = false;
            book.tp1Done = false;
            book.best = 0;
          }
        }
      }
      const addMint = addBuys.get(f.client_id);
      if (addMint !== undefined) {
        addBuys.delete(f.client_id);
        if (f.status === 'filled') {
          const book = books.get(addMint);
          if (book !== undefined) book.added = true;
        }
      }
      const probeMint = probeBuys.get(f.client_id);
      if (probeMint !== undefined) {
        probeBuys.delete(f.client_id);
        if (f.status === 'filled') probeToSell.add(probeMint);
      }
      const tp1Mint = tp1Sells.get(f.client_id);
      if (tp1Mint !== undefined) {
        tp1Sells.delete(f.client_id);
        if (f.status === 'filled') {
          const book = books.get(tp1Mint);
          const pos = state.positions.get(tp1Mint);
          if (book !== undefined) {
            book.tp1Done = true;
            // Reset the trailing-stop peak to the value of what is left:
            // otherwise the trail fires on the very next batch after TP1.
            book.best = pos !== undefined ? netValue(state, tp1Mint, pos.token_amount, pos.cost_lamports) : 0;
          }
        }
      }
    }
  };

  const syncHeld = (state: BotState, batch: Batch): void => {
    for (const [mint, book] of books) {
      if (!book.held) continue;
      if (!state.positions.has(mint) && !pendingMint(state, mint, 'sell')) {
        book.held = false;
        book.lastExit = batch.slot;
        book.tp1Done = false;
        book.added = false;
        book.best = 0;
        book.firstBuyPx = 0;
      }
    }
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    ingest(state, batch);
    settleFills(state, batch);
    syncHeld(state, batch);
    const orders: OrderInput[] = [];
    const soldThisBatch = new Set<string>();
    const slot = batch.slot;
    const txFeeSol = toSol(state.txFeeLamports());
    let plannedSpend = 0;
    let plannedCoins = 0;

    // Exits first, before any new entry in this batch.
    for (const [mint, pos] of state.positions) {
      const book = books.get(mint);
      if (book === undefined) continue;
      if (pendingMint(state, mint, 'sell')) continue;
      const cost = toSol(pos.cost_lamports);
      const value = netValue(state, mint, pos.token_amount, pos.cost_lamports);
      const fade = flowStats(book, slot, p.fadeWindow);
      const heldFor = book.entrySlot >= 0 ? slot - book.entrySlot : 0;
      const up = value >= cost * (1 + p.holdIfUp);
      const maxHoldSlots = up ? p.maxHold * 2 : p.maxHold;
      let exitAll = false;
      if (book.makerSold >= p.creatorSellVetoSol) exitAll = true;
      if (value < cost * (1 - p.stopLoss)) exitAll = true;
      if (book.tp1Done && value < book.best * (1 - p.trail)) exitAll = true;
      if (book.tp1Done && value >= cost * (1 + p.tp2)) exitAll = true;
      if (fade.net < -p.fadeNetSol) exitAll = true;
      if (book.entrySlot >= 0 && heldFor > maxHoldSlots) exitAll = true;
      if (exitAll) {
        soldThisBatch.add(mint);
        orders.push({ side: 'sell', client_id: nextId('x'), mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        continue;
      }
      if (book.tp1Done) {
        if (value > book.best) book.best = value;
        continue;
      }
      if (value >= cost * (1 + p.tp1)) {
        const half = pos.token_amount / 2n;
        if (half > 0n) {
          soldThisBatch.add(mint);
          const id = nextId('t');
          tp1Sells.set(id, mint);
          orders.push({ side: 'sell', client_id: id, mint, token_amount: half, max_slippage_bps: SELL_SLIP_BPS });
        }
      }
    }

    // One add per position: price confirmed up 5% with fresh net flow.
    for (const [mint, pos] of state.positions) {
      const book = books.get(mint);
      if (book === undefined || book.added) continue;
      if (soldThisBatch.has(mint)) continue;
      if (pendingMint(state, mint, 'buy') || pendingMint(state, mint, 'sell')) continue;
      if (book.firstBuyPx <= 0) continue;
      const px = priceOf(state, mint);
      if (px < book.firstBuyPx * (1 + p.addStep)) continue;
      const flow = flowStats(book, slot, p.flowWindow);
      if (flow.net < p.minFlowSol) continue;
      if (realSolOf(state, mint) < p.minRealSol) continue;
      const invested = toSol(pos.cost_lamports);
      const room = p.maxPositionSol - invested - p.minBuySol;
      if (room <= 0) continue;
      let size = Math.min(p.addSol, room);
      const cap = toSol(state.maxBuyLamports(mint));
      size = Math.min(size, cap);
      const exposureRoom = p.maxExposureSol - investedSol(state) - plannedSpend;
      size = Math.min(size, exposureRoom);
      const cashRoom = toSol(state.freeCashLamports()) - plannedSpend - txFeeSol;
      size = Math.min(size, cashRoom);
      if (size < p.minBuySol) continue;
      const id = nextId('a');
      addBuys.set(id, mint);
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: toLam(size), max_slippage_bps: p.buySlipBps });
      plannedSpend += size;
    }

    // Entries: proven runner, dipping, buyers returning.
    for (const [mint, book] of books) {
      if (orders.length >= 16) break;
      if (book.complete || book.held) continue;
      if (book.entries >= p.maxEntries) continue;
      if (book.lastExit >= 0 && slot - book.lastExit < p.cooldown) continue;
      if (pendingMint(state, mint, 'buy')) continue;
      if (state.committedPositionCount() + plannedCoins >= p.maxMain) continue;
      if (book.makerSold >= p.creatorSellVetoSol) continue;
      if (slot - book.born < p.minAge) continue;
      if (book.topPx < p.minRunup * book.startPx) continue;
      if (book.topReal < p.minPeakRealSol) continue;
      if (realSolOf(state, mint) < p.minRealSol) continue;
      const px = priceOf(state, mint);
      if (px <= 0 || book.topPx <= 0) continue;
      const dip = px / book.topPx;
      if (dip > p.dipMax || dip < p.dipMin) continue;
      const flow = flowStats(book, slot, p.flowWindow);
      if (flow.buys < p.minFlowBuyers) continue;
      if (flow.buyers < p.minFlowBuyers) continue;
      if (flow.net < p.minFlowSol) continue;
      if (p.lastMustBeBuy && !flow.lastBuy) continue;
      if (flow.maxShare > p.maxBuyerShare) continue;
      let size = p.firstSol;
      size = Math.min(size, toSol(state.maxBuyLamports(mint)));
      size = Math.min(size, p.maxExposureSol - investedSol(state) - plannedSpend);
      size = Math.min(size, toSol(state.freeCashLamports()) - plannedSpend - txFeeSol);
      if (size < p.minBuySol) continue;
      const id = nextId('e');
      firstBuys.set(id, mint);
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: toLam(size), max_slippage_bps: p.buySlipBps });
      plannedSpend += size;
      plannedCoins++;
    }

    // Probe sells: dump a filled probe the moment its buy lands.
    for (const mint of [...probeToSell]) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        probeToSell.delete(mint);
        continue;
      }
      if (pendingMint(state, mint, 'sell')) continue;
      if (soldThisBatch.has(mint)) continue;
      probeToSell.delete(mint);
      orders.push({ side: 'sell', client_id: nextId('s'), mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // Pacing probe: keep the fill/coin count on schedule, one probe at a time.
    const probesFlying = probeBuys.size;
    if (probesFlying < p.maxProbes && firstBlockTime >= 0 && lastBlockTime > firstBlockTime) {
      const progress = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
      const coinsShort = filledCoins.size < Math.ceil(p.targetCoins * progress);
      const fillsShort = filledFills < Math.ceil(p.targetFills * progress);
      if (coinsShort || fillsShort) {
        const room = state.committedPositionCount() + plannedCoins < p.maxMain;
        if (room) {
          let bestMint: string | null = null;
          let bestSlot = -1;
          for (const [mint, book] of books) {
            if (book.complete || book.lastTradeSlot < 0) continue;
            if (state.positions.has(mint)) continue;
            if (pendingMint(state, mint, 'buy')) continue;
            if (probeToSell.has(mint)) continue;
            if (coinsShort && !fillsShort && book.everFilled) continue;
            const probeFloor = 1.5 * (p.probeSol * 10000 / state.hello.caps.max_order_bps_of_real_reserve);
            if (realSolOf(state, mint) < probeFloor) continue;
            if (book.lastTradeSlot > bestSlot) {
              bestSlot = book.lastTradeSlot;
              bestMint = mint;
            }
          }
          if (bestMint !== null) {
            let size = p.probeSol;
            size = Math.min(size, toSol(state.maxBuyLamports(bestMint)));
            size = Math.min(size, toSol(state.freeCashLamports()) - plannedSpend - txFeeSol);
            if (size >= p.minBuySol) {
              const id = nextId('r');
              probeBuys.set(id, bestMint);
              orders.push({ side: 'buy', client_id: id, mint: bestMint, quote_lamports: toLam(size), max_slippage_bps: p.buySlipBps });
              plannedSpend += size;
            }
          }
        }
      }
    }

    return orders;
  };

  return { onBatch };
}
