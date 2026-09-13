export type RuntimeSettingValue = string | number | boolean;

export interface RuntimeSettingsDocument {
  _id: string;
  portfolioId?: string;
  values: Record<string, RuntimeSettingValue>;
  verified?: boolean; // Missing legacy approval is false.
  entryRevision?: string;
  updatedAt: Date;
  updatedBy?: string;
}
