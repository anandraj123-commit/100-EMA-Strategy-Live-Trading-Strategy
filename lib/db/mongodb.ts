import { Db, MongoClient } from 'mongodb';
import { getMongoConfig } from '../app-mode';

const globalForMongo = globalThis as typeof globalThis & {
  mongoClientPromise?: Promise<MongoClient>;
};

export function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    globalForMongo.mongoClientPromise = new MongoClient(getMongoConfig().uri).connect();
  }
  return globalForMongo.mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getMongoConfig().database);
}

export async function closeMongoConnection(){
  const pending=globalForMongo.mongoClientPromise;
  globalForMongo.mongoClientPromise=undefined;
  if(pending)await (await pending).close();
}
