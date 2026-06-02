import pool from './db.js';
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  // Parse input from query or JSON body
  let input = req.query;
  if (req.method === 'POST') {
    try {
      input = { ...input, ...req.body };
    } catch (e) {}
  }

  const op = input.op || '';
  const now = Math.floor(Date.now() / 1000);

  if (op === 'register_vm') {
    const worker_url = input.worker_url || '';
    const vm_id = input.vm_id || crypto.randomBytes(8).toString('hex');
    
    if (!worker_url) return res.status(400).json({ status: "error", message: "Missing worker_url" });
    
    try {
      // Delete any existing VM with same ID (re-registration after restart)
      await pool.query("DELETE FROM vms WHERE id = $1", [vm_id]);
      
      await pool.query(
        "INSERT INTO vms (id, worker_url, active_users, last_heartbeat) VALUES ($1, $2, 0, $3)",
        [vm_id, worker_url, now]
      );
      
      return res.status(200).json({ status: "success", vm_id });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ status: "error", message: "Database error" });
    }
  }

  if (op === 'vm_heartbeat') {
    const vm_id = input.vm_id || '';
    const active_users = parseInt(input.active_users || 0);
    
    if (!vm_id) return res.status(400).json({ status: "error", message: "Missing vm_id" });
    
    try {
      // Update heartbeat
      const hbResult = await pool.query(
        "UPDATE vms SET last_heartbeat = $1, active_users = $2 WHERE id = $3 RETURNING id",
        [now, active_users, vm_id]
      );
      
      // If no rows updated, the VM isn't registered — skip queue processing
      if (hbResult.rows.length === 0) {
        return res.status(404).json({ status: "error", message: "VM not found. Re-register." });
      }
      
      // Also assign queued sessions to this VM if it has space
      if (active_users < 20) {
        const available_slots = 20 - active_users;
        
        // Find the worker URL for this VM
        const vmRes = await pool.query("SELECT worker_url FROM vms WHERE id = $1", [vm_id]);
        if (vmRes.rows.length > 0) {
          const worker_url = vmRes.rows[0].worker_url;
          
          // Get queued sessions from Vercel KV Redis
          for (let i = 0; i < available_slots; i++) {
            try {
              const session_id = await kv.lpop('session_queue');
              if (session_id) {
                await pool.query(
                  "UPDATE sessions SET status = 'active', worker_url = $1, started_at = $2 WHERE id = $3 AND status = 'queued'",
                  [worker_url, now, session_id]
                );
              } else {
                break; // Queue is empty
              }
            } catch (err) {
              console.error("Redis KV Error during heartbeat:", err);
              break;
            }
          }
        }
      }
      
      // Expire timed-out active sessions and track cpu_minutes_used
      try {
        const expiredSessions = await pool.query(
          "SELECT id, username, started_at, timeout_secs FROM sessions WHERE status = 'active' AND started_at IS NOT NULL AND (started_at + timeout_secs) < $1",
          [now]
        );
        
        for (const sess of expiredSessions.rows) {
          const mins = Math.ceil(parseInt(sess.timeout_secs) / 60);
          await pool.query("UPDATE sessions SET status = 'expired' WHERE id = $1", [sess.id]);
          await pool.query(
            "UPDATE users SET cpu_minutes_used = cpu_minutes_used + $1, session_active = NULL WHERE username = $2",
            [mins, sess.username]
          );
        }
      } catch (err) {
        console.error("Session expiry error:", err);
      }
      
      // Close sessions assigned to dead VMs (VMs that stopped heartbeating)
      const dead_time = now - 120;
      try {
        const deadVms = await pool.query("SELECT worker_url FROM vms WHERE last_heartbeat < $1", [dead_time]);
        for (const dvm of deadVms.rows) {
          // Close active sessions on dead VMs and track usage
          const deadSessions = await pool.query(
            "SELECT id, username, started_at FROM sessions WHERE worker_url = $1 AND status = 'active'",
            [dvm.worker_url]
          );
          for (const ds of deadSessions.rows) {
            const elapsed_mins = ds.started_at ? Math.ceil((now - parseInt(ds.started_at)) / 60) : 0;
            await pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [ds.id]);
            if (elapsed_mins > 0) {
              await pool.query(
                "UPDATE users SET cpu_minutes_used = cpu_minutes_used + $1, session_active = NULL WHERE username = $2",
                [elapsed_mins, ds.username]
              );
            }
          }
        }
      } catch (err) {
        console.error("Dead VM session cleanup error:", err);
      }
      
      // Cleanup dead VMs (no heartbeat for 2 minutes)
      await pool.query("DELETE FROM vms WHERE last_heartbeat < $1", [dead_time]);
      
      return res.status(200).json({ status: "success" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ status: "error", message: "Database error" });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
