import { getDb } from '../db/mongodb';
import { ObjectId } from 'mongodb';
import type { PortfolioDocument } from '../../models/Portfolio';
let indexReady:Promise<string>|null=null;
async function collection(){const rows=(await getDb()).collection<PortfolioDocument>('portfolio');indexReady??=rows.createIndex({environment:1,symbol:1},{unique:true,name:'portfolio_environment_symbol_unique'}).catch(error=>{indexReady=null;throw error;});await indexReady;return rows;}
export async function listPortfolio(){return (await collection()).find({environment:{$in:['real','demo']}}).sort({createdAt:1}).toArray();}
export async function findPortfolio(environment:PortfolioDocument['environment'],symbol:string){return (await collection()).findOne({environment,symbol});}
export async function insertPortfolio(document:Omit<PortfolioDocument,'_id'>){const result=await (await collection()).insertOne(document as PortfolioDocument);return {...document,_id:result.insertedId};}
export async function deletePortfolio(id:string){if(!ObjectId.isValid(id))return false;return (await (await collection()).deleteOne({_id:new ObjectId(id)})).deletedCount===1;}
