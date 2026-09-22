import { getModeConfig } from '../app-mode';

export const SESSION_COOKIE_NAME = 'trading_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function getAuthSecret() { return getModeConfig().authSecret; }
