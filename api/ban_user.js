import pool from './db.js';
import { triggerWarning } from './_lib/abuse_guard.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method not allowed" });

  const op = req.body.op || '';
  if (op !== 'ban_user' && op !== 'report_abuse') {
    return res.status(400).json({ status: "error", message: "Invalid operation" });
  }

  const { vm_id, session_id, screenshot_base64, console_dump, force_warn } = req.body;
  if (!session_id) {
    return res.status(400).json({ status: "error", message: "Missing session_id" });
  }

  try {
    // 1. Resolve session to get username
    const sessResult = await pool.query('SELECT username FROM sessions WHERE id = $1', [session_id]);
    if (sessResult.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Session not found" });
    }
    const username = sessResult.rows[0].username;

    let abuseDetected = false;
    let reason = "Suspected policy violation";
    let proofUrl = "";

    // 2. Gemini Verification Layer
    if (force_warn) {
      abuseDetected = true;
      reason = force_warn;
    } else if (process.env.GEMINI_API_KEY) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const parts = [
          {
            text: "Analyze this image and text content from a dev box instance. Detect if there is cryptocurrency mining (e.g. xmrig, miners, ethminer, etc.), adult hosting, or container escape hacks. Respond ONLY in valid JSON format with two keys: 'abuse_detected' (boolean) and 'reason' (string detailing the finding)."
          }
        ];

        if (screenshot_base64) {
          parts.push({
            inlineData: {
              mimeType: "image/png",
              data: screenshot_base64
            }
          });
        }
        if (console_dump) {
          parts.push({
            text: `Terminal Console log:\n${console_dump}`
          });
        }

        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });

        const geminiData = await geminiRes.json();
        const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsed = JSON.parse(responseText);
          abuseDetected = parsed.abuse_detected;
          reason = parsed.reason || reason;
        }
      } catch (err) {
        console.error("Gemini analysis error:", err);
        // Fail-open or default warning on suspicious patterns
        abuseDetected = true; 
      }
    } else {
      // If no Gemini API key, default to true for the report
      abuseDetected = true;
    }

    if (!abuseDetected) {
      return res.status(200).json({ status: "success", message: "No abuse detected. Session left intact." });
    }

    // 3. Upload proof to private GitHub repository
    const targetRepo = process.env.GITHUB_REPO_DEVBOX || process.env.GITHUB_REPO_FORENSICS || process.env.GITHUB_REPO;
    if (process.env.GITHUB_TOKEN && targetRepo) {
      try {
        const [owner, repo] = targetRepo.split('/');
        const timestamp = Date.now();
        const path = `forensics/${username}_${session_id}_${timestamp}.png`;
        const uploadUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        // If screenshot is not provided, encode the console dump or logs as base64
        const contentBase64 = screenshot_base64 || Buffer.from(console_dump || reason).toString('base64');

        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `token ${process.env.GITHUB_TOKEN}`,
            'User-Agent': 'AbsoraCloud-Vercel',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `forensic proof for ${username} on ${session_id}`,
            content: contentBase64
          })
        });

        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          proofUrl = uploadData?.content?.html_url || `https://github.com/${owner}/${repo}/blob/main/${path}`;
        }
      } catch (err) {
        console.error("GitHub upload failed:", err);
      }
    }

    // 4. Trigger abuse_guard warning / lockout logic
    const { warningCount, locked, banned } = await triggerWarning(username, 'devbox', reason, proofUrl);

    return res.status(200).json({
      status: "success",
      abuse_detected: true,
      reason,
      warning_count: warningCount,
      locked,
      banned,
      proof_url: proofUrl
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: "error", message: e.message });
  }
}
