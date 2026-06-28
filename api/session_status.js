import pool from './db.js';
import { requireAuth } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const user = requireAuth(req, res);
  if (!user) return;

  const id = req.query.id || '';
  if (!id) return res.status(400).json({ status: "error", message: "Missing session ID" });
  
  try {
    const result = await pool.query("SELECT status, worker_url, plan, started_at, timeout_secs, username FROM sessions WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Session not found" });
    }
    
    const session = result.rows[0];
    if (session.username !== user.username && !user.is_admin) {
      return res.status(403).json({ status: "error", message: "Forbidden. Access denied." });
    }

    // Verify if the VM hosting this session is still alive
    if (session.status === 'active' && session.worker_url) {
      const recent_time = now - 120;
      const vmAlive = await pool.query("SELECT id FROM vms WHERE worker_url = $1 AND last_heartbeat > $2", [session.worker_url, recent_time]);
      if (vmAlive.rows.length === 0) {
        await pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [id]);
        await pool.query("UPDATE users SET session_active = NULL WHERE username = $1", [session.username]);
        session.status = 'closed';
        session.worker_url = null;
      }
    }
    
    // Server-side timeout enforcement: if session is active and has exceeded its timeout, close it
    if (session.status === 'active' && session.started_at && session.timeout_secs) {
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - parseInt(session.started_at);
      if (elapsed >= parseInt(session.timeout_secs)) {
        await pool.query("UPDATE sessions SET status = 'expired' WHERE id = $1", [id]);
        
        // Update cpu_minutes_used for the user
        const sessUser = await pool.query("SELECT username FROM sessions WHERE id = $1", [id]);
        if (sessUser.rows.length > 0) {
          const mins = Math.ceil(parseInt(session.timeout_secs) / 60);
          await pool.query(
            'UPDATE users SET cpu_minutes_used = cpu_minutes_used + $1, session_active = NULL WHERE username = $2',
            [mins, sessUser.rows[0].username]
          );
        }
        
        return res.status(200).json({
          status: "success",
          session_status: "expired",
          worker_url: null,
          plan: session.plan,
          started_at: session.started_at ? parseInt(session.started_at) : null,
          queue_position: 0
        });
      }
    }
    
    // Check queue position if queued
    let queue_position = 0;
    if (session.status === 'queued' || session.status === 'booting') {
      const posRes = await pool.query("SELECT COUNT(*) as pos FROM sessions WHERE status = 'queued'");
      queue_position = parseInt(posRes.rows[0].pos);
    }
    
    return res.status(200).json({
      status: "success",
      session_status: session.status,
      worker_url: session.worker_url,
      plan: session.plan,
      started_at: session.started_at ? parseInt(session.started_at) : null,
      queue_position
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: "Database error" });
  }
}
