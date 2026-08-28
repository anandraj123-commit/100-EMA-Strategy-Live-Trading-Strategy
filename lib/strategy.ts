export type Candle = { time:number; open:number; high:number; low:number; close:number };

export function emaSeries(closes:number[], length:number) {
  const out = new Array<number | null>(closes.length).fill(null);
  if (closes.length < length) return out;
  let sum = 0;
  for (let i=0;i<length;i++) sum += closes[i];
  out[length-1] = sum / length;
  const k = 2/(length+1);
  for (let i=length;i<closes.length;i++) out[i] = closes[i]*k + (out[i-1] as number)*(1-k);
  return out;
}

export function evaluateSetup(candles:Candle[], emaLen:number, slopeLookback:number) {
  if (candles.length < emaLen+slopeLookback+2) return null;
  const closes = candles.map(c=>c.close);
  const ema = emaSeries(closes, emaLen);
  const i = candles.length - 1;
  const c = candles[i];
  const e = ema[i];
  const prev = ema[i-slopeLookback];
  if (e == null || prev == null) return null;

  const trendUp = e > prev;
  const trendDown = e < prev;
  const buyPatternA = c.open < e && c.close > e;
  const buyPatternB = c.open > e && c.close > e && c.low < e;
  const sellPatternA = c.open > e && c.close < e;
  const sellPatternB = c.open < e && c.close < e && c.high > e;

  // IMPORTANT: mirror the backtester exactly.
  // BUY  -> entry trigger = SIGNAL candle HIGH, SL = SIGNAL candle LOW.
  // SELL -> entry trigger = SIGNAL candle LOW,  SL = SIGNAL candle HIGH.
  // The later breakout candle never changes the stored SL.
  if (trendUp && (buyPatternA || buyPatternB)) {
    return { direction:'long' as const, trigger:c.high, sl:c.low, candleTime:c.time, ema:e };
  }
  if (trendDown && (sellPatternA || sellPatternB)) {
    return { direction:'short' as const, trigger:c.low, sl:c.high, candleTime:c.time, ema:e };
  }
  return null;
}
