import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { scanTrackedFiles } from '../scripts/scan-secrets';

test('tracked repository files contain no credential values',()=>{
  const files=execFileSync('git',['ls-files','-z']).toString().split('\0').filter(Boolean);
  assert.deepEqual(scanTrackedFiles(files),[]);
});
