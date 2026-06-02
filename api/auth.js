import pool from './db.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const op = req.query.op || req.body.op || '';
  const username = req.body.username || '';
  const password = req.body.password || '';

  if (op === 'login') {
    if (!username || !password) return res.status(400).json({ status: "error", message: "Missing credentials" });
    
    try {
      const result = await pool.query('SELECT id, password, banned, is_admin FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        
        if (user.banned) {
          return res.status(403).json({ status: "error", message: "Account has been banned for TOS violations." });
        }
        
        let valid = false;
        
        // Handle migration from plain text
        if (password === user.password) {
          valid = true;
          const hash = await bcrypt.hash(password, 10);
          await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
        } else {
          valid = await bcrypt.compare(password, user.password);
        }

        if (valid) {
          return res.status(200).json({ status: "success", username, is_admin: user.is_admin });
        } else {
          return res.status(401).json({ status: "error", message: "Incorrect Password" });
        }
      } else {
        return res.status(404).json({ status: "error", message: "User not found. Please register." });
      }
    } catch (e) {
      return res.status(500).json({ status: "error", message: "Database query failed." });
    }
  }

  if (op === 'register') {
    if (!username || !password) return res.status(400).json({ status: "error", message: "Missing credentials" });
    
    try {
      const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        return res.status(400).json({ status: "error", message: "User already exists" });
      }
      
      const hash = await bcrypt.hash(password, 10);
      const now = Math.floor(Date.now() / 1000);
      
      await pool.query(
        'INSERT INTO users (username, password, week_ends_at) VALUES ($1, $2, $3)', 
        [username, hash, now + 604800]
      );
      
      return res.status(200).json({ status: "success", message: "Registered successfully" });
    } catch (e) {
      return res.status(500).json({ status: "error", message: "Database error." });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
