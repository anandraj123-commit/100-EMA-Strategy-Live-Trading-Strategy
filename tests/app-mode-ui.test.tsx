import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup(element:React.ReactNode):string };
import { ObjectId } from 'mongodb';
import { NextRequest } from 'next/server';
import AppModeBadge from '../components/AppModeBadge';
import PortfolioCreationFields from '../components/PortfolioCreationFields';
import TradingDashboard from '../components/TradingDashboard';
import { getAppMode } from '../lib/app-mode';
import { getCsrfToken } from '../lib/auth/session';
import { GET as status } from '../app/api/status/route';
import { GET as list, POST as create, DELETE as remove } from '../app/api/portfolio/route';
import { PUT as editSettings } from '../app/api/settings/route';

// Existing components rely on Next's automatic JSX runtime. The test runner's
// TSX transform uses the classic React binding for those unchanged components.
(globalThis as any).React=React;
for(const appMode of ['development','testing','production'] as const){
  test(`${appMode}: header and creation fields render the server-provided read-only mode`,()=>{
    const badge=renderToStaticMarkup(<AppModeBadge appMode={appMode}/>);
    assert.match(badge,new RegExp(appMode.toUpperCase()));assert.doesNotMatch(badge,/<input|<select|<button/);
    const fields=renderToStaticMarkup(<PortfolioCreationFields appMode={appMode} symbol="BTCUSD" busy={false} input={null} onSymbolChange={()=>{}}/>);
    assert.match(fields,new RegExp(appMode.toUpperCase()));assert.match(fields,/Delta Exchange Symbol/);
    assert.doesNotMatch(fields,/<select|type="radio"|name="environment"|Trading Environment/);
    assert.equal((fields.match(/<input/g)||[]).length,1);
    const dashboard=renderToStaticMarkup(<TradingDashboard appMode={appMode} portfolioId="test"/>);
    assert.match(dashboard,new RegExp(`<h1>[\\s\\S]*${appMode.toUpperCase()}[\\s\\S]*?</h1>`));
    assert.doesNotMatch(dashboard,/MONGODB_URI|AUTH_SECRET|DELTA_API_KEY|DELTA_API_SECRET/);
  });
}

test('authenticated API creates/selects portfolios in instance mode, rejects mode editing, and exposes only safe mode',async()=>{
  const previous=(globalThis as any).mongoClientPromise,originalFetch=global.fetch;
  const userId=new ObjectId(),rows:any[]=[],settings=new Map();let calls=0;
  const db={collection(name:string){return {
    createIndex:async()=> 'index',
    findOne:async(query:any)=>{
      if(name==='sessions')return {userId};
      if(name==='users')return {_id:userId,email:'mode-test@example.test',role:'admin'};
      if(name==='portfolio')return rows.find(row=>query._id?String(row._id)===String(query._id):row.symbol===query.symbol)??null;
      if(name==='runtime_settings')return settings.get(query._id)??null;
      return null;
    },
    find:()=>({sort:()=>({toArray:async()=>rows})}),
    updateOne:async(query:any,update:any)=>{if(name==='runtime_settings')settings.set(query._id,{...update.$setOnInsert,...update.$set});return{modifiedCount:1};},
    insertOne:async(row:any)=>{assert.equal(name,'portfolio');rows.push(row);return{insertedId:row._id};}
  };}};
  (globalThis as any).mongoClientPromise=Promise.resolve({db:()=>db});
  global.fetch=async(url)=>{calls++;assert.match(String(url),/^https:\/\/cdn-ind\.testnet\.deltaex\.org\//);return new Response(JSON.stringify({success:true,result:String(url).includes('/products/')?{id:27,symbol:'BTCUSD'}:{close:123}}));};
  const token='mode-test-session',headers={cookie:`trading_session=${token}`,origin:'http://localhost','x-csrf-token':getCsrfToken(token),'content-type':'application/json'};
  const request=(body:any)=>new NextRequest('http://localhost/api/portfolio',{method:'POST',headers,body:JSON.stringify(body)});
  try{
    for(const extra of [{environment:'real'},{environment:'demo'},{appMode:'production'},{deltaEnvironment:'live'}]){
      assert.equal((await create(request({symbol:'BTCUSD',...extra}))).status,400);
    }
    assert.equal(calls,0);assert.equal(rows.length,0);
    const created=await create(request({symbol:' btcusd '}));assert.equal(created.status,201);
    const saved=(await created.json()).portfolio;assert.equal(saved.symbol,'BTCUSD');assert.equal(saved.appMode,'testing');assert.equal(saved.environment,'demo');
    assert.equal(settings.size,1);
    const before=JSON.stringify(rows);
    const denied=await remove(new NextRequest('http://localhost/api/portfolio',{method:'DELETE',headers,body:JSON.stringify({id:saved.id})}));
    assert.equal(denied.status,405);assert.match((await denied.json()).error,/deletion is not allowed/);
    assert.equal(JSON.stringify(rows),before);assert.equal(settings.size,1);
    assert.equal((await create(request({symbol:'BTCUSD'}))).status,409);
    // Legacy stored environment is not rewritten and cannot affect selection.
    rows[0].environment='real';
    const listed=await list(new NextRequest('http://localhost/api/portfolio',{headers}));
    const body=await listed.json();assert.equal(body.appMode,'testing');assert.equal(body.portfolio[0].id,saved.id);assert.equal(body.portfolio[0].environment,'demo');assert.equal(rows[0].environment,'real');
    const response=await status(new NextRequest(`http://localhost/api/status?portfolioId=${saved.id}`,{headers}));
    assert.equal(response.status,200);const snapshot=await response.json();assert.equal(snapshot.appMode,getAppMode());
    assert.equal(snapshot.running,false);
    assert.doesNotMatch(JSON.stringify(snapshot),/MONGODB|AUTH_SECRET|DELTA_API_KEY|DELTA_API_SECRET|unit-test/);
    for(const values of [{APP_MODE:'production'},{environment:'real'},{DELTA_ENV:'live'}]){
      const result=await editSettings(new NextRequest('http://localhost/api/settings',{method:'PUT',headers,body:JSON.stringify({portfolioId:saved.id,values})}));
      assert.equal(result.status,400);
    }
    assert.equal(rows[0].environment,'real');assert.equal(getAppMode(),'testing');
  }finally{global.fetch=originalFetch;if(previous===undefined)delete (globalThis as any).mongoClientPromise;else (globalThis as any).mongoClientPromise=previous;}
});
