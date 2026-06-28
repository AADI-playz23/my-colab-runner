import pool from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { serialize } from 'cookie';
import { JWT_SECRET } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const op = req.query.op || req.body.op || '';
  const username = req.body.username || '';
  const password = req.body.password || '';

  if (op === 'login') {
    if (!username || !password) return res.status(400).json({ status: "error", message: "Missing credentials" });
    
    try {
      const result = await pool.query('SELECT id, password, banned, locked_until, is_admin FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        
        const isBanned = await pool.query('SELECT id FROM bans WHERE username = $1 AND service = $2', [username, 'devbox']);
        if (isBanned.rows.length > 0) {
          return res.status(403).json({ status: "error", message: "Your account has been permanently banned from the DevBox service for policy violations." });
        }

        const lockedUntil = parseInt(user.locked_until || 0);
        if (lockedUntil > Date.now()) {
          const warnRes = await pool.query('SELECT reason, screenshot_proof FROM warns WHERE username = $1 ORDER BY created_at DESC LIMIT 1', [username]);
          const latestWarn = warnRes.rows[0] || {};
          return res.status(403).json({
            status: "locked",
            message: "Your account is temporarily locked for 24 hours.",
            locked_until: lockedUntil,
            reason: latestWarn.reason || "Suspicious activity detected",
            proof: latestWarn.screenshot_proof || "",
            support_link: "http://absoracloud.fanclub.rocks"
          });
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
          const token = jwt.sign(
            { username, is_admin: user.is_admin, isAdmin: user.is_admin },
            JWT_SECRET,
            { expiresIn: '7d' }
          );

          res.setHeader('Set-Cookie', serialize('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 60 * 60 * 24 * 7,
            path: '/',
          }));

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
    const tos = req.body.tos || false;
    if (!tos) return res.status(400).json({ status: "error", message: "You must agree to the Terms of Service, Privacy Policy, and Refund Policy." });
    if (!username || !password) return res.status(400).json({ status: "error", message: "Missing credentials" });
    
    try {
      const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        return res.status(400).json({ status: "error", message: "User already exists" });
      }
      
      const hash = await bcrypt.hash(password, 10);
      const now = Math.floor(Date.now() / 1000);
      
      await pool.query(
        'INSERT INTO users (username, password, week_ends_at, tos_accepted) VALUES ($1, $2, $3, TRUE)', 
        [username, hash, now + 604800]
      );
      
      return res.status(200).json({ status: "success", message: "Registered successfully" });
    } catch (e) {
      return res.status(500).json({ status: "error", message: "Database error." });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
