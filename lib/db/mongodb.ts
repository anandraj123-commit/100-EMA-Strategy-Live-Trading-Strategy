import { Db, MongoClient } from 'mongodb';

const globalForMongo = globalThis as typeof globalThis & {
  mongoClientPromise?: Promise<MongoClient>;
};

function getMongoUri() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required');
  return uri;
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    globalForMongo.mongoClientPromise = new MongoClient(getMongoUri()).connect();
  }
  return globalForMongo.mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB?.trim() || 'trading_dashboard');
}

export async function closeMongoConnection(){
  const pending=globalForMongo.mongoClientPromise;
  globalForMongo.mongoClientPromise=undefined;
  if(pending)await (await pending).close();
}
