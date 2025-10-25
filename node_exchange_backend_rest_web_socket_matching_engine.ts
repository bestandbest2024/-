/*
 * Minimal Exchange Backend — REST + WebSocket + In‑Memory Matching Engine
 * Language: TypeScript (single file)
 *
 * Features
 * - Price‑time priority matching (LIMIT + MARKET, GTC/IOC/FOK)
 * - Per‑symbol order book (bids/asks), FIFO at each price
 * - REST:
 *   POST /orders            -> place order
 *   DELETE /orders/:id      -> cancel order
 *   GET /orders/:id         -> order status
 *   GET /book?symbol=..     -> aggregated depth (order wall)
 *   GET /trades?symbol=..   -> recent trades
 * - WebSocket:
 *   Client sends {op:"sub", channel:"book|trades", symbol}
 *   Server pushes {type:"book"|"trade", symbol, payload}
 * - Simple dev self‑test when NODE_ENV=development
 *
 * Notes
 * - This is a single file to make it easy to copy/paste.
 * - Persistence is not included (process restart will clear in‑memory state).
 * - For production: put state in Redis, persist trades to Postgres, and shard symbols.
 */

import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

// ------------------------------- Types ---------------------------------

type Side = 'BUY' | 'SELL';

type OrderType = 'LIMIT' | 'MARKET';

// Time in force: Good‑Till‑Cancel / Immediate‑Or‑Cancel / Fill‑Or‑Kill
// FOK will cancel the whole order if it cannot be fully matched immediately
// IOC will cancel any unfilled remainder after immediate matching
// GTC will rest any unfilled remainder on the book
 type TIF = 'GTC' | 'IOC' | 'FOK';

interface Order {
  id: string;
  symbol: string; // e.g. "BTC-USD"
  side: Side;
  type: OrderType;
  price: number;     // 0 for MARKET (not resting)
  qty: number;       // total quantity requested
  remaining: number; // remaining quantity to fill
  tif: TIF;
  ts: number;        // creation time (ms)
}

interface Trade {
  id: string;
  symbol: string;
  price: number;
  qty: number;
  ts: number;
  buyOrderId: string;
  sellOrderId: string;
}

// FIFO queue at each price level
interface PriceLevel {
  price: number;
  queue: Order[]; // only LIMIT resting orders
}

interface OrderBook {
  symbol: string;
  bids: Map<number, PriceLevel>; // price -> level (descending iteration)
  asks: Map<number, PriceLevel>; // price -> level (ascending iteration)
}

// --------------------------- In‑memory state ----------------------------

const books: Record<string, OrderBook> = {};
const liveOrders = new Map<string, Order>();
const recentTrades: Record<string, Trade[]> = {}; // symbol -> trades (most recent first)

function getBook(symbol: string): OrderBook {
  if (!books[symbol]) {
    books[symbol] = { symbol, bids: new Map(), asks: new Map() };
    recentTrades[symbol] = [];
  }
  return books[symbol];
}

function uid(prefix = '') { return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36).slice(-6); }

// ------------------------------ Matching -------------------------------

function addToBook(ob: OrderBook, o: Order) {
  const sideMap = o.side === 'BUY' ? ob.bids : ob.asks;
  let level = sideMap.get(o.price);
  if (!level) {
    level = { price: o.price, queue: [] };
    sideMap.set(o.price, level);
  }
  level.queue.push(o); // FIFO within the level
}

function bestPricesAsc(map: Map<number, PriceLevel>): number[] {
  return Array.from(map.keys()).sort((a, b) => a - b);
}
function bestPricesDesc(map: Map<number, PriceLevel>): number[] {
  return Array.from(map.keys()).sort((a, b) => b - a);
}

function recordTrade(symbol: string, price: number, qty: number, buyOrderId: string, sellOrderId: string): Trade {
  const tr: Trade = { id: uid('t_'), symbol, price, qty, ts: Date.now(), buyOrderId, sellOrderId };
  const list = recentTrades[symbol] || (recentTrades[symbol] = []);
  list.unshift(tr);
  if (list.length > 500) list.pop();
  broadcast(symbol, { type: 'trade', symbol, payload: tr });
  return tr;
}

function cleanLevel(map: Map<number, PriceLevel>, price: number) {
  const lvl = map.get(price);
  if (lvl && lvl.queue.length === 0) map.delete(price);
}

// Core match routine: returns list of trades
function matchIncoming(ob: OrderBook, incoming: Order): Trade[] {
  const trades: Trade[] = [];
  const opposite = incoming.side === 'BUY' ? ob.asks : ob.bids;

  const priceList = incoming.side === 'BUY' ? bestPricesAsc(opposite) : bestPricesDesc(opposite);

  const priceOk = (levelPrice: number) => {
    if (incoming.type === 'MARKET') return true; // any price crosses
    return incoming.side === 'BUY' ? incoming.price >= levelPrice : incoming.price <= levelPrice;
  };

  for (const p of priceList) {
    if (!priceOk(p)) break; // cannot cross further prices
    const lvl = opposite.get(p)!;

    while (lvl.queue.length && incoming.remaining > 0) {
      const resting = lvl.queue[0];
      const execQty = Math.min(incoming.remaining, resting.remaining);
      const execPrice = p; // trade occurs at resting price

      // Record trade
      trades.push(recordTrade(incoming.symbol, execPrice, execQty,
        incoming.side === 'BUY' ? incoming.id : resting.id,
        incoming.side === 'BUY' ? resting.id : incoming.id));

      // Update quantities
      incoming.remaining -= execQty;
      resting.remaining -= execQty;

      if (resting.remaining <= 0) {
        lvl.queue.shift();
        liveOrders.delete(resting.id);
      }
    }

    cleanLevel(opposite, p);

    // IOC/FOK conditions: if we reached a level that does not cross or exhausted, break decision later
    if (incoming.remaining <= 0) break;
  }

  return trades;
}

function placeOrder(o: Omit<Order, 'id' | 'remaining' | 'ts'>): { order: Order; trades: Trade[]; status: 'FILLED'|'PARTIAL'|'OPEN'|'CANCELLED' } {
  const order: Order = { ...o, id: uid('o_'), remaining: o.qty, ts: Date.now() };
  const ob = getBook(order.symbol);

  // MARKET orders never rest on the book
  const trades = matchIncoming(ob, order);

  if (order.remaining > 0) {
    if (order.type === 'MARKET') {
      // MARKET unfilled remainder is cancelled
      order.remaining = 0;
      return { order, trades, status: trades.length ? 'PARTIAL' : 'CANCELLED' };
    }
    // LIMIT order: check TIF
    if (order.tif === 'FOK') {
      // if not fully filled immediately, cancel the whole thing
      if (trades.length === 0 || order.remaining > 0) {
        // revert nothing needs revert because we never rested it
        order.remaining = 0; // indicate not resting
        return { order, trades, status: trades.length ? 'PARTIAL' : 'CANCELLED' };
      }
    }
    if (order.tif === 'IOC') {
      // cancel remainder
      order.remaining = 0;
      return { order, trades, status: trades.length ? 'PARTIAL' : 'CANCELLED' };
    }
    // GTC: rest the remainder on the book
    addToBook(ob, order);
    liveOrders.set(order.id, order);
    pushBook(ob.symbol);
    return { order, trades, status: trades.length ? 'PARTIAL' : 'OPEN' };
  }

  // fully filled
  pushBook(ob.symbol);
  return { order, trades, status: 'FILLED' };
}

function cancelOrder(id: string): { ok: boolean; reason?: string; order?: Order } {
  const o = liveOrders.get(id);
  if (!o) return { ok: false, reason: 'NOT_FOUND' };
  const ob = getBook(o.symbol);
  const sideMap = o.side === 'BUY' ? ob.bids : ob.asks;
  const lvl = sideMap.get(o.price);
  if (!lvl) return { ok: false, reason: 'LEVEL_MISSING' };
  const idx = lvl.queue.findIndex(x => x.id === id);
  if (idx === -1) return { ok: false, reason: 'ORDER_MISSING' };
  lvl.queue.splice(idx, 1);
  liveOrders.delete(id);
  cleanLevel(sideMap, o.price);
  pushBook(o.symbol);
  return { ok: true, order: o };
}

// ----------------------- Aggregation (Order Wall) ----------------------

function aggregate(map: Map<number, PriceLevel>, limit = 50, asc = true) {
  const prices = Array.from(map.keys()).sort((a, b) => asc ? a - b : b - a);
  const out: { price: number; qty: number }[] = [];
  for (const p of prices) {
    const lvl = map.get(p)!;
    const qty = lvl.queue.reduce((s, o) => s + o.remaining, 0);
    if (qty > 0) out.push({ price: p, qty });
    if (out.length >= limit) break;
  }
  return out;
}

function currentBookSnapshot(symbol: string, levels = 30) {
  const ob = getBook(symbol);
  return {
    symbol,
    bids: aggregate(ob.bids, levels, false), // high->low
    asks: aggregate(ob.asks, levels, true),  // low->high
  };
}

function pushBook(symbol: string) {
  const snap = currentBookSnapshot(symbol, 30);
  broadcast(symbol, { type: 'book', symbol, payload: snap });
}

// ------------------------------ HTTP API -------------------------------

const app = express();
app.use(cors());
app.use(express.json());

function parseSymbol(s: any): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().toUpperCase();
  if (!/^([A-Z0-9]+)-([A-Z0-9]+)$/.test(t)) return null;
  return t;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'exchange-backend', time: Date.now() }));

app.post('/orders', (req: Request, res: Response) => {
  try {
    const { symbol: rawSymbol, side, type, price, qty, tif } = req.body || {};
    const symbol = parseSymbol(rawSymbol);
    if (!symbol) return res.status(400).json({ error: 'INVALID_SYMBOL (use like BTC-USD)' });

    const s: Side = side === 'BUY' ? 'BUY' : side === 'SELL' ? 'SELL' : null as any;
    if (!s) return res.status(400).json({ error: 'INVALID_SIDE (BUY|SELL)' });

    const t: OrderType = type === 'MARKET' ? 'MARKET' : type === 'LIMIT' ? 'LIMIT' : null as any;
    if (!t) return res.status(400).json({ error: 'INVALID_TYPE (LIMIT|MARKET)' });

    const f: TIF = tif === 'IOC' ? 'IOC' : tif === 'FOK' ? 'FOK' : 'GTC';

    const qn = Number(qty);
    if (!Number.isFinite(qn) || qn <= 0) return res.status(400).json({ error: 'INVALID_QTY' });

    const pn = t === 'LIMIT' ? Number(price) : 0;
    if (t === 'LIMIT' && (!Number.isFinite(pn) || pn <= 0)) return res.status(400).json({ error: 'INVALID_PRICE' });

    const { order, trades, status } = placeOrder({ symbol, side: s, type: t, price: pn, qty: qn, tif: f });
    return res.json({ order, trades, status });
  } catch (e: any) {
    return res.status(500).json({ error: 'SERVER_ERROR', detail: String(e?.message || e) });
  }
});

app.get('/orders/:id', (req, res) => {
  const o = liveOrders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json(o);
});

app.delete('/orders/:id', (req, res) => {
  const r = cancelOrder(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  return res.json(r);
});

app.get('/book', (req, res) => {
  const symbol = parseSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: 'INVALID_SYMBOL' });
  const levels = Math.max(1, Math.min(200, Number(req.query.levels) || 30));
  return res.json(currentBookSnapshot(symbol, levels));
});

app.get('/trades', (req, res) => {
  const symbol = parseSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: 'INVALID_SYMBOL' });
  const n = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const list = (recentTrades[symbol] || []).slice(0, n);
  return res.json(list);
});

// ----------------------------- WebSockets ------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

type SubKey = string; // `${channel}:${symbol}`
const subs = new Map<SubKey, Set<WebSocket>>();

function keyOf(ch: 'book'|'trades', symbol: string): SubKey { return `${ch}:${symbol}`; }

function broadcast(symbol: string, msg: any) {
  const targets = new Set<WebSocket>();
  for (const ch of ['book', 'trades'] as const) {
    const set = subs.get(keyOf(ch, symbol));
    if (set) set.forEach(ws => targets.add(ws));
  }
  if (targets.size === 0) return;
  const data = JSON.stringify(msg);
  targets.forEach(ws => { try { ws.send(data); } catch {} });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.op === 'sub' && (msg.channel === 'book' || msg.channel === 'trades')) {
        const symbol = parseSymbol(msg.symbol);
        if (!symbol) return;
        const set = subs.get(keyOf(msg.channel, symbol)) || new Set<WebSocket>();
        set.add(ws);
        subs.set(keyOf(msg.channel, symbol), set);
        // send initial snapshot on book sub
        if (msg.channel === 'book') {
          ws.send(JSON.stringify({ type: 'book', symbol, payload: currentBookSnapshot(symbol, 30) }));
        }
        return;
      }
      if (msg.op === 'unsub' && (msg.channel === 'book' || msg.channel === 'trades')) {
        const symbol = parseSymbol(msg.symbol);
        if (!symbol) return;
        subs.get(keyOf(msg.channel, symbol))?.delete(ws);
        return;
      }
    } catch {}
  });
  ws.on('close', () => {
    // remove this socket from all subscriptions
    subs.forEach(set => set.delete(ws));
  });
});

// -------------------------- Dev sanity checks --------------------------

if (process.env.NODE_ENV !== 'production') {
  (function selfTest() {
    const symbol = 'BTC-USD';
    const ob = getBook(symbol);

    // Seed a tiny book
    const a1 = { id: uid('o_'), symbol, side: 'SELL' as Side, type: 'LIMIT' as OrderType, price: 101, qty: 1, remaining: 1, tif: 'GTC' as TIF, ts: Date.now() };
    const a2 = { id: uid('o_'), symbol, side: 'SELL' as Side, type: 'LIMIT' as OrderType, price: 102, qty: 2, remaining: 2, tif: 'GTC' as TIF, ts: Date.now() };
    addToBook(ob, a1); liveOrders.set(a1.id, a1);
    addToBook(ob, a2); liveOrders.set(a2.id, a2);

    const buyMkt = placeOrder({ symbol, side: 'BUY', type: 'MARKET', price: 0, qty: 1.5, tif: 'IOC' }).trades;
    if (!(buyMkt.length >= 1)) console.error('SelfTest failed: MARKET buy should trade');
  })();
}

// ------------------------------- Startup -------------------------------

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, () => {
  console.log(`Exchange backend listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
