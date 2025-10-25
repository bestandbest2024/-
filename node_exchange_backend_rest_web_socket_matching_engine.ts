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
import fs from 'fs';
import path from 'path';
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

type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';

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

interface StoredOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number;
  qty: number;
  remaining: number;
  tif: TIF;
  status: OrderStatus;
  ts: number;
  updatedAt: number;
}

interface StoredTrade extends Trade {}

interface DatabaseShape {
  orders: Record<string, StoredOrder>;
  trades: StoredTrade[];
}

class DiskDatabase {
  private data: DatabaseShape;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.data = { orders: {}, trades: [] };
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw) as DatabaseShape;
        // basic validation
        if (parsed && typeof parsed === 'object') {
          this.data = {
            orders: parsed.orders || {},
            trades: Array.isArray(parsed.trades) ? parsed.trades : [],
          };
        }
      }
    } catch (err) {
      console.error('Failed to load database, starting with empty state', err);
      this.data = { orders: {}, trades: [] };
    }
  }

  private persist() {
    const tmp = `${this.file}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.file);
  }

  upsertOrder(order: StoredOrder) {
    this.data.orders[order.id] = { ...order };
    this.persist();
  }

  getOrder(id: string): StoredOrder | undefined {
    return this.data.orders[id];
  }

  listOrders(options: { symbol?: string | null; statuses?: OrderStatus[]; limit?: number } = {}): StoredOrder[] {
    const { symbol, statuses, limit = 500 } = options;
    const statusSet = statuses ? new Set(statuses) : null;
    const out = Object.values(this.data.orders)
      .filter(o => (!symbol || o.symbol === symbol) && (!statusSet || statusSet.has(o.status)))
      .sort((a, b) => a.ts - b.ts);
    if (out.length > limit) return out.slice(out.length - limit);
    return out;
  }

  recordTrade(trade: StoredTrade) {
    this.data.trades.push({ ...trade });
    // keep history bounded for memory/file size
    const maxTrades = 10000;
    if (this.data.trades.length > maxTrades) {
      this.data.trades.splice(0, this.data.trades.length - maxTrades);
    }
    this.persist();
  }

  recentTrades(symbol: string, limit: number): StoredTrade[] {
    const result: StoredTrade[] = [];
    for (let i = this.data.trades.length - 1; i >= 0 && result.length < limit; i -= 1) {
      const tr = this.data.trades[i];
      if (tr.symbol === symbol) result.push(tr);
    }
    return result;
  }

  candles(symbol: string, intervalSec: number, limit: number) {
    const intervalMs = Math.max(1, intervalSec) * 1000;
    const relevant = this.data.trades.filter(t => t.symbol === symbol);
    if (relevant.length === 0) return [] as { startTime: number; open: number; high: number; low: number; close: number; volume: number }[];
    relevant.sort((a, b) => a.ts - b.ts);
    const buckets = new Map<number, { startTime: number; open: number; high: number; low: number; close: number; volume: number }>();
    for (const tr of relevant) {
      const bucketStart = Math.floor(tr.ts / intervalMs) * intervalMs;
      let bucket = buckets.get(bucketStart);
      if (!bucket) {
        bucket = { startTime: bucketStart, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: tr.qty };
        buckets.set(bucketStart, bucket);
      } else {
        bucket.high = Math.max(bucket.high, tr.price);
        bucket.low = Math.min(bucket.low, tr.price);
        bucket.close = tr.price;
        bucket.volume += tr.qty;
      }
    }
    const arr = Array.from(buckets.values()).sort((a, b) => a.startTime - b.startTime);
    if (arr.length > limit) return arr.slice(arr.length - limit);
    return arr;
  }

  snapshot(): DatabaseShape {
    return {
      orders: { ...this.data.orders },
      trades: [...this.data.trades],
    };
  }
}

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const databaseFile = path.join(dataDir, 'exchange-db.json');
const diskDb = new DiskDatabase(databaseFile);

function orderStatusFrom(order: Order, explicit?: OrderStatus): OrderStatus {
  if (explicit) return explicit;
  if (order.remaining <= 0) return 'FILLED';
  if (order.remaining < order.qty) return 'PARTIAL';
  return 'OPEN';
}

function persistOrder(order: Order, status?: OrderStatus) {
  const record: StoredOrder = {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: order.price,
    qty: order.qty,
    remaining: order.remaining,
    tif: order.tif,
    status: orderStatusFrom(order, status),
    ts: order.ts,
    updatedAt: Date.now(),
  };
  diskDb.upsertOrder(record);
}

function persistTrade(trade: Trade) {
  diskDb.recordTrade({ ...trade });
}

function hydrateStateFromDisk() {
  const snapshot = diskDb.snapshot();
  const openOrders = Object.values(snapshot.orders).filter(o => o.status === 'OPEN' || o.status === 'PARTIAL');
  openOrders.sort((a, b) => a.ts - b.ts);
  for (const row of openOrders) {
    const order: Order = {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      price: row.price,
      qty: row.qty,
      remaining: row.remaining,
      tif: row.tif,
      ts: row.ts,
    };
    if (order.remaining > 0) {
      const ob = getBook(order.symbol);
      addToBook(ob, order);
      liveOrders.set(order.id, order);
    }
  }

  const tradesBySymbol: Record<string, Trade[]> = {};
  for (const tr of snapshot.trades) {
    const list = tradesBySymbol[tr.symbol] || (tradesBySymbol[tr.symbol] = []);
    list.push({ ...tr });
  }
  for (const [symbol, list] of Object.entries(tradesBySymbol)) {
    list.sort((a, b) => b.ts - a.ts);
    recentTrades[symbol] = list.slice(0, 500);
  }
}

hydrateStateFromDisk();

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
  persistTrade(tr);
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

      persistOrder(resting, resting.remaining <= 0 ? 'FILLED' : undefined);
      persistOrder(incoming, incoming.remaining <= 0 ? 'FILLED' : undefined);

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
      const status = trades.length ? 'PARTIAL' : 'CANCELLED';
      persistOrder(order, status);
      return { order, trades, status };
    }
    // LIMIT order: check TIF
    if (order.tif === 'FOK') {
      // if not fully filled immediately, cancel the whole thing
      if (trades.length === 0 || order.remaining > 0) {
        // revert nothing needs revert because we never rested it
        order.remaining = 0; // indicate not resting
        const status = trades.length ? 'PARTIAL' : 'CANCELLED';
        persistOrder(order, status);
        return { order, trades, status };
      }
    }
    if (order.tif === 'IOC') {
      // cancel remainder
      order.remaining = 0;
      const status = trades.length ? 'PARTIAL' : 'CANCELLED';
      persistOrder(order, status);
      return { order, trades, status };
    }
    // GTC: rest the remainder on the book
    addToBook(ob, order);
    liveOrders.set(order.id, order);
    pushBook(ob.symbol);
    const status = trades.length ? 'PARTIAL' : 'OPEN';
    persistOrder(order, status);
    return { order, trades, status };
  }

  // fully filled
  pushBook(ob.symbol);
  persistOrder(order, 'FILLED');
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
  persistOrder(o, 'CANCELLED');
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

function parseStatuses(raw: any): OrderStatus[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const allowed: OrderStatus[] = ['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED'];
  const requested = raw.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) as OrderStatus[];
  const filtered = requested.filter(x => allowed.includes(x));
  return filtered.length ? filtered : undefined;
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

app.get('/orders', (req, res) => {
  const symbol = req.query.symbol ? parseSymbol(req.query.symbol) : null;
  if (req.query.symbol && !symbol) return res.status(400).json({ error: 'INVALID_SYMBOL' });
  const statuses = parseStatuses(req.query.status);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const list = diskDb.listOrders({ symbol: symbol ?? undefined, statuses, limit });
  return res.json(list);
});

app.get('/orders/:id', (req, res) => {
  const stored = diskDb.getOrder(req.params.id);
  if (stored) return res.json(stored);
  const live = liveOrders.get(req.params.id);
  if (live) {
    return res.json({
      id: live.id,
      symbol: live.symbol,
      side: live.side,
      type: live.type,
      price: live.price,
      qty: live.qty,
      remaining: live.remaining,
      tif: live.tif,
      status: orderStatusFrom(live),
      ts: live.ts,
      updatedAt: Date.now(),
    });
  }
  return res.status(404).json({ error: 'NOT_FOUND' });
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
  const list = diskDb.recentTrades(symbol, n);
  return res.json(list);
});

app.get('/candles', (req, res) => {
  const symbol = parseSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: 'INVALID_SYMBOL' });
  const interval = Math.max(1, Math.min(24 * 60 * 60, Number(req.query.interval) || 60));
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 120));
  const candles = diskDb.candles(symbol, interval, limit);
  return res.json(candles);
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
