const { Pool } = require('pg');
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

  if (method === 'POST' && url.includes('/api/save-strategy')) {
    try {
      const { 
        user_id, race_name, target_km, target_type, 
        race_date, target_finish, gpx_data, total_ascent 
      } = req.body;

      const client = await pool.connect();
      await client.query(
        `UPDATE connected_platforms 
         SET race_name = $1, target_km = $2, target_type = $3, 
             race_date = $4, target_finish_time = $5, gpx_data = $6, 
             total_elevation_target = $7 
         WHERE user_id = $8`,
        [race_name, target_km, target_type, race_date, target_finish, gpx_data, total_ascent, user_id]
      );
      client.release();
      return res.json({ status: "Strategy Locked!" });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  
  // Endpoint metrics tetap menggunakan query JOIN seperti sebelumnya
  return res.status(200).json({ status: "Apexnity Commander Active" });
};
