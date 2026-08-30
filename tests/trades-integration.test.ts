import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { NextRequest } from 'next/server';
import { getMongoClient } from '../lib/db/mongodb';

const uri=process.env.TRADE_TEST_MONGODB_URI;
test('MongoDB trade upsert, indexes, statistics, authentication and pagination',{skip:!uri},async()=>{
  const databaseName=`trade_test_${crypto.randomBytes(8).toString('hex')}`;process.env.MONGODB_URI=uri;process.env.MONGODB_DB=databaseName;process.env.AUTH_SECRET='trade-test-auth-secret-at-least-32-characters';
  const applicationMongo=await getMongoClient();const mongo=new MongoClient(uri as string);
  try{
    await mongo.connect();
    const repository=await import('../lib/trades/repository');const session=await import('../lib/auth/session');const historyRoute=await import('../app/api/trades/route');const statsRoute=await import('../app/api/trades/stats/route');
    const base:any={tradeId:'bot:1:stable',symbol:'XAUTUSD',productId:1,side:'LONG',source:'bot',attributionStatus:'BOT_CONFIRMED',status:'CLOSED',entryTime:new Date(),intendedEntryPrice:100,actualEntryPrice:100,quantity:1,contracts:1,contractValue:1,initialSL:90,takeProfit:120,exitTime:new Date(),intendedExitPrice:110,actualExitPrice:110,exitReason:'TP',grossPnL:10,brokerage:1,GST:0.18,otherCharges:0,totalCharges:1.18,netPnL:8.82,estimatedBrokerage:null,estimatedGST:null,estimatedTotalCharges:null,estimatedNetPnL:null,realizedR:0.882,entryOrderId:'10',exitOrderId:'11',entryClientOrderId:'ema-test',exitClientOrderId:null,entryFillIds:['100'],exitFillIds:['101'],financialStatus:'actual',feeDataSource:'delta_fills_commission',priceDataSource:'delta_weighted_fills',attributionNote:null,reconciliationError:null,reconciledAt:new Date()};
    await repository.upsertTrade({...base,status:'OPEN',exitTime:null});await repository.upsertTrade(base);await repository.upsertTrade({...base,grossPnL:11});assert.equal(await mongo.db(databaseName).collection('trades').countDocuments(),1);assert.equal((await mongo.db(databaseName).collection('trades').findOne({tradeId:base.tradeId}))?.status,'CLOSED');
    await repository.upsertTrade({...base,tradeId:'manual:1:stable',source:'exchange_existing',attributionStatus:'MANUAL_CONFIRMED',entryOrderId:null,entryClientOrderId:null});
    const stats=await repository.getTradeStats();assert.equal(stats.bot.totalTrades,1);assert.equal(stats.manual.totalTrades,1);assert.equal(stats.account.totalTrades,2);assert.equal(stats.account.brokerage,stats.bot.brokerage+stats.manual.brokerage);assert.equal(stats.account.brokerageReportedTrades,stats.bot.brokerageReportedTrades+stats.manual.brokerageReportedTrades);assert.equal(stats.account.netPnLComplete,true);
    const userId=new ObjectId();await mongo.db(databaseName).collection('users').insertOne({_id:userId,email:'trade@example.test',passwordHash:'unused',role:'admin',createdAt:new Date(),updatedAt:new Date()});const auth=await session.createSession(userId);const cookie=`trading_session=${auth.token}`;
    assert.equal((await historyRoute.GET(new NextRequest('http://localhost/api/trades?source=invalid',{headers:{cookie}}))).status,400);assert.equal((await historyRoute.GET(new NextRequest('http://localhost/api/trades?limit=101',{headers:{cookie}}))).status,400);
    const page=await historyRoute.GET(new NextRequest('http://localhost/api/trades?source=bot&limit=1',{headers:{cookie}}));assert.equal(page.status,200);assert.equal((await page.json()).trades.length,1);assert.equal((await statsRoute.GET(new NextRequest('http://localhost/api/trades/stats',{headers:{cookie}}))).status,200);
    const indexes=await mongo.db(databaseName).collection('trades').indexInformation();assert.ok(indexes.trade_identity_unique);assert.ok(indexes.source_exit_time);assert.ok(indexes.symbol_exit_time);
  }finally{
    try{await mongo.db(databaseName).dropDatabase();}
    finally{try{await mongo.close();}finally{await applicationMongo.close();}}
  }
});
