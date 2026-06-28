import pool from '../db.js';

/**
 * Log a warning infraction and enforce 24-hour lockout or permanent ban.
 * @param {string} username - User to warn
 * @param {string} service - 'devbox'
 * @param {string} reason - Infraction reason
 * @param {string} screenshotProofUrl - URL of uploaded proof
 * @returns {Promise<{warningCount: number, locked: boolean, banned: boolean}>}
 */
export async function triggerWarning(username, service, reason, screenshotProofUrl = '') {
  // 1. Log warning in warns table
  await pool.query(
    'INSERT INTO warns (username, service, reason, screenshot_proof) VALUES ($1, $2, $3, $4)',
    [username, service, reason, screenshotProofUrl]
  );

  // 2. Count warnings
  const countRes = await pool.query(
    'SELECT COUNT(*) as cnt FROM warns WHERE username = $1 AND service = $2',
    [username, service]
  );
  const warningCount = parseInt(countRes.rows[0]?.cnt || 0);

  let locked = false;
  let banned = false;

  if (warningCount > 3) {
    // Permanent ban
    await pool.query('UPDATE users SET banned = TRUE, session_active = NULL WHERE username = $1', [username]);
    await pool.query(
      'INSERT INTO bans (username, service, reason) VALUES ($1, $2, $3) ON CONFLICT (username, service) DO UPDATE SET reason = EXCLUDED.reason',
      [username, service, reason]
    );
    banned = true;
  } else {
    // 24h lockout
    const lockUntil = Date.now() + 24 * 3600 * 1000;
    await pool.query('UPDATE users SET locked_until = $1, session_active = NULL WHERE username = $2', [lockUntil, username]);
    locked = true;
  }

  // 3. Close active sessions
  await pool.query("UPDATE sessions SET status = 'closed' WHERE username = $1 AND status = 'active'", [username]);

  return { warningCount, locked, banned };
}
