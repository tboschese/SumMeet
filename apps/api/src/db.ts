import "./env.js"; // ensure DATABASE_URL is loaded before the client is created
import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the API process.
export const db = new PrismaClient();
