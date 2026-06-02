import pool from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const op = req.body.op || '';
  
  if (op === 'ban_user') {
    const vm_id = req.body.vm_id || '';
    const session_id = req.body.session_id || '';
    
    if (!vm_id || !session_id) return res.status(400).json({ status: "error", message: "Missing required fields" });
    
    try {
      // 1. Get the username for the session
      const sessResult = await pool.query('SELECT username FROM sessions WHERE id = $1', [session_id]);
      if (sessResult.rows.length === 0) {
        return res.status(404).json({ status: "error", message: "Session not found" });
      }
      
      const username = sessResult.rows[0].username;
      
      // 2. Ban the user
      await pool.query('UPDATE users SET banned = TRUE, session_active = NULL WHERE username = $1', [username]);
      
      // 3. Mark session as closed
      await pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [session_id]);
      
      console.log(`[SECURITY] User ${username} was auto-banned by VM ${vm_id}`);
      
      return res.status(200).json({ status: "success", message: `User ${username} banned.` });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ status: "error", message: "Database error." });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
