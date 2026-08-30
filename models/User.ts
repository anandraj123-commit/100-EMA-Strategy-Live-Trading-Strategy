import type { ObjectId } from 'mongodb';

export type UserRole = 'admin';

export interface UserDocument {
  _id?: ObjectId;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}
