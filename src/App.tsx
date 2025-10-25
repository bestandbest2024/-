import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import CandlestickChart, { type Candle } from './components/CandlestickChart';

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, '') ?? 'http://localhost:8080';

interface ApiOrder {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price: number;
  qty: number;
  remaining: number;
  tif: 'GTC' | 'IOC' | 'FOK';
  status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';
  ts: number;
  updatedAt: number;
}

interface ApiTrade {
  id: string;
  symbol: string;
  price: number;
  qty: number;
  ts: number;
  buyOrderId: string;
  sellOrderId: string;
}

type OrderFormState = {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  tif: 'GTC' | 'IOC' | 'FOK';
  price: string;
  qty: string;
};

const defaultForm: OrderFormState = {
  symbol: 'BTC-USD',
  side: 'BUY',
  type: 'LIMIT',
  tif: 'GTC',
  price: '100',
  qty: '0.1',
};

function toFixed(value: number) {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function App() {
  const [form, setForm] = useState<OrderFormState>(defaultForm);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [trades, setTrades] = useState<ApiTrade[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleInterval, setCandleInterval] = useState(60);

  const symbol = form.symbol.toUpperCase();

  const loadOrders = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol, status: 'OPEN,PARTIAL', limit: '200' });
      const res = await fetch(`${API_BASE}/orders?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ApiOrder[];
      setOrders(data.sort((a, b) => a.ts - b.ts));
    } catch (err) {
      console.error('Failed to load orders', err);
    }
  }, [symbol]);

  const loadTrades = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol, limit: '50' });
      const res = await fetch(`${API_BASE}/trades?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ApiTrade[];
      setTrades(data);
    } catch (err) {
      console.error('Failed to load trades', err);
    }
  }, [symbol]);

  const loadCandles = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        symbol,
        interval: String(candleInterval),
        limit: '80',
      });
      const res = await fetch(`${API_BASE}/candles?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as Candle[];
      setCandles(data);
    } catch (err) {
      console.error('Failed to load candles', err);
    }
  }, [symbol, candleInterval]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadOrders(), loadTrades(), loadCandles()]);
  }, [loadOrders, loadTrades, loadCandles]);

  useEffect(() => {
    refreshAll();
    const timer = setInterval(() => {
      refreshAll().catch(err => console.error(err));
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshAll]);

  const handleInputChange = (key: keyof OrderFormState) => (value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const body = {
        symbol: form.symbol.trim().toUpperCase(),
        side: form.side,
        type: form.type,
        price: form.type === 'MARKET' ? undefined : Number(form.price),
        qty: Number(form.qty),
        tif: form.tif,
      };
      const res = await fetch(`${API_BASE}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error ?? '下单失败');
      setMessage(`下单成功：状态 ${payload.status}`);
      await refreshAll();
    } catch (err) {
      console.error(err);
      setMessage(err instanceof Error ? err.message : '未知错误');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/orders/${id}`, { method: 'DELETE' });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload?.reason ?? '撤单失败');
      setMessage(`订单 ${id} 已撤销`);
      await refreshAll();
    } catch (err) {
      console.error(err);
      setMessage(err instanceof Error ? err.message : '撤单失败');
    }
  };

  const latestPrice = useMemo(() => trades[0]?.price ?? null, [trades]);
  const totalOpenValue = useMemo(() => {
    return orders.reduce((sum, order) => sum + (order.price || latestPrice || 0) * order.remaining, 0);
  }, [orders, latestPrice]);

  const candleOptions = useMemo(
    () => [
      { label: '1 分钟', value: 60 },
      { label: '5 分钟', value: 300 },
      { label: '15 分钟', value: 900 },
      { label: '1 小时', value: 3600 },
    ],
    [],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>多终端交易所控制台</h1>
        <p>下单、撤单、实时成交以及 K 线走势，一站式掌握。</p>
        <div className="header-metrics">
          <div>
            <span className="label">当前品种</span>
            <strong>{symbol}</strong>
          </div>
          <div>
            <span className="label">最新成交价</span>
            <strong>{latestPrice ? toFixed(latestPrice) : '—'}</strong>
          </div>
          <div>
            <span className="label">挂单总金额</span>
            <strong>{toFixed(totalOpenValue)}</strong>
          </div>
        </div>
      </header>

      <main className="layout">
        <section className="panel order-panel">
          <h2>创建订单</h2>
          <form className="order-form" onSubmit={handleSubmit}>
            <div className="field-row">
              <label>
                交易对
                <input
                  type="text"
                  value={form.symbol}
                  onChange={event => handleInputChange('symbol')(event.target.value)}
                  placeholder="如：BTC-USD"
                  required
                />
              </label>
              <label>
                买卖方向
                <select value={form.side} onChange={event => handleInputChange('side')(event.target.value)}>
                  <option value="BUY">买入</option>
                  <option value="SELL">卖出</option>
                </select>
              </label>
              <label>
                类型
                <select value={form.type} onChange={event => handleInputChange('type')(event.target.value)}>
                  <option value="LIMIT">限价</option>
                  <option value="MARKET">市价</option>
                </select>
              </label>
              <label>
                时效
                <select value={form.tif} onChange={event => handleInputChange('tif')(event.target.value)}>
                  <option value="GTC">GTC</option>
                  <option value="IOC">IOC</option>
                  <option value="FOK">FOK</option>
                </select>
              </label>
            </div>
            <div className="field-row">
              <label>
                价格
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.price}
                  onChange={event => handleInputChange('price')(event.target.value)}
                  disabled={form.type === 'MARKET'}
                  required={form.type === 'LIMIT'}
                />
              </label>
              <label>
                数量
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={form.qty}
                  onChange={event => handleInputChange('qty')(event.target.value)}
                  required
                />
              </label>
              <button type="submit" disabled={submitting} className="primary-button">
                {submitting ? '提交中…' : '提交订单'}
              </button>
            </div>
            {message && <div className="form-message">{message}</div>}
          </form>
        </section>

        <section className="panel chart-panel">
          <header className="panel-header">
            <h2>K 线走势</h2>
            <div className="interval-selector">
              <span>周期：</span>
              <select value={candleInterval} onChange={event => setCandleInterval(Number(event.target.value))}>
                {candleOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </header>
          <CandlestickChart candles={candles} />
        </section>

        <section className="panel orders-panel">
          <header className="panel-header">
            <h2>挂单管理</h2>
            <button type="button" onClick={() => refreshAll()} className="secondary-button">
              手动刷新
            </button>
          </header>
          {orders.length === 0 ? (
            <p className="empty">当前没有挂单。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>方向</th>
                  <th>价格</th>
                  <th>总量</th>
                  <th>剩余</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id}>
                    <td title={order.id}>{order.id.slice(-8)}</td>
                    <td className={order.side.toLowerCase()}>{order.side}</td>
                    <td>{toFixed(order.price)}</td>
                    <td>{order.qty}</td>
                    <td>{order.remaining.toFixed(4)}</td>
                    <td>{order.status}</td>
                    <td>
                      <button type="button" onClick={() => cancelOrder(order.id)} className="danger-button">
                        撤单
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel trades-panel">
          <h2>最新成交</h2>
          {trades.length === 0 ? (
            <p className="empty">暂无成交记录。</p>
          ) : (
            <ul className="trade-list">
              {trades.map(trade => (
                <li key={trade.id}>
                  <span>{new Date(trade.ts).toLocaleTimeString()}</span>
                  <span>{toFixed(trade.price)}</span>
                  <span>{trade.qty.toFixed(4)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
