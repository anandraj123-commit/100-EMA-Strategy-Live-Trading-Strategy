import type { ObjectId } from 'mongodb';
import type { PortfolioEnvironment } from '../lib/delta';
export interface PortfolioDocument{_id?:ObjectId;symbol:string;productId:number;name:string|null;contractValue:number|null;settlingAsset:string|null;underlyingAsset:string|null;environment:PortfolioEnvironment;createdAt:Date;updatedAt:Date;}
