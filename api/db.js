import { Pool } from '@neondatabase/serverless';

// Create a single connection pool instance
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default pool;
