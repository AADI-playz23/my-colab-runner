import pool from './db.js';
import { kv } from '@vercel/kv';
import crypto from 'crypto';

const PLAN_LIMITS = {
  free: { session_mins: 60, weekly_mins: 600, queue: 'normal' },
  pro: { session_mins: 120, weekly_mins: 1200, queue: 'normal' },
  developer: { session_mins: 360, weekly_mins: 1800, queue: 'priority' }
};

async function checkAndResetWeeklyBudget(username) {
  const result = await pool.query('SELECT week_ends_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return false;
  
  const now = Math.floor(Date.now() / 1000);
  const week_ends_at = parseInt(result.rows[0].week_ends_at);
  
  if (now > week_ends_at) {
    await pool.query(
      'UPDATE users SET cpu_minutes_used = 0, week_ends_at = $1 WHERE username = $2',
      [now + 604800, username]
    );
    return true;
  }
  return false;
}

async function getUserUsage(username) {
  await checkAndResetWeeklyBudget(username);
  
  const result = await pool.query('SELECT plan, cpu_minutes_used, week_ends_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return null;
  
  let plan = result.rows[0].plan || 'free';
  if (!PLAN_LIMITS[plan]) plan = 'free';
  
  const limits = PLAN_LIMITS[plan];
  const used = parseInt(result.rows[0].cpu_minutes_used || 0);
  
  const allowed = limits.weekly_mins;
  const session_limit = limits.session_mins;
  
  let remaining = allowed - used;
  if (remaining < 0) remaining = 0;
  
  return {
    plan,
    used_mins: used,
    allowed_mins: allowed,
    remaining_mins: remaining,
    session_limit_mins: session_limit,
    queue_type: limits.queue,
    week_ends_at: parseInt(result.rows[0].week_ends_at)
  };
}

async function triggerVM() {
  // GitHub Actions Trigger — spins up a new runner VM
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (token && repo) {
    try {
      await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Vercel-Backend'
        },
        body: JSON.stringify({ event_type: 'start-runner' })
      });
    } catch (e) {
      console.error("Failed to trigger GitHub Action", e);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });
  
  const u = req.body.username || '';
  
  if (!u) return res.status(400).json({ status: "error", message: "Missing username" });
  
  try {
    const usage = await getUserUsage(u);
    if (!usage) return res.status(404).json({ status: "error", message: "User not found" });
    
    // Check if banned
    const uResInfo = await pool.query('SELECT banned, session_active FROM users WHERE username = $1', [u]);
    if (uResInfo.rows.length > 0 && uResInfo.rows[0].banned) {
      return res.status(403).json({ status: "error", message: "Account has been banned for TOS violations." });
    }
    
    if (usage.remaining_mins <= 0) {
      return res.status(403).json({
        status: "error",
        message: `CPU weekly budget exhausted`,
        plan: usage.plan,
        resets_in_secs: Math.max(0, usage.week_ends_at - Math.floor(Date.now() / 1000))
      });
    }

    // Check for existing active/queued session
    if (uResInfo.rows.length > 0 && uResInfo.rows[0].session_active) {
      const active_id = uResInfo.rows[0].session_active;
      const sRes = await pool.query("SELECT status, worker_url, started_at FROM sessions WHERE id = $1 AND status IN ('queued', 'running', 'active')", [active_id]);
      if (sRes.rows.length > 0) {
        const sess = sRes.rows[0];
        const recent_time = Math.floor(Date.now() / 1000) - 120;
        
        // If session is active, check if the VM is still alive
        if (sess.status === 'active' && sess.worker_url) {
          const vmAlive = await pool.query("SELECT id FROM vms WHERE worker_url = $1 AND last_heartbeat > $2", [sess.worker_url, recent_time]);
          if (vmAlive.rows.length > 0) {
            // VM is alive, return the existing session
            return res.status(200).json({
              status: "active",
              session_id: active_id,
              worker_url: sess.worker_url,
              started_at: sess.started_at ? parseInt(sess.started_at) : null,
              session_limit_mins: usage.session_limit_mins
            });
          } else {
            // VM is dead, close the stale session and let user start fresh
            await pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [active_id]);
            await pool.query("UPDATE users SET session_active = NULL WHERE username = $1", [u]);
          }
        } else if (sess.status === 'queued' || sess.status === 'booting' || sess.status === 'running') {
          // Check if there are any active VMs to service this queue
          const countRes = await pool.query("SELECT COUNT(*) as vm_count FROM vms WHERE last_heartbeat > $1", [recent_time]);
          const vm_count = parseInt(countRes.rows[0].vm_count);
          
          if (vm_count === 0) {
            // No VMs are alive to service this queued session. It's a dead/stuck queue.
            // Close it and let the code below generate a fresh session.
            await pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [active_id]);
            await pool.query("UPDATE users SET session_active = NULL WHERE username = $1", [u]);
          } else {
            // There are VMs alive, just tell the user to keep waiting
            return res.status(200).json({
              status: "queued",
              session_id: active_id,
              queue_position: 0,
              session_limit_mins: usage.session_limit_mins
            });
          }
        }
      }
    }

    // Create Session
    const session_id = crypto.randomBytes(16).toString('hex');
    const timeout_secs = usage.session_limit_mins * 60;
    
    // Find an available VM in the Fleet
    const recent_time = Math.floor(Date.now() / 1000) - 120; // 2 minutes
    
    const vmRes = await pool.query(
      "SELECT worker_url FROM vms WHERE active_users < 20 AND last_heartbeat > $1 ORDER BY active_users ASC LIMIT 1",
      [recent_time]
    );

    if (vmRes.rows.length > 0) {
      // Found active VM
      const worker_url = vmRes.rows[0].worker_url;
      const now = Math.floor(Date.now() / 1000);
      
      await pool.query(
        "INSERT INTO sessions (id, username, status, plan, timeout_secs, worker_url, started_at) VALUES ($1, $2, 'active', $3, $4, $5, $6)",
        [session_id, u, usage.plan, timeout_secs, worker_url, now]
      );
      
      await pool.query("UPDATE users SET session_active = $1 WHERE username = $2", [session_id, u]);
      
      return res.status(200).json({
        status: "active",
        session_id,
        worker_url,
        started_at: now,
        session_limit_mins: usage.session_limit_mins
      });
    } else {
      // No space available. Check VM count.
      const max_vms = 2; // up to 2 CPU VMs = 40 users max before strict queue
      const countRes = await pool.query("SELECT COUNT(*) as vm_count FROM vms WHERE last_heartbeat > $1", [recent_time]);
      const vm_count = parseInt(countRes.rows[0].vm_count);
      
      // Create session in queue (Postgres)
      await pool.query(
        "INSERT INTO sessions (id, username, status, plan, timeout_secs) VALUES ($1, $2, 'queued', $3, $4)",
        [session_id, u, usage.plan, timeout_secs]
      );
      
      await pool.query("UPDATE users SET session_active = $1 WHERE username = $2", [session_id, u]);
      
      // Enqueue to Vercel Redis (KV)
      try {
          await kv.rpush('session_queue', session_id);
      } catch (err) {
          console.error("Vercel KV Queue Error:", err);
      }
      
      const posRes = await pool.query("SELECT COUNT(*) as pos FROM sessions WHERE status = 'queued'");
      const pos = parseInt(posRes.rows[0].pos);
      
      if (vm_count >= max_vms) {
        // Max VMs reached, stay in Redis queue
        return res.status(200).json({
          status: "queued",
          session_id,
          queue_position: pos,
          session_limit_mins: usage.session_limit_mins
        });
      } else {
        // Trigger a new VM
        await triggerVM();
        
        return res.status(200).json({
          status: "booting",
          session_id,
          queue_position: pos,
          session_limit_mins: usage.session_limit_mins
        });
      }
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}
