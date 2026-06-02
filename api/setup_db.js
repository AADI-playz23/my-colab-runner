import { Pool } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(50) DEFAULT 'free',
        cpu_minutes_used INT DEFAULT 0,

        week_ends_at BIGINT DEFAULT 0,
        session_active VARCHAR(255),
        is_admin BOOLEAN DEFAULT FALSE,
        banned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'queued',
        plan VARCHAR(50) DEFAULT 'free',
        timeout_secs INT DEFAULT 1800,
        worker_url VARCHAR(255),
        started_at BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vms (
        id VARCHAR(255) PRIMARY KEY,
        worker_url VARCHAR(255) NOT NULL,
        active_users INT DEFAULT 0,
        last_heartbeat BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add is_admin and banned columns if they don't exist (Migrations)
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`);
    } catch (e) {
      // Ignore column already exists errors if they pop up
    }

    res.status(200).json({ status: "success", message: "Neon Database tables and migrations ran successfully!" });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  } finally {
    await pool.end();
  }
}
