import { findPortfolioById } from './repository';
export async function resolvePortfolioId(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))return null;return findPortfolioById(value);}
