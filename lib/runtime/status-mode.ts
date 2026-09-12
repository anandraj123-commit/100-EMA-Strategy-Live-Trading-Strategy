import type { AppMode } from '../app-mode';
import type { BotStatus } from '../state';

// Read/display validation only. Never rewrite a snapshot or robot control file.
export function validateStatusMode(snapshot: unknown, appMode: AppMode): BotStatus {
  const status = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as BotStatus : null;
  if (status?.appMode === appMode) return status;

  const recordedMode = status?.appMode;
  const knownMode = recordedMode === 'development' || recordedMode === 'testing' || recordedMode === 'production';
  const reason = knownMode ? 'STATUS_MODE_MISMATCH' : 'STATUS_MODE_UNKNOWN';
  const message = knownMode
    ? `Worker status belongs to ${recordedMode.toUpperCase()} but this application is running in ${appMode.toUpperCase()}. Start the worker for the current application mode.`
    : `Fresh worker status required for ${appMode.toUpperCase()}. The saved status has no trusted application mode. Start the worker for the current application mode.`;
  // Construct from scratch: no prices, position, connectivity or other runtime
  // values from an untrusted snapshot may survive into this response.
  return {
    appMode, running: false, statusAvailable: false,
    currentStatus: { action: 'UNAVAILABLE', reason },
    connection: { state: 'unavailable', code: reason, error: message },
    error: message, message,
  };
}
