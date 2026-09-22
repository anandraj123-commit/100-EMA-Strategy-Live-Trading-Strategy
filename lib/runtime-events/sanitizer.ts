// One boundary for both structured credentials and credentials embedded in errors.
const secretKey=/api.?key|api.?secret|authorization|cookie|password|passwd|token|secret|mongo.*uri|credential|private.?key/i;
export function sanitize(value:unknown, secrets:string[]=Object.entries(process.env).filter(([key])=>secretKey.test(key)).map(([,v])=>v||'').filter(v=>v.length>=4)):any {
  const seen=new WeakSet<object>();
  const text=(input:string)=>{
    let result=input;
    for(const secret of secrets)result=result.split(secret).join('[REDACTED]');
    return result.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,'[REDACTED_MONGODB_URI]')
      .replace(/\bBearer\s+[^\s,"']+/gi,'Bearer [REDACTED]')
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,'[REDACTED_TOKEN]')
      .replace(/((?:api[_-]?(?:key|secret)|authorization|password|access[_-]?token|refresh[_-]?token|secret)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]');
  };
  const visit=(v:any,depth:number):any=>{
    if(typeof v==='string')return text(v);
    if(v==null||typeof v==='boolean'||typeof v==='number')return v;
    if(v instanceof Date)return new Date(v);
    if(typeof v!=='object')return undefined;
    if(depth>40)throw new Error('Runtime event exceeds nesting limit');
    if(seen.has(v))return '[CIRCULAR]';
    seen.add(v);
    let result:any;
    if(v instanceof Error)result={name:text(v.name),message:text(v.message)};
    else if(typeof v.toHexString==='function')result=v.toHexString();
    else if(Array.isArray(v))result=v.map(item=>visit(item,depth+1));
    else {result={};for(const [key,item] of Object.entries(v)){
      if(key==='__proto__'||key==='constructor'||key==='prototype')continue;
      result[key]=secretKey.test(key)?'[REDACTED]':visit(item,depth+1);
    }}
    seen.delete(v);return result;
  };
  return visit(value,0);
}
