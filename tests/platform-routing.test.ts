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

test('portfolio page is authenticated and existing dashboard remains protected separately',()=>{const portfolio=fs.readFileSync(path.join(process.cwd(),'app/futures/portfolio/page.tsx'),'utf8'),dashboard=fs.readFileSync(path.join(process.cwd(),'app/futures/dashboard/page.tsx'),'utf8');assert.match(portfolio,/getServerSession/);assert.match(portfolio,/redirect\('\/login'\)/);assert.match(portfolio,/PortfolioManager/);assert.match(dashboard,/getServerSession/);assert.match(dashboard,/TradingDashboard/);});
