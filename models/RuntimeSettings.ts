export type RuntimeSettingValue = string | number | boolean;

export interface RuntimeSettingsDocument {
  _id: string;
  portfolioId?: string;
  values: Record<string, RuntimeSettingValue>;
  updatedAt: Date;
  updatedBy?: string;
}
