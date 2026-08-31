export type RuntimeSettingValue = string | number | boolean;

export interface RuntimeSettingsDocument {
  _id: 'runtime-settings';
  values: Record<string, RuntimeSettingValue>;
  updatedAt: Date;
  updatedBy?: string;
}
