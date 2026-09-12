import { getModeConfig } from './lib/app-mode';
try {
  getModeConfig();
  console.log('[config] Selected mode configuration valid; credentials present.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid application configuration.');
  process.exitCode = 1;
}
