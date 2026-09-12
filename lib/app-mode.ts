import dotenv from 'dotenv';
import path from 'node:path';
import { initialEnv } from '@next/env';

// Shared by Next.js, command-line utilities, supervisor and child workers.
// Mode configuration has exactly two sources: deployment variables and .env.local.
// Next exposes its original process environment before its NODE_ENV-specific file
// loading. Use that original environment so next start and tsx cannot select
// different trading modes through .env.production.local or variable expansion.
const localEnvironment = dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false }).parsed ?? {};

export type AppMode = 'development' | 'testing' | 'production';
export type DeltaEnvironment = 'demo' | 'real';
type Environment = Record<string, string | undefined>;
const suffixes = { development: 'DEVELOPMENT', testing: 'TESTING', production: 'PRODUCTION' } as const;
const endpoints = { demo: 'https://cdn-ind.testnet.deltaex.org', real: 'https://api.india.delta.exchange' } as const;

export function resolveModeConfig(env: Environment) {
  const value = env.APP_MODE?.trim().toLowerCase();
  if (!value) throw new Error('APP_MODE is required.');
  if (value !== 'development' && value !== 'testing' && value !== 'production') {
    throw new Error('Invalid APP_MODE. Expected development, testing, or production.');
  }
  const appMode: AppMode = value;
  const suffix = suffixes[appMode];
  const required = (name: string) => {
    const key = `${name}_${suffix}`, value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required when APP_MODE=${appMode}.`);
    return value;
  };
  const mongoUri = required('MONGODB_URI'), mongoDb = required('MONGODB_DB');
  const authSecret = required('AUTH_SECRET');
  if (authSecret.length < 32) throw new Error(`AUTH_SECRET_${suffix} must contain at least 32 characters.`);
  const apiKey = required('DELTA_API_KEY'), apiSecret = required('DELTA_API_SECRET');
  const environment: DeltaEnvironment = appMode === 'production' ? 'real' : 'demo';
  return Object.freeze({
    appMode,
    mongo: Object.freeze({ uri: mongoUri, database: mongoDb }),
    authSecret,
    delta: Object.freeze({ environment, env: environment === 'real' ? 'live' as const : 'demo' as const,
      baseUrl: endpoints[environment], apiKey, apiSecret,
      credentialLabels: [`DELTA_API_KEY_${suffix}`, `DELTA_API_SECRET_${suffix}`] as const }),
  });
}

// Keep one immutable selection across Next.js development module reloads too.
const processConfig = globalThis as typeof globalThis & { appModeConfig?: ReturnType<typeof resolveModeConfig> };
export function getModeConfig() {
  let resolved = processConfig.appModeConfig;
  if (!resolved) {
    resolved = resolveModeConfig({ ...localEnvironment, ...(initialEnv ?? process.env) });
    processConfig.appModeConfig = resolved;
    console.log('[config] APP_MODE:', resolved.appMode);
    console.log('[config] DATABASE MODE:', resolved.appMode);
    console.log('[config] DELTA ENVIRONMENT:', resolved.delta.env);
  }
  return resolved;
}
export const getAppMode = () => getModeConfig().appMode;
export const getMongoConfig = () => getModeConfig().mongo;
export const getDeltaConfig = () => getModeConfig().delta;

// Pin the selected configuration when spawning children; no other mode is used.
export function getModeChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const mode = getModeConfig(), suffix = suffixes[mode.appMode];
  return { ...env, APP_MODE: mode.appMode,
    [`MONGODB_URI_${suffix}`]: mode.mongo.uri, [`MONGODB_DB_${suffix}`]: mode.mongo.database,
    [`AUTH_SECRET_${suffix}`]: mode.authSecret,
    [`DELTA_API_KEY_${suffix}`]: mode.delta.apiKey, [`DELTA_API_SECRET_${suffix}`]: mode.delta.apiSecret };
}
