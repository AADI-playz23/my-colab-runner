import pool from './db.js';

export default async function handler(req, res) {
  try {
    const result = await pool.query('SELECT 1 as test');
    if (result.rows[0].test === 1) {
      return res.status(200).json({ status: "success", message: "PostgreSQL connected successfully!" });
    }
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
