export const SESSION_COOKIE_NAME = 'trading_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 characters');
  }
  return secret;
}
