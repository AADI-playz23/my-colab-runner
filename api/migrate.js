import { Pool } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    // Add is_admin column if not exists
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
    
    // Add banned column if not exists
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`);

    res.status(200).json({ status: "success", message: "Migration complete! Added is_admin and banned columns." });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  } finally {
    await pool.end();
  }
}
