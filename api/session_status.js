import pool from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const id = req.query.id || '';
  if (!id) return res.status(400).json({ status: "error", message: "Missing session ID" });
  
  try {
    const result = await pool.query("SELECT status, worker_url, plan FROM sessions WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Session not found" });
    }
    
    const session = result.rows[0];
    
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
      queue_position
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: "Database error" });
  }
}
