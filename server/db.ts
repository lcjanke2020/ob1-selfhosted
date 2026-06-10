import { Pool } from "postgres";
import {
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_POOL_SIZE,
  DB_PORT,
  DB_USER,
} from "./config.ts";

export const pool = new Pool(
  {
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  },
  DB_POOL_SIZE,
);

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtMatch = ThoughtRecord & { similarity: number };
