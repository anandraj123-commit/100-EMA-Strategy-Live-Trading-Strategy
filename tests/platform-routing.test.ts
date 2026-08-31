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

test('futures route is authenticated and renders portfolio, live, and demo workspaces',()=>{
  const futures=fs.readFileSync(path.join(process.cwd(),'app/futures/page.tsx'),'utf8');
  assert.match(futures,/getServerSession/);assert.match(futures,/redirect\('\/login'\)/);for(const label of ['PORTFOLIO','LIVE TRADE','DEMO TRADE'])assert.match(futures,new RegExp(label));assert.match(futures,/href="\/futures\/portfolio"/);
});

test('portfolio and environment-specific dashboard routes are authenticated',()=>{const portfolio=fs.readFileSync(path.join(process.cwd(),'app/futures/portfolio/page.tsx'),'utf8'),live=fs.readFileSync(path.join(process.cwd(),'app/futures/live/[portfolioId]/page.tsx'),'utf8'),demo=fs.readFileSync(path.join(process.cwd(),'app/futures/demo/[portfolioId]/page.tsx'),'utf8');assert.match(portfolio,/getServerSession/);assert.match(portfolio,/PortfolioManager/);for(const route of [live,demo]){assert.match(route,/getServerSession/);assert.match(route,/TradingDashboard/);assert.match(route,/findPortfolioById/);}assert.match(live,/environment!=='real'/);assert.match(demo,/environment!=='demo'/);});
