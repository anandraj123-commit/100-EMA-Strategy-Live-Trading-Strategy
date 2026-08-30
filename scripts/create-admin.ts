import bcrypt from 'bcryptjs';
import { getDb } from '../lib/db/mongodb';
import type { UserDocument } from '../models/User';

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !email.includes('@')) throw new Error('Set a valid INITIAL_ADMIN_EMAIL for this command');
  if (!password || password.length < 14) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 14 characters');

  const db = await getDb();
  const users = db.collection<UserDocument>('users');
  await users.createIndex({ email: 1 }, { unique: true });
  if (await users.findOne({ email })) throw new Error('An administrator with that email already exists');
  const now = new Date();
  await users.insertOne({ email, passwordHash: await bcrypt.hash(password, 12), role: 'admin', createdAt: now, updatedAt: now });
  console.log('Administrator created successfully.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unable to create administrator');
  process.exit(1);
});
