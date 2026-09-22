import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('authenticated platform home links futures and keeps options disabled',()=>{
  const home=fs.readFileSync(path.join(process.cwd(),'app/page.tsx'),'utf8');
  assert.match(home,/getServerSession/);assert.match(home,/redirect\('\/login'\)/);
  assert.match(home,/href="\/futures"/);assert.match(home,/FUTURE TRADE/);
  assert.match(home,/OPTION TRADE/);assert.match(home,/COMING SOON/);assert.match(home,/aria-disabled="true"/);
  assert.doesNotMatch(home,/href="\/options"/);
});

test('futures route is authenticated and renders portfolio and application trading workspace',()=>{
  const futures=fs.readFileSync(path.join(process.cwd(),'app/futures/page.tsx'),'utf8');
  assert.match(futures,/getServerSession/);assert.match(futures,/redirect\('\/login'\)/);for(const label of ['PORTFOLIO','TRADE'])assert.match(futures,new RegExp(label));assert.match(futures,/href="\/futures\/portfolio"/);
});

test('portfolio and canonical dashboard routes are authenticated; legacy URLs redirect without selecting mode',()=>{
  const portfolio=fs.readFileSync('app/futures/portfolio/page.tsx','utf8');
  const dashboard=fs.readFileSync('app/futures/dashboard/[portfolioId]/page.tsx','utf8');
  assert.match(portfolio,/getServerSession/);assert.match(portfolio,/PortfolioManager/);
  assert.match(dashboard,/getServerSession/);assert.match(dashboard,/findPortfolioById/);assert.match(dashboard,/TradingDashboard/);
  for(const route of ['live','demo']){const source=fs.readFileSync(`app/futures/${route}/[portfolioId]/page.tsx`,'utf8');assert.match(source,/getServerSession/);assert.match(source,/redirect/);assert.match(source,/futures\/dashboard/);assert.doesNotMatch(source,/portfolio.environment/);}
});
