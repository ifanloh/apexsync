const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Fungsi Masak Data: Mengolah TSS harian menjadi grafik Fitness
async function calculateMetrics(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT tss, start_date FROM activities WHERE user_id = $1 ORDER BY start_date ASC",
      [userId]
    );
    
    let ctl = 0, atl = 0;
    for (let act of res.rows) {
      const tss = parseFloat(act.tss) || 0;
      ctl = ctl + (tss - ctl) / 42;
      atl = atl + (tss - atl) / 7;
      const tsb = ctl - atl;

      // UPDATE: Menembak langsung ke (user_id, record_date)
      await client.query(
        `INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, record_date) 
         DO UPDATE SET ctl = EXCLUDED.ctl, atl = EXCLUDED.atl, tsb = EXCLUDED.tsb`,
        [userId, act.start_date, ctl, atl, tsb]
      );
    }
  } finally { client.release(); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, query, method } = req;

  try {
    if (url.includes('/api/metrics')) {
      const client = await pool.connect();
      const result = await client.query(`
        SELECT m.*, p.target_km, p.race_name, p.race_date, p.gpx_data 
        FROM user_metrics m 
        LEFT JOIN connected_platforms p ON m.user_id = p.user_id 
        ORDER BY m.record_date DESC LIMIT 100`);
      client.release();
      return res.json(result.rows);
    }

    if (method === 'POST' && url.includes('/api/save-strategy')) {
      const { user_id, race_name, target_km, race_date, gpx_content } = req.body;
      const client = await pool.connect();
      await client.query(
        `UPDATE connected_platforms SET race_name = $1, target_km = $2, race_date = $3, gpx_data = $4 WHERE user_id = $5`,
        [race_name, target_km, race_date, gpx_content, user_id]
      );
      client.release();
      return res.json({ status: "success" });
    }

    if (query && query.code) {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });
      const { access_token, athlete } = tokenRes.data;
      const uid = athlete.id.toString();

      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=50', {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });
      
      const client = await pool.connect();
      await client.query(
        "INSERT INTO connected_platforms (user_id, platform_name) VALUES ($1, 'strava') ON CONFLICT (user_id) DO NOTHING",
        [uid]
      );

      for (const act of actRes.data) {
        const isTrail = act.total_elevation_gain > (act.distance / 1000) * 10;
        const tss = (act.moving_time / 3600) * (isTrail ? 0.95 : 0.85) * 100;
        await client.query(
          `INSERT INTO activities (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (activity_id) DO NOTHING`,
          [uid, act.id.toString(), act.name, act.distance, act.moving_time, act.total_elevation_gain, tss, act.start_date, isTrail ? 'Trail' : 'Road']
        );
      }
      client.release();
      await calculateMetrics(uid);
      return res.send("<script>window.location.href='/'</script>");
    }
    return res.status(200).json({ status: "Apexnity Engine Active" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
