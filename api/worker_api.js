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
    const runner_type = input.runner_type || 'cpu';
    
    if (!worker_url) return res.status(400).json({ status: "error", message: "Missing worker_url" });
    
    const vm_id = crypto.randomBytes(8).toString('hex');
    
    try {
      await pool.query(
        "INSERT INTO vms (id, worker_url, runner_type, active_users, last_heartbeat) VALUES ($1, $2, $3, 0, $4)",
        [vm_id, worker_url, runner_type, now]
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
      await pool.query(
        "UPDATE vms SET last_heartbeat = $1, active_users = $2 WHERE id = $3",
        [now, active_users, vm_id]
      );
      
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
                  "UPDATE sessions SET status = 'active', worker_url = $1, started_at = $2 WHERE id = $3",
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
      
      // Cleanup dead VMs (no heartbeat for 2 minutes)
      const dead_time = now - 120;
      await pool.query("DELETE FROM vms WHERE last_heartbeat < $1", [dead_time]);
      
      return res.status(200).json({ status: "success" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ status: "error", message: "Database error" });
    }
  }

  return res.status(400).json({ status: "error", message: "Invalid operation" });
}
