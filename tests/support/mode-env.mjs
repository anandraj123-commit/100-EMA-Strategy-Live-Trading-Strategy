// Non-secret, non-routable configuration for automated checks only.
// This is explicit test setup, never a runtime NODE_ENV fallback.
export const modeTestEnvironment = {
  APP_MODE: 'testing',
  MONGODB_URI_TESTING: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50',
  MONGODB_DB_TESTING: 'app_mode_unit_tests',
  AUTH_SECRET_TESTING: 'unit-test-only-secret-at-least-32-characters',
  DELTA_API_KEY_TESTING: 'unit-test-key',
  DELTA_API_SECRET_TESTING: 'unit-test-secret',
};
