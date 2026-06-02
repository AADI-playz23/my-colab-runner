import pool from './db.js';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const type = req.query.type;
  
  try {
    if (type === 'db') {
      const result = await pool.query('SELECT 1 as test');
      if (result.rows[0].test === 1) return res.status(200).json({ status: "success" });
    }
    
    if (type === 'kv') {
      if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw new Error("KV_REST_API_URL or KV_REST_API_TOKEN is missing.");
      await kv.set('absora_test_key', 'working', { ex: 10 });
      const val = await kv.get('absora_test_key');
      if (val === 'working') return res.status(200).json({ status: "success" });
      throw new Error("Failed to read test key from Redis.");
    }
    
    if (type === 'github') {
      const token = process.env.GITHUB_TOKEN;
      const repo = process.env.GITHUB_REPO;
      if (!token || token === "your_github_personal_access_token_here") throw new Error("GITHUB_TOKEN is missing or is placeholder.");
      
      const response = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${token}` }
      });
      if (response.ok) return res.status(200).json({ status: "success" });
      const errorData = await response.json();
      throw new Error(`GitHub API Error: ${errorData.message}`);
    }

    return res.status(400).json({ status: "error", message: "Invalid type" });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
