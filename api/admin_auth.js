import pool from './db.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const op = req.body.op || '';
  const username = req.body.username || '';
  const password = req.body.password || '';

  if (!username || !password) return res.status(400).json({ status: "error", message: "Missing credentials" });

  if (op === 'register') {
    try {
      // Check if an admin already exists
      const checkAdmin = await pool.query('SELECT id FROM users WHERE is_admin = TRUE');
      if (checkAdmin.rows.length > 0) {
        return res.status(403).json({ status: "error", message: "Admin registration is locked. An admin already exists." });
      }

      // Ensure user doesn't already exist
      const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        return res.status(400).json({ status: "error", message: "Username already taken." });
      }
      
      const hash = await bcrypt.hash(password, 10);
      const now = Math.floor(Date.now() / 1000);
      
      await pool.query(
        'INSERT INTO users (username, password, week_ends_at, is_admin) VALUES ($1, $2, $3, TRUE)', 
        [username, hash, now + 604800]
      );
      
      return res.status(200).json({ status: "success", message: "Admin registered successfully." });
    } catch (e) {
      return res.status(500).json({ status: "error", message: "Database error." });
    }
  }
  
  if (op === 'login') {
    try {
      const result = await pool.query('SELECT id, password, is_admin FROM users WHERE username = $1 AND is_admin = TRUE', [username]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        
        const valid = await bcrypt.compare(password, user.password);

        if (valid) {
          return res.status(200).json({ status: "success", username });
        } else {
          return res.status(401).json({ status: "error", message: "Incorrect Password" });
        }
      } else {
        return res.status(404).json({ status: "error", message: "Admin not found." });
      }
    } catch (e) {
      return res.status(500).json({ status: "error", message: "Database error." });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
