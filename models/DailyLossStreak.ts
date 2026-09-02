export interface DailyLossStreakDocument {
  _id: string;
  portfolioId: string;
  environment: 'real'|'demo';
  productId: number;
  symbol: string;
  tradingDay: string;
  consecutiveLosses: number;
  processedEventIds: string[];
  lastProcessedEventId: string|null;
  createdAt: Date;
  updatedAt: Date;
}
