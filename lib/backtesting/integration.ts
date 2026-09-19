export type SettingsValues = Record<string, string | number | boolean>;
export const fieldMap = {
  resolution: 'RESOLUTION', emaLen: 'EMA_LENGTH', slopeLookback: 'SLOPE_LOOKBACK',
  entryValidCandles: 'ENTRY_VALID_CANDLES', rr: 'RR', riskPct: 'RISK_PCT', gstPct: 'GST_PCT',
  maxLossesPerDay: 'MAX_DAILY_CONSECUTIVE_LOSSES', minStopPct: 'MIN_STOP_PCT',
  maxLeverage: 'MAX_EFFECTIVE_LEVERAGE', maxFeeRiskPct: 'MAX_FEE_RISK_PCT',
} as const;
export function researchDefaults(saved: SettingsValues, symbol: string) {
  const defaults: Record<string, string> = { symbol };
  for (const [field, key] of Object.entries(fieldMap)) {
    if (saved[key] !== undefined) defaults[field] = String(saved[key]);
  }
  return defaults;
}
export function environmentDraft(params: Record<string, unknown>, resolution: string, saved: SettingsValues) {
  const draft: SettingsValues = {};
  for (const [field, key] of Object.entries(fieldMap)) {
    const value = field === 'resolution' ? resolution : params[field];
    if (!(key in saved)) continue;
    if (field === 'resolution' ? typeof value !== 'string' || !value : typeof value !== 'number' || !Number.isFinite(value)) return null;
    draft[key] = value as string | number;
  }
  return Object.keys(draft).length ? draft : null;
}

export type OptimizerResult = { params: Record<string, unknown>; stats: { totalReturn: number; maxDD: number; totalTrades: number } };

// This gate owns only research provenance; it has no persistence or runtime dependencies.
export function createTransferGate(portfolioId: string, context: () => string) {
  let run = 0, runContext = '', successful = false;
  let results: OptimizerResult[] = [];
  let selected: { portfolioId: string; run: number; index: number } | null = null;
  return {
    begin() { run++; runContext = context(); successful = false; results = []; selected = null; },
    ranked(rows: typeof results) { results = rows; },
    complete(cancelled: boolean) { successful = !cancelled && runContext === context(); },
    invalidate() { successful = false; selected = null; },
    select(index: number) { selected = successful && results[index] ? {portfolioId, run, index} : null; },
    applicable(id: string) {
      if (id !== portfolioId || selected?.portfolioId !== id || selected.run !== run || !successful || context() !== runContext) return null;
      const result = results[selected.index];
      return result && Number.isFinite(result.stats.totalReturn) && Number.isFinite(result.stats.maxDD) && result.stats.totalTrades > 0 && Number.isFinite(result.stats.totalTrades) ? result : null;
    },
  };
}
