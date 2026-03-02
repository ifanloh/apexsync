const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, method, body } = req;

  // --- ENDPOINT: UPDATE TARGET USER ---
  if (method === 'POST' && url.includes('/api/set-target')) {
    try {
      const { user_id, target_km } = req.body;
      const client = await pool.connect();
      await client.query(
        "UPDATE connected_platforms SET target_km = $1 WHERE user_id = $2",
        [target_km, user_id]
      );
      client.release();
      return res.json({ status: "success", message: "Target updated!" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // --- ENDPOINT: AMBIL METRICS + TARGET ---
  if (url.includes('/api/metrics')) {
    const client = await pool.connect();
    // Kita Join dengan tabel platforms buat ambil target_km
    const result = await client.query(`
      SELECT m.*, p.target_km 
      FROM user_metrics m 
      JOIN connected_platforms p ON m.user_id = p.user_id 
      ORDER BY record_date DESC LIMIT 30
    `);
    client.release();
    return res.json(result.rows);
  }

  // ... (Sisa kode OAuth Strava kemarin tetap sama) ...
};
