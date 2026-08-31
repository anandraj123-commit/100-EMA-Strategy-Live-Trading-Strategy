export function legacyPositionRequiresReconciliation(positionSize:unknown,legacyTrades:unknown[]){const size=Number(positionSize);return Number.isFinite(size)&&size!==0&&legacyTrades.length>0;}
