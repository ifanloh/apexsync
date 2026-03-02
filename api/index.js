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

  // --- ENDPOINT: SAVE FULL RACE STRATEGY ---
  if (method === 'POST' && url.includes('/api/save-strategy')) {
    try {
      const { user_id, target_km, target_type, race_date, target_finish, gpx_data, elev_target } = req.body;
      const client = await pool.connect();
      await client.query(
        `UPDATE connected_platforms 
         SET target_km = $1, target_type = $2, race_date = $3, 
             target_finish_time = $4, gpx_data = $5, total_elevation_target = $6 
         WHERE user_id = $7`,
        [target_km, target_type, race_date, target_finish, gpx_data, elev_target, user_id]
      );
      client.release();
      return res.json({ status: "Strategy Saved!" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Sisa endpoint metrics & oauth tetap sama...
};
