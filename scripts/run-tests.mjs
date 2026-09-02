import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);
const testFilePattern = /(?:^|[.\-_])(test|spec)\.[cm]?[jt]sx?$/i;

async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await discoverTests(absolutePath));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      tests.push(path.relative(root, absolutePath));
    }
  }

  return tests;
}

const tests = (await discoverTests(root)).sort();
if (tests.length === 0) {
  console.error('No test files were discovered.');
  process.exit(1);
}

console.log(`Discovered ${tests.length} test files.`);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...tests],
  { cwd: root, stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
