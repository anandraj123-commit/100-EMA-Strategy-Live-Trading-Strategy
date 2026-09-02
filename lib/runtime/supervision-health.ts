import fs from 'node:fs';
import path from 'node:path';

export type SupervisorHealth={terminalFailure:boolean};
const defaultFile=()=>path.join(process.cwd(),'data','supervisor-health.json');

export function readSupervisorHealth(file=defaultFile()):SupervisorHealth{
  try{return JSON.parse(fs.readFileSync(file,'utf8'))?.terminalFailure===true?{terminalFailure:true}:{terminalFailure:false};}catch{return {terminalFailure:false};}
}

export function writeSupervisorHealth(terminalFailure:boolean,file=defaultFile()){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify({terminalFailure}));
  fs.renameSync(temporary,file);
}

export function supervisorHealthResponse(terminalFailure:boolean){return {status:terminalFailure?503:200,body:{status:terminalFailure?'unhealthy':'ok'}} as const;}
