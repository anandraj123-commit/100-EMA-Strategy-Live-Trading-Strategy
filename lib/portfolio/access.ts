import { findPortfolioById } from './repository';
export async function resolvePortfolioId(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))return null;return findPortfolioById(value);}

// Read-only historical access retains the original identity after configuration deletion.
export async function resolveHistoricalPortfolioId(value:unknown){
  if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))return null;
  const portfolio=await findPortfolioById(value);
  if(portfolio)return portfolio;
  const {readPortfolioDeletion}=await import('./deletion-state');
  return (await readPortfolioDeletion(value.toLowerCase()))?.portfolio??null;
}
