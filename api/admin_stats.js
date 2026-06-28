import pool from './db.js';
import { requireAdmin } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
    // Fetch VMs
    const vms = await pool.query('SELECT id, active_users, last_heartbeat FROM vms ORDER BY last_heartbeat DESC');
    
    // Fetch Online Users (active sessions)
    const sessions = await pool.query("SELECT id, username, plan, worker_url, started_at FROM sessions WHERE status = 'active' ORDER BY started_at DESC");
    
    // Fetch Banned Users
    const bans = await pool.query("SELECT username, created_at FROM users WHERE banned = TRUE ORDER BY created_at DESC");

    return res.status(200).json({ 
      status: "success", 
      vms: vms.rows,
      sessions: sessions.rows,
      bans: bans.rows
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: "Database error." });
  }
}
