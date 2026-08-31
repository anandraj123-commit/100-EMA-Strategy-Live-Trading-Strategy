import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });
const safeId=(portfolioId?:string)=>portfolioId&&/^[a-f0-9]{24}$/i.test(portfolioId)?portfolioId:'legacy';
const statusFile=(portfolioId?:string)=>path.join(dir,`status-${safeId(portfolioId)}.json`);
const controlFile=(portfolioId?:string)=>path.join(dir,`control-${safeId(portfolioId)}.json`);
const activityFile=(portfolioId?:string)=>path.join(dir,`activity-${safeId(portfolioId)}.json`);

export type BotStatus = Record<string, unknown>;

export function writeStatus(v: BotStatus,portfolioId?:string) { fs.writeFileSync(statusFile(portfolioId), JSON.stringify(v, null, 2)); }
export function readStatus(portfolioId?:string): BotStatus {
  try { return JSON.parse(fs.readFileSync(statusFile(portfolioId), 'utf8')); } catch { return { running:false, message:'Worker has not started yet' }; }
}
export function readControl(portfolioId?:string) {
  try { return JSON.parse(fs.readFileSync(controlFile(portfolioId), 'utf8')); } catch { return { running:false }; }
}
export function writeControl(v:{running:boolean},portfolioId?:string) { fs.writeFileSync(controlFile(portfolioId), JSON.stringify(v, null, 2)); }
export function readRuntimeActivity(portfolioId?:string){try{return JSON.parse(fs.readFileSync(activityFile(portfolioId),'utf8'));}catch{return {executionInProgress:false};}}
export function writeRuntimeActivity(v:{executionInProgress:boolean},portfolioId?:string){fs.writeFileSync(activityFile(portfolioId),JSON.stringify({...v,updatedAt:new Date().toISOString()},null,2));}
