import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveModeConfig, type AppMode } from '../lib/app-mode';

const modes:AppMode[]=['development','testing','production'];
const keys=['MONGODB_URI','MONGODB_DB','AUTH_SECRET','DELTA_API_KEY','DELTA_API_SECRET'];
function fixture(){
  const env:Record<string,string>={};
  for(const mode of modes){const suffix=mode.toUpperCase();for(const key of keys)env[`${key}_${suffix}`]=key==='AUTH_SECRET'?`${mode}-only-secret-at-least-32-characters`:`${mode}-${key}`;}
  for(const key of [...keys,'DELTA_ENV','DELTA_LIVE_API_KEY','DELTA_LIVE_API_SECRET','DELTA_DEMO_API_KEY','DELTA_DEMO_API_SECRET'])env[key]='legacy-must-never-be-used';
  return env;
}
for(const mode of modes){
  test(`${mode}: exact database/auth/Delta mapping with all other modes and legacy variables present`,()=>{
    const env:Record<string,string>={...fixture(),APP_MODE:mode,NODE_ENV:'production'};
    const config=resolveModeConfig(env),suffix=mode.toUpperCase();
    assert.equal(config.appMode,mode);
    assert.equal(config.mongo.uri,env[`MONGODB_URI_${suffix}`]);assert.equal(config.mongo.database,env[`MONGODB_DB_${suffix}`]);
    assert.equal(config.authSecret,env[`AUTH_SECRET_${suffix}`]);assert.equal(config.delta.apiKey,env[`DELTA_API_KEY_${suffix}`]);assert.equal(config.delta.apiSecret,env[`DELTA_API_SECRET_${suffix}`]);
    assert.equal(config.delta.baseUrl,mode==='production'?'https://api.india.delta.exchange':'https://cdn-ind.testnet.deltaex.org');
    assert.equal(config.delta.environment,mode==='production'?'real':'demo');
    for(const other of modes.filter(value=>value!==mode)){for(const key of keys)assert.equal(JSON.stringify(config).includes(env[`${key}_${other.toUpperCase()}`]),false);}
    assert.equal(JSON.stringify(config).includes('legacy-must-never-be-used'),false);
    assert.ok(Object.isFrozen(config)&&Object.isFrozen(config.mongo)&&Object.isFrozen(config.delta));
  });
  test(`${mode}: unrelated mode variables are not required`,()=>{
    const env:Record<string,string>={APP_MODE:mode};for(const key of keys)env[`${key}_${mode.toUpperCase()}`]=fixture()[`${key}_${mode.toUpperCase()}`];
    assert.equal(resolveModeConfig(env).appMode,mode);
  });
  for(const key of keys)for(const bad of [undefined,'','   '])test(`${mode}: ${key} ${bad===undefined?'missing':JSON.stringify(bad)} fails without fallback`,()=>{
    const env:Record<string,string|undefined>={...fixture(),APP_MODE:mode};env[`${key}_${mode.toUpperCase()}`]=bad;
    assert.throws(()=>resolveModeConfig(env),{message:`${key}_${mode.toUpperCase()} is required when APP_MODE=${mode}.`});
  });
  test(`${mode}: short auth secret fails safely`,()=>{
    const env={...fixture(),APP_MODE:mode,[`AUTH_SECRET_${mode.toUpperCase()}`]:'short'};
    assert.throws(()=>resolveModeConfig(env),new RegExp(`AUTH_SECRET_${mode.toUpperCase()} must contain at least 32 characters`));
  });
}
for(const value of [undefined,'',' ','prod','live','demo','test','developmnt'])test(`invalid/missing APP_MODE ${JSON.stringify(value)} never derives production from NODE_ENV`,()=>{
  assert.throws(()=>resolveModeConfig({...fixture(),NODE_ENV:'production',APP_MODE:value}),/APP_MODE/);
});
test('mode normalizes surrounding whitespace and case, without consulting NODE_ENV',()=>{
  assert.equal(resolveModeConfig({...fixture(),APP_MODE:' Testing ',NODE_ENV:'production'}).appMode,'testing');
  assert.equal(resolveModeConfig({...fixture(),APP_MODE:'development',NODE_ENV:'test'}).appMode,'development');
});

// Execute the real server adapters in fresh processes. Mongo and HTTP are replaced
// with read-only doubles; no account, database, or exchange requests are made.
for(const mode of modes)test(`${mode}: Mongo/auth/public/private Delta, portfolio identity and child config agree`,()=>{
  const env:NodeJS.ProcessEnv={...process.env,...fixture(),APP_MODE:mode};
  env[`MONGODB_URI_${mode.toUpperCase()}`]=`mongodb://${mode}.invalid:27017`;
  const code=`
    const assert=require('node:assert/strict');
    const mode=require('./lib/app-mode.ts');
    const selected=mode.getModeConfig();
    const mongodb=require('mongodb');
    mongodb.MongoClient.prototype.connect=async function(){assert.equal(this.options.hosts[0].host,selected.appMode+'.invalid');return this;};
    const db=require('./lib/db/mongodb.ts');
    const auth=require('./lib/auth/config.ts');
    const config=require('./lib/config.ts');
    const delta=require('./lib/delta.ts');
    const portfolios=require('./lib/portfolio/repository.ts');
    const service=require('./lib/portfolio/service.ts');
    const child=mode.getModeChildEnvironment({...process.env,APP_MODE:'invalid'});
    assert.equal(child.APP_MODE,selected.appMode);
    assert.deepEqual(mode.resolveModeConfig(child),selected);
    const processes=require('node:child_process');
    const originalSpawn=processes.spawn;let spawned;
    processes.spawn=(executable,args,options)=>{spawned={executable,args,options};return {};};
    try {
      require('./lib/runtime/manager.ts').spawnPortfolioWorker({_id:{toHexString:()=> 'portfolio-id'}},{ownerId:'lease-owner'});
      assert.deepEqual(mode.resolveModeConfig(spawned.options.env),selected);
      assert.equal(spawned.options.env.PORTFOLIO_RUNTIME_ID,'portfolio-id');
      assert.equal(spawned.options.env.PORTFOLIO_RUNTIME_LEASE_OWNER,'lease-owner');
      assert.deepEqual(spawned.args,['worker.ts']);
    } finally { processes.spawn=originalSpawn; }

    assert.equal(auth.getAuthSecret(),selected.authSecret);
    const opposite=selected.delta.environment==='demo'?'real':'demo';
    config.configurePortfolioRuntime(opposite,'BTCUSD');
    assert.equal(config.config.env,selected.delta.env);
    assert.equal(config.baseUrl,selected.delta.baseUrl);
    const legacy={environment:opposite,symbol:'BTCUSD',productId:27};
    assert.equal(portfolios.effectivePortfolio(legacy).environment,selected.delta.environment);
    assert.equal(legacy.environment,opposite);
    const requests=[];
    global.fetch=async(url,init)=>{requests.push({url,headers:init.headers});return new Response(JSON.stringify({success:true,result:[]}));};
    (async()=>{
      assert.equal((await db.getDb()).databaseName,selected.mongo.database);
      await delta.getPublicTicker('BTCUSD',opposite);
      await delta.getPublicProduct('BTCUSD',opposite);
      await delta.getCandles('BTCUSD','5m',2);
      await delta.getEnvironmentPosition(27,opposite);
      await delta.getEnvironmentOpenOrders(27,opposite);
      await delta.getWallet();
      for(const request of requests)assert.ok(request.url.startsWith(selected.delta.baseUrl+'/'));
      for(const request of requests.slice(0,3))assert.equal(request.headers['api-key'],undefined);
      for(const request of requests.slice(3))assert.equal(request.headers['api-key'],selected.delta.apiKey);
      let inserted;
      const row=await service.createPortfolio(' btcusd ',opposite,{find:async()=>null,insert:async row=>(inserted=row),product:async(symbol,environment)=>{assert.equal(environment,selected.delta.environment);return{id:27,symbol};},now:()=>new Date()});
      assert.equal(row.environment,selected.delta.environment);assert.equal(row.symbol,'BTCUSD');
      assert.equal(service.sanitizePortfolio(row).appMode,selected.appMode);
      // Process selection stays pinned even if environment variables change later.
      process.env.APP_MODE=opposite;
      assert.equal(mode.getModeConfig(),selected);
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const result=spawnSync(process.execPath,['--import','tsx','-e',code],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  for(const key of keys)assert.equal(result.stdout.includes(env[`${key}_${mode.toUpperCase()}`]!),false,`${key} leaked`);
});

test('Next preloaded environment files cannot select a different mode from standalone workers',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'app-mode-loading-'));
  const modulePath=path.resolve('lib/app-mode.ts'),nextEnvPath=require.resolve('@next/env');
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production'};
  delete env.APP_MODE;
  for(const key of Object.keys(env))if(/^(MONGODB_URI|MONGODB_DB|AUTH_SECRET|DELTA_API_KEY|DELTA_API_SECRET)_(DEVELOPMENT|TESTING|PRODUCTION)$/.test(key))delete env[key];
  const values=fixture();
  fs.writeFileSync(path.join(directory,'.env.local'),['APP_MODE=testing',...Object.entries(values).filter(([key])=>key.endsWith('_TESTING')).map(([key,value])=>`${key}=${value}`)].join('\n'));
  fs.writeFileSync(path.join(directory,'.env.production.local'),['APP_MODE=production',...Object.entries(values).filter(([key])=>key.endsWith('_PRODUCTION')).map(([key,value])=>`${key}=${value}`)].join('\n'));
  try{
    for(const web of [false,true]){
      const result=spawnSync(process.execPath,['--import','tsx','-e',`
        process.chdir(${JSON.stringify(directory)});
        ${web?`require(${JSON.stringify(nextEnvPath)}).loadEnvConfig(process.cwd(),false);`:''}
        const mode=require(${JSON.stringify(modulePath)}).getModeConfig();
        require('node:assert/strict').equal(mode.appMode,'testing');
        require('node:assert/strict').equal(mode.delta.baseUrl,'https://cdn-ind.testnet.deltaex.org');
        require('node:assert/strict').equal(mode.mongo.database,'testing-MONGODB_DB');
      `],{env,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
