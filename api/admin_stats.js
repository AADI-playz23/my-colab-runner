import pool from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  // Protect API: require admin username to be passed (ideally verified by token in real app, but this relies on localstorage on frontend)
  const username = req.query.admin_user;
  
  if (!username) return res.status(403).json({ status: "error", message: "Unauthorized" });

  try {
    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE username = $1', [username]);
    if (adminCheck.rows.length === 0 || !adminCheck.rows[0].is_admin) {
      return res.status(403).json({ status: "error", message: "Unauthorized" });
    }

    // Fetch VMs
    const vms = await pool.query('SELECT id, runner_type, active_users, last_heartbeat FROM vms ORDER BY last_heartbeat DESC');
    
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
