import { NextResponse } from 'next/server';
import { readStatus } from '../../../lib/state';
export const dynamic = 'force-dynamic';
export async function GET(){ return NextResponse.json(readStatus()); }
