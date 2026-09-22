import React from 'react';
import type { AppMode } from '../lib/app-mode';
export default function AppModeBadge({ appMode }: { appMode: AppMode }) {
  return <strong className={`appModeBadge ${appMode}`} aria-label="Application mode">{appMode.toUpperCase()}</strong>;
}
