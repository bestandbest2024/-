import { memo, useMemo } from 'react';

type Candle = {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

interface CandlestickChartProps {
  candles: Candle[];
  width?: number;
  height?: number;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
}

function CandlestickChartComponent({ candles, width = 720, height = 360 }: CandlestickChartProps) {
  const prepared = useMemo(() => {
    if (!candles.length) return null;
    const minPrice = Math.min(...candles.map(c => c.low));
    const maxPrice = Math.max(...candles.map(c => c.high));
    const priceRange = maxPrice - minPrice || 1;
    const drawableWidth = width - 80;
    const drawableHeight = height - 60;
    const candleSpace = drawableWidth / candles.length;
    const bodyWidth = Math.max(4, candleSpace * 0.6);

    const points = candles.map((candle, idx) => {
      const x = 60 + idx * candleSpace + candleSpace / 2;
      const scaleY = (price: number) => 20 + ((maxPrice - price) / priceRange) * drawableHeight;
      const openY = scaleY(candle.open);
      const closeY = scaleY(candle.close);
      const highY = scaleY(candle.high);
      const lowY = scaleY(candle.low);
      const bullish = candle.close >= candle.open;
      return {
        candle,
        idx,
        x,
        openY,
        closeY,
        highY,
        lowY,
        bullish,
        bodyTop: bullish ? closeY : openY,
        bodyBottom: bullish ? openY : closeY,
      };
    });

    return {
      points,
      minPrice,
      maxPrice,
      bodyWidth,
    };
  }, [candles, height, width]);

  if (!prepared) {
    return (
      <div className="chart-empty">
        <p>暂时没有足够的成交数据来绘制 K 线。</p>
      </div>
    );
  }

  const { points, minPrice, maxPrice, bodyWidth } = prepared;
  const priceTicks = 5;
  const priceLabels = Array.from({ length: priceTicks }, (_, i) => {
    const value = maxPrice - ((maxPrice - minPrice) / (priceTicks - 1)) * i;
    return {
      value,
      y: 20 + ((maxPrice - value) / (maxPrice - minPrice || 1)) * (height - 60),
    };
  });

  return (
    <div className="chart-shell" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label="K 线图">
        <defs>
          <linearGradient id="gridGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(148, 163, 184, 0.35)" />
            <stop offset="100%" stopColor="rgba(30, 64, 175, 0.15)" />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill="rgba(15, 23, 42, 0.8)" rx={12} />
        {/* Horizontal grid */}
        {priceLabels.map((tick, idx) => (
          <g key={`grid-${idx}`}>
            <line
              x1={60}
              x2={width - 10}
              y1={tick.y}
              y2={tick.y}
              stroke="url(#gridGradient)"
              strokeWidth={idx === 0 || idx === priceTicks - 1 ? 1.5 : 1}
              strokeDasharray={idx === 0 || idx === priceTicks - 1 ? undefined : '6 6'}
            />
            <text x={50} y={tick.y + 4} fontSize={11} textAnchor="end" fill="#94a3b8">
              {tick.value.toFixed(2)}
            </text>
          </g>
        ))}
        {/* Vertical separators */}
        {points.map(point => (
          <line
            key={`sep-${point.idx}`}
            x1={point.x}
            x2={point.x}
            y1={20}
            y2={height - 40}
            stroke="rgba(30, 58, 138, 0.2)"
            strokeWidth={0.5}
          />
        ))}
        {/* Candles */}
        {points.map(point => (
          <g key={point.idx}>
            <line
              x1={point.x}
              x2={point.x}
              y1={point.highY}
              y2={point.lowY}
              stroke={point.bullish ? '#34d399' : '#f87171'}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
            <rect
              x={point.x - bodyWidth / 2}
              width={bodyWidth}
              y={Math.min(point.bodyTop, point.bodyBottom)}
              height={Math.max(1.5, Math.abs(point.bodyBottom - point.bodyTop))}
              fill={point.bullish ? 'rgba(52, 211, 153, 0.75)' : 'rgba(248, 113, 113, 0.75)'}
              stroke={point.bullish ? '#0f766e' : '#b91c1c'}
              strokeWidth={1}
              rx={2}
            />
          </g>
        ))}
        {/* Time labels */}
        {points.map(point => (
          <text
            key={`label-${point.idx}`}
            x={point.x}
            y={height - 20}
            fill="#64748b"
            fontSize={10}
            textAnchor="middle"
          >
            {formatTime(point.candle.startTime)}
          </text>
        ))}
        <text x={60} y={height - 5} fill="#94a3b8" fontSize={11}>
          时间 (UTC)
        </text>
      </svg>
    </div>
  );
}

const CandlestickChart = memo(CandlestickChartComponent);

export type { Candle };
export default CandlestickChart;
