import { getAppMode } from '../app-mode';
import { readControl,readStatus } from '../state';
import { validateStatusMode } from '../runtime/status-mode';
import { runtimeSettingDefaults } from './definitions';
import { getRuntimeSettingsSnapshot } from './repository';

// Read-only permission restriction: never promote a stopped worker to running,
// relabel a foreign snapshot, or hide valid account/open-position information.
export async function readPortfolioRuntimeStatus(id:string){
  const status=validateStatusMode(readStatus(id),getAppMode());
  if(status.statusAvailable===false)return status;
  try{
    const settings=await getRuntimeSettingsSnapshot(id),values={...runtimeSettingDefaults(),...settings.values};
    const verified=values.VERIFIED===true,autoTrade=values.AUTO_TRADE===true;
    const running=status.running===true&&readControl(id).running===true&&verified&&autoTrade&&status.entryRevision===settings.entryRevision;
    const size=Number((status.position as any)?.size);
    return {...status,verified,running,effectiveAutoTrade:running&&autoTrade,pending:running?status.pending:null,
      ...(!running?{currentStatus:{action:'STOPPED',reason:Number.isFinite(size)&&size!==0?'POSITION_STILL_OPEN':!verified?'ENVIRONMENT_NOT_VERIFIED':!autoTrade?'AUTO_TRADE_OFF':'ROBOT_STOPPED'}}:{})};
  }catch{return {...status,running:false,effectiveAutoTrade:false,pending:null,currentStatus:{action:'STOPPED',reason:'SETTINGS_UNAVAILABLE'}};}
}
