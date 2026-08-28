import { NextRequest, NextResponse } from 'next/server';
import { writeControl } from '../../../lib/state';
export async function POST(req:NextRequest){
  const b = await req.json();
  writeControl({running:Boolean(b.running)});
  return NextResponse.json({success:true,running:Boolean(b.running)});
}
