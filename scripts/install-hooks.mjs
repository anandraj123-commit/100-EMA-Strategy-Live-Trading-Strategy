import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.git')) {
  console.log('No Git worktree found; hook installation skipped.');
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
