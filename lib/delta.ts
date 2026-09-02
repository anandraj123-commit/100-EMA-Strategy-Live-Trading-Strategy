import crypto from 'node:crypto';
import { baseUrl, config, getDeltaEnvironment, resolutionToSeconds,type RuntimeEnvironment } from './config';

const REQUEST_TIMEOUT_MS = 10_000;
export type DeltaErrorCode='DELTA_NETWORK_OFFLINE'|'DELTA_NETWORK_TIMEOUT'|'DELTA_AUTH_ERROR'|'DELTA_SIGNATURE_ERROR'|'DELTA_RATE_LIMITED'|'DELTA_API_ERROR'|'DELTA_SERVER_ERROR'|'DELTA_INVALID_RESPONSE'|'DELTA_UNKNOWN_ERROR';
const messages:Record<DeltaErrorCode,string>={DELTA_NETWORK_OFFLINE:'Delta network connection failed',DELTA_NETWORK_TIMEOUT:'Delta request timed out',DELTA_AUTH_ERROR:'Delta authentication failed',DELTA_SIGNATURE_ERROR:'Delta request signature was rejected',DELTA_RATE_LIMITED:'Delta rate limit exceeded',DELTA_API_ERROR:'Delta API rejected the request',DELTA_SERVER_ERROR:'Delta server error',DELTA_INVALID_RESPONSE:'Delta returned an invalid response',DELTA_UNKNOWN_ERROR:'Unknown Delta request error'};
export class DeltaRequestError extends Error{constructor(public readonly code:DeltaErrorCode,public readonly status?:number){super(`${code}: ${messages[code]}`);this.name='DeltaRequestError';}}
const evidence=(value:any)=>`${value?.error?.code??''} ${value?.error?.message??''} ${value?.message??''}`.toLowerCase();
export function classifyDeltaError(input:{error?:unknown;status?:number;payload?:unknown}):DeltaErrorCode{const error=input.error as any;if(error instanceof DeltaRequestError)return error.code;if(error?.name==='AbortError'||error?.code==='ABORT_ERR')return'DELTA_NETWORK_TIMEOUT';const detail=evidence(input.payload);if(/signature|invalid_signature|signature_mismatch/.test(detail))return'DELTA_SIGNATURE_ERROR';if(input.status===401||input.status===403)return'DELTA_AUTH_ERROR';if(input.status===429)return'DELTA_RATE_LIMITED';if(input.status!=null&&input.status>=500)return'DELTA_SERVER_ERROR';if(input.status!=null&&input.status>=400)return'DELTA_API_ERROR';if(input.payload!==undefined&&(!input.payload||typeof input.payload!=='object'))return'DELTA_INVALID_RESPONSE';if(error instanceof TypeError||['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN'].includes(error?.code))return'DELTA_NETWORK_OFFLINE';return'DELTA_UNKNOWN_ERROR';}
export function deltaErrorDetails(error:unknown){const code=classifyDeltaError({error});return {code,message:messages[code],network:code==='DELTA_NETWORK_OFFLINE'||code==='DELTA_NETWORK_TIMEOUT'};}
const failure=(input:{error?:unknown;status?:number;payload?:unknown})=>new DeltaRequestError(classifyDeltaError(input),input.status);
export type PortfolioEnvironment = 'real' | 'demo';
const PUBLIC_MARKET_URLS: Record<PortfolioEnvironment, string> = {
  real: 'https://api.india.delta.exchange',
  demo: 'https://cdn-ind.testnet.deltaex.org'
};

async function deltaFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e:any) {
    throw failure({error:e});
  } finally {
    clearTimeout(timer);
  }
}

async function deltaJson(res:Response){let json:any;try{json=await res.json();}catch{throw failure({status:res.status,payload:null});}if(!json||typeof json!=='object'||Array.isArray(json))throw failure({status:res.status,payload:json});if(!res.ok||json.success===false)throw failure({status:res.status,payload:json});return json;}

function sign(method: string, timestamp: string, path: string, query: string, body: string) {
  const message = method + timestamp + path + query + body;
  return crypto.createHmac('sha256', config.apiSecret).update(message).digest('hex');
}
function signWithSecret(secret:string,method:string,timestamp:string,path:string,query:string,body:string){return crypto.createHmac('sha256',secret).update(method+timestamp+path+query+body).digest('hex');}

function queryString(params?: Record<string, string | number | boolean | undefined>) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function publicGet(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const q = queryString(params);
  const res = await deltaFetch(baseUrl + path + q, { headers: { Accept: 'application/json', 'User-Agent': 'xautusd-nextjs-bot' }, cache: 'no-store' });
  return deltaJson(res);
}

async function publicMarketGet(environment: PortfolioEnvironment, path: string) {
  const res = await deltaFetch(PUBLIC_MARKET_URLS[environment] + path, {
    headers: { Accept: 'application/json', 'User-Agent': 'xautusd-nextjs-portfolio' },
    cache: 'no-store'
  });
  return deltaJson(res);
}

export async function getPublicProduct(symbol: string, environment: PortfolioEnvironment) {
  return (await publicMarketGet(environment, `/v2/products/${encodeURIComponent(symbol)}`)).result;
}

export async function getPublicTicker(symbol: string, environment: PortfolioEnvironment) {
  return (await publicMarketGet(environment, `/v2/tickers/${encodeURIComponent(symbol)}`)).result;
}

export async function privateRequest(method: 'GET'|'POST'|'PUT'|'DELETE', path: string, params?: Record<string, string | number | boolean | undefined>, bodyObj?: unknown) {
  if (!config.apiKey || !config.apiSecret) throw new DeltaRequestError('DELTA_AUTH_ERROR');
  const q = queryString(params);
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(method, timestamp, path, q, body);
  const res = await deltaFetch(baseUrl + path + q, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': config.apiKey,
      timestamp,
      signature,
      'User-Agent': 'node-nextjs-xautusd-bot'
    },
    body: body || undefined,
    cache: 'no-store'
  });
  return deltaJson(res);
}

async function privateEnvironmentRequest(environment:RuntimeEnvironment,method:'GET',path:string,params?:Record<string,string|number|boolean|undefined>){const resolved=getDeltaEnvironment(environment);if(!resolved.apiKey||!resolved.apiSecret)throw new DeltaRequestError('DELTA_AUTH_ERROR');const q=queryString(params),timestamp=String(Math.floor(Date.now()/1000)),signature=signWithSecret(resolved.apiSecret,method,timestamp,path,q,'');const res=await deltaFetch(resolved.baseUrl+path+q,{method,headers:{Accept:'application/json','api-key':resolved.apiKey,timestamp,signature,'User-Agent':'node-nextjs-portfolio-safety'},cache:'no-store'});return deltaJson(res);}
export async function getEnvironmentPosition(productId:number,environment:RuntimeEnvironment){return (await privateEnvironmentRequest(environment,'GET','/v2/positions',{product_id:productId})).result;}
export async function getEnvironmentOpenOrders(productId:number,environment:RuntimeEnvironment){return (await privateEnvironmentRequest(environment,'GET','/v2/orders',{product_id:productId,state:'open'})).result||[];}

export async function getProduct(symbol: string) {
  return (await publicGet(`/v2/products/${encodeURIComponent(symbol)}`)).result;
}

export async function getTicker(symbol: string) {
  return (await publicGet(`/v2/tickers/${encodeURIComponent(symbol)}`)).result;
}

export async function getCandles(symbol: string, resolution: string, count = 180) {
  const sec = resolutionToSeconds(resolution);
  const end = Math.floor(Date.now()/1000);
  const start = end - count * sec;
  const r = await publicGet('/v2/history/candles', { resolution, symbol, start, end });
  return (r.result || []).sort((a:any,b:any) => Number(a.time)-Number(b.time));
}

export async function getWallet() {
  return await privateRequest('GET', '/v2/wallet/balances');
}

export async function getPosition(productId: number) {
  return (await privateRequest('GET', '/v2/positions', { product_id: productId })).result;
}

export async function getOpenOrders(productId: number) {
  return (await privateRequest('GET', '/v2/orders', { product_id: productId, state: 'open' })).result || [];
}

export async function getOrderByClientOrderId(clientOrderId:string){return (await privateRequest('GET',`/v2/orders/client_order_id/${encodeURIComponent(clientOrderId)}`)).result;}

// Read-only reporting endpoints. They are intentionally separate from order
// execution and capped at Delta's documented maximum page size.
export function toDeltaMicroseconds(epochMilliseconds:number) {
  return Math.trunc(epochMilliseconds * 1_000);
}

export async function getOrderHistory(productId: number, startTime?: number, after?:string) {
  return await privateRequest('GET', '/v2/orders/history', {
    product_ids: String(productId), start_time: startTime, page_size: 50, after
  });
}

export async function getFills(productId: number, startTime?: number, after?:string) {
  return await privateRequest('GET', '/v2/fills', {
    product_ids: String(productId), start_time: startTime, page_size: 50, after
  });
}

export async function boundedHistory(fetchPage:(after?:string)=>Promise<any>, maxPages=10) {
  const result:any[]=[]; let after:string|undefined; const seen=new Set<string>();
  for(let page=0;page<maxPages;page++) {
    const response=await fetchPage(after);
    const next=typeof response?.meta?.after==='string'&&response.meta.after?response.meta.after:undefined;
    if((after&&next===after)||(next&&seen.has(next))) return {result,complete:false};
    if(Array.isArray(response?.result)) result.push(...response.result);
    if(!next) return {result,complete:true};
    seen.add(next);
    after=next;
  }
  return {result,complete:false};
}

export async function getOrderHistoryBounded(productId:number,startTime?:number,maxPages=10){return boundedHistory(after=>getOrderHistory(productId,startTime,after),maxPages);}
export async function getFillsBounded(productId:number,startTime?:number,maxPages=10){return boundedHistory(after=>getFills(productId,startTime,after),maxPages);}

export async function setLeverage(productId: number, leverage: number) {
  return privateRequest('POST', `/v2/products/${productId}/orders/leverage`, undefined, { leverage: String(leverage) });
}

export async function placeMarketOrder(productId: number, side: 'buy'|'sell', size: number, clientOrderId: string) {
  return privateRequest('POST', '/v2/orders', undefined, {
    product_id: productId,
    size,
    side,
    order_type: 'market_order',
    time_in_force: 'ioc',
    reduce_only: false,
    client_order_id: clientOrderId,
    cancel_orders_accepted: false
  });
}

export async function placeBracket(productId: number, sl: number, tp: number, triggerMethod: 'mark_price'|'last_traded_price'|'spot_price' = 'last_traded_price') {
  return privateRequest('POST', '/v2/orders/bracket', undefined, {
    product_id: productId,
    stop_loss_order: { order_type: 'market_order', stop_price: String(sl) },
    take_profit_order: { order_type: 'market_order', stop_price: String(tp) },
    bracket_stop_trigger_method: triggerMethod
  });
}

export async function placeProtectiveStopOrder(productId:number,side:'buy'|'sell',size:number,kind:'stop_loss_order'|'take_profit_order',stopPrice:number,triggerMethod:'mark_price'|'last_traded_price'|'spot_price',clientOrderId:string){return privateRequest('POST','/v2/orders',undefined,{product_id:productId,size,side,order_type:'market_order',stop_order_type:kind,stop_price:String(stopPrice),stop_trigger_method:triggerMethod,reduce_only:true,client_order_id:clientOrderId,cancel_orders_accepted:false});}
