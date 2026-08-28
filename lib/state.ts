import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'data');
const statusFile = path.join(dir, 'status.json');
const controlFile = path.join(dir, 'control.json');
fs.mkdirSync(dir, { recursive: true });

export type BotStatus = Record<string, unknown>;

export function writeStatus(v: BotStatus) { fs.writeFileSync(statusFile, JSON.stringify(v, null, 2)); }
export function readStatus(): BotStatus {
  try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return { running:false, message:'Worker has not started yet' }; }
}
export function readControl() {
  try { return JSON.parse(fs.readFileSync(controlFile, 'utf8')); } catch { return { running:false }; }
}
export function writeControl(v:{running:boolean}) { fs.writeFileSync(controlFile, JSON.stringify(v, null, 2)); }
