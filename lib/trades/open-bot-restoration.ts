import type { TradeDocument } from '../../models/Trade';

export function restoreOpenBotTrade(record:TradeDocument,position:{size?:unknown;entry_price?:unknown},ownership:{botOwnedContracts:number;mixedPosition:boolean},fallbackContractValue:number) {
  return {
    direction:record.side==='SHORT'?'short':'long',
    entryPrice:Number(record.actualEntryPrice??record.intendedEntryPrice??position.entry_price??0),
    actualEntryPrice:record.actualEntryPrice,
    trigger:record.intendedEntryPrice,
    sl:record.initialSL,
    tp:record.takeProfit,
    contracts:Number(record.contracts),
    ownedContracts:ownership.botOwnedContracts,
    contractValue:Number(record.contractValue??fallbackContractValue??0),
    positionSize:Number(position.size??0),
    orderId:record.entryOrderId,
    clientOrderId:record.entryClientOrderId,
    entryFillIds:record.entryFillIds??[],
    openedAt:record.entryTime?.valueOf()??null,
    riskAmount:record.riskAmount??null,
    takerRate:record.takerRate??null,
    gstPct:record.gstPct??null,
    source:'bot' as const,
    attributionStatus:'BOT_CONFIRMED' as const,
    mixedPosition:ownership.mixedPosition,
    tradeId:record.tradeId,
    exchangeSync:null,
    entryIntentId:record.entryIntentId??null,
    protectionState:record.protectionState??'REPAIR_REQUIRED',
    strategyConfig:record.strategyConfig
  };
}
