import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createPortfolio } from '../lib/portfolio/service';
import * as portfolios from '../lib/portfolio/repository';
import * as settings from '../lib/settings/repository';
import * as definitions from '../lib/settings/definitions';
import * as live from '../lib/settings/live';

// Exercise the production repositories against an isolated Mongo collection double.
function database(){
  const rows=new Map<string,Map<string,any>>();
  const events:string[]=[];
  let failSettings=false,failInsert=false,ambiguousInsert=false;
  const db={collection(name:string){
    if(!rows.has(name))rows.set(name,new Map());
    const documents=rows.get(name)!;
    return {
      createIndex:async()=> 'index',
      findOneAndUpdate:async(query:any,update:any)=>{const id=String(query._id),existing=documents.get(id);if(existing&&existing.ownerId!==update.$set.ownerId&&existing.expiresAt>Date.now())throw Object.assign(new Error('locked'),{code:11000});const row={_id:id,...update.$set};documents.set(id,row);return row;},
      findOne:async(query:any)=>structuredClone([...documents.values()].find(row=>Object.entries(query).every(([key,value])=>key==='expiresAt'?row[key]>(value as any).$gt:String(row[key])===String(value)))??null),
      updateOne:async(query:any,update:any)=>{
        if(failSettings)throw new Error('settings unavailable');
        const id=String(query._id),existing=documents.get(id);
        documents.set(id,structuredClone({...existing,_id:id,...(!existing?update.$setOnInsert:{}),...update.$set}));
        events.push('settings');
      },
      insertOne:async(document:any)=>{
        if(failInsert)throw new Error('insert unavailable');
        const id=document._id.toHexString();
        assert.ok(rows.get('runtime_settings')?.has(`portfolio:${id}`));
        documents.set(id,{...document});events.push('portfolio');
        if(ambiguousInsert)throw new Error('acknowledgement lost');
        return {insertedId:document._id};
      },
      deleteOne:async(query:any)=>({deletedCount:documents.delete(String(query._id))?1:0})
    };
  }};
  (globalThis as any).mongoClientPromise=Promise.resolve({db:()=>db});
  return {rows,events,setFailure:(kind:string)=>{failSettings=kind==='settings';failInsert=kind==='insert';ambiguousInsert=kind==='ambiguous';}};
}
const deps={find:portfolios.findPortfolio,insert:portfolios.insertPortfolio,product:async(symbol:string)=>({id:27,symbol}),now:()=>new Date()};
const create=(symbol:string)=>createPortfolio(symbol,'demo',deps);

// Execute unchanged worker functions in separate module contexts, with real config
// parsing/application and real settings repository reads. No orders or network I/O.
const require=createRequire(import.meta.url);
function compile(source:string){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;}
function worker(id:string){
  const configModule={exports:{} as any};
  vm.runInNewContext(compile(fs.readFileSync('lib/config.ts','utf8')),{
    module:configModule,exports:configModule.exports,process:{env:{EMA_LENGTH:'100',RR:'8',RISK_PCT:'1'},cwd:()=>process.cwd()},
    console:{log(){},warn(){}},require:(name:string)=>name==='dotenv'?{config:()=>({})}:name==='./app-mode'?require('../lib/app-mode'):require(name)
  });
  const file=ts.createSourceFile('worker.ts',fs.readFileSync('worker.ts','utf8'),ts.ScriptTarget.ES2022,true);
  const launcher=file.statements.at(-1)!;
  assert.ok(ts.isExpressionStatement(launcher)&&ts.isVoidExpression(launcher.expression));
  const source=ts.createPrinter().printFile(ts.factory.updateSourceFile(file,file.statements.slice(0,-1)));
  const module={exports:{} as any};
  const modules:Record<string,any>={'./lib/state':{readControl:()=>({running:false}),writeControl:()=>{}},'./lib/config':configModule.exports,'./lib/settings/repository':settings,'./lib/settings/definitions':definitions,'./lib/settings/live':live};
  vm.runInNewContext(compile(source+`\nruntimeFallbackSettings=runtimeConfigSnapshot(); effectiveRuntimeSettings={...runtimeFallbackSettings}; module.exports={refreshRuntimeSettings,config};`),{
    module,exports:module.exports,process:{env:{PORTFOLIO_RUNTIME_ID:id}},console,
    require:(name:string)=>modules[name]??{}
  });
  return module.exports;
}

test('creation initializes all allowed defaults, preserves edits, and isolates worker refresh/restart/deletion',async()=>{
  const db=database();
  try{
    const a=await create('AAAUSD'),b=await create('BBBUSD'),aid=a._id.toHexString(),bid=b._id.toHexString();
    assert.deepEqual(db.events,['settings','portfolio','settings','portfolio']);
    assert.equal(db.rows.get('portfolio')!.size,2);
    const stored=db.rows.get('runtime_settings')!;
    assert.equal(stored.size,2);
    assert.equal(stored.get(`portfolio:${aid}`).verified,false);
    assert.deepEqual(await settings.getRuntimeSettingOverrides(aid),definitions.runtimeSettingDefaults());
    assert.equal(stored.get(`portfolio:${aid}`).portfolioId,aid);
    assert.deepEqual(Object.keys(stored.get(`portfolio:${aid}`).values).sort(),definitions.runtimeSettingMetadata().filter(d=>d.key!=='VERIFIED').map(d=>d.key).sort());
    for(const key of Object.keys(stored.get(`portfolio:${aid}`).values))assert.doesNotMatch(key,/SECRET|PASSWORD|API_KEY|MONGODB|AUTH|SESSION|ENCRYPTION|RAILWAY/);
    await settings.saveRuntimeSettingOverrides({EMA_LENGTH:75,RR:4,RISK_PCT:2},'editor',aid);
    const edited=structuredClone(stored.get(`portfolio:${aid}`));
    await Promise.all([settings.createRuntimeSettingsIfMissing(aid),settings.createRuntimeSettingsIfMissing(aid)]);
    assert.deepEqual(stored.get(`portfolio:${aid}`),edited);
    assert.deepEqual(await settings.getRuntimeSettingOverrides(bid),definitions.runtimeSettingDefaults());
    const wa=worker(aid),wb=worker(bid);
    await wa.refreshRuntimeSettings();await wb.refreshRuntimeSettings();
    assert.equal(wa.config.emaLen,75);assert.equal(wa.config.rr,4);assert.equal(wa.config.riskPct,2);
    assert.equal(wb.config.emaLen,definitions.runtimeSettingDefaults().EMA_LENGTH);
    assert.equal(wb.config.rr,definitions.runtimeSettingDefaults().RR);
    assert.equal(wb.config.riskPct,definitions.runtimeSettingDefaults().RISK_PCT);
    assert.equal(wa.config.resolution,'5m'); // Absent key uses this worker's environment/default.
    await settings.saveRuntimeSettingOverrides({EMA_LENGTH:125,RR:6,RISK_PCT:3},'editor',aid);
    await wa.refreshRuntimeSettings();await wb.refreshRuntimeSettings();
    assert.equal(wa.config.emaLen,125);assert.equal(wa.config.rr,6);assert.equal(wa.config.riskPct,3);
    assert.equal(wb.config.emaLen,definitions.runtimeSettingDefaults().EMA_LENGTH);
    const restarted=worker(aid);await restarted.refreshRuntimeSettings();assert.equal(restarted.config.emaLen,125);
    assert.equal(await portfolios.deletePortfolio(aid),false);
    assert.ok(stored.has(`portfolio:${aid}`)); // A rejected deletion preserves settings.
    const c=await create('CCCUSD');assert.notEqual(c._id.toHexString(),aid);
    const wc=worker(c._id.toHexString());await wc.refreshRuntimeSettings();
    assert.equal(wc.config.emaLen,definitions.runtimeSettingDefaults().EMA_LENGTH);
    assert.deepEqual(await settings.getRuntimeSettingOverrides(bid),definitions.runtimeSettingDefaults());
    const missing=worker('legacy-without-settings');await missing.refreshRuntimeSettings();
    assert.equal(missing.config.emaLen,100);assert.equal(missing.config.rr,8);assert.equal(missing.config.riskPct,1);
    assert.equal(stored.has('portfolio:legacy-without-settings'),false);
  }finally{delete (globalThis as any).mongoClientPromise;}
});

test('settings failure never publishes portfolio; failed or ambiguous inserts retain safe scoped settings',async()=>{
  for(const kind of ['settings','insert','ambiguous']){
    const db=database();db.setFailure(kind);
    try{
      await assert.rejects(create('FAILUSD'),/PORTFOLIO_SAVE_FAILED/);
      assert.equal(db.rows.get('portfolio')!.size,kind==='ambiguous'?1:0);
      assert.equal(db.rows.get('runtime_settings')!.size,kind==='settings'?0:1);
    }finally{delete (globalThis as any).mongoClientPromise;}
  }
});
