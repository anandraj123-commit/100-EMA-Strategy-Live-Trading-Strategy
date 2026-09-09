import { getDb } from '../db/mongodb';
import { ObjectId } from 'mongodb';
import type { PortfolioDocument } from '../../models/Portfolio';
import { createRuntimeSettingsIfMissing } from '../settings/repository';
let indexReady:Promise<string>|null=null;
async function collection(){const rows=(await getDb()).collection<PortfolioDocument>('portfolio');indexReady??=rows.createIndex({environment:1,symbol:1},{unique:true,name:'portfolio_environment_symbol_unique'}).catch(error=>{indexReady=null;throw error;});await indexReady;return rows;}
export async function listPortfolio(){return (await collection()).find({environment:{$in:['real','demo']}}).sort({createdAt:1}).toArray();}
export async function findPortfolio(environment:PortfolioDocument['environment'],symbol:string){return (await collection()).findOne({environment,symbol});}
export async function findPortfolioById(id:string){if(!ObjectId.isValid(id))return null;return (await collection()).findOne({_id:new ObjectId(id)});}
export async function listPortfolioByEnvironment(environment:PortfolioDocument['environment']){return (await collection()).find({environment}).sort({createdAt:1}).toArray();}
export async function insertPortfolio(document:Omit<PortfolioDocument,'_id'>){
  const rows=await collection();
  const portfolio={...document,_id:new ObjectId()};
  // Publish the portfolio only after its defaults are durable. A failed settings
  // write cannot expose a portfolio to the manager without its settings.
  await createRuntimeSettingsIfMissing(portfolio._id.toHexString());
  // Retain settings on an ambiguous insert failure: the portfolio may have been
  // committed. Unreferenced settings are inert and IDs are never reused.
  await rows.insertOne(portfolio);
  return portfolio;
}
export async function deletePortfolio(id:string){if(!ObjectId.isValid(id))return false;return (await (await collection()).deleteOne({_id:new ObjectId(id)})).deletedCount===1;}
