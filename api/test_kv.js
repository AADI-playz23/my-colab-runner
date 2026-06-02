import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ status: "error", message: "KV_REST_API_URL or KV_REST_API_TOKEN is missing from Vercel Environment Variables." });
    }
    
    await kv.set('absora_test_key', 'working', { ex: 10 });
    const val = await kv.get('absora_test_key');
    
    if (val === 'working') {
      return res.status(200).json({ status: "success", message: "Upstash Redis KV connected successfully!" });
    } else {
      return res.status(500).json({ status: "error", message: "Failed to read test key from Redis." });
    }
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
