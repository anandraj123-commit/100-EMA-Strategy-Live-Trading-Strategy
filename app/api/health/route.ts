import { NextResponse } from 'next/server';
import { readSupervisorHealth,supervisorHealthResponse } from '../../../lib/runtime/supervision-health';

export const dynamic='force-dynamic';
export function GET(){const response=supervisorHealthResponse(readSupervisorHealth().terminalFailure);return NextResponse.json(response.body,{status:response.status});}
