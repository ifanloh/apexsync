const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Fungsi masak data: Mengubah lari mentah jadi CTL/ATL/TSB
async function calculateMetrics(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT tss, start_date FROM activities WHERE user_id = $1 ORDER BY start_date ASC",
      [userId]
    );
    
    let ctl = 0, atl = 0;
    const activities = res.rows;

    for (let act of activities) {
      const tss = parseFloat(act.tss) || 0;
      // Rumus TrainingPeaks: CTL (42 hari), ATL (7 hari)
      ctl = ctl + (tss - ctl) / 42;
      atl = atl + (tss - atl) / 7;
      const tsb = ctl - atl;

      await client.query(
        `INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, record_date) DO UPDATE SET ctl=$3, atl=$4, tsb=$5`,
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
    // SAVE STRATEGY
    if (method === 'POST' && url.includes('/api/save-strategy')) {
      const { user_id, race_name, target_km, target_type, race_date, target_finish, gpx_content, total_ascent } = req.body;
      const client = await pool.connect();
      await client.query(
        `UPDATE connected_platforms SET race_name = $1, target_km = $2, target_type = $3, 
         race_date = $4, target_finish_time = $5, gpx_data = $6, total_elevation_target = $7 WHERE user_id = $8`,
        [race_name, target_km, target_type, race_date, target_finish, gpx_content, total_ascent, user_id]
      );
      client.release();
      return res.json({ status: "success" });
    }

    // GET METRICS
    if (url.includes('/api/metrics')) {
      const client = await pool.connect();
      const result = await client.query(`
        SELECT m.*, p.target_km, p.target_type, p.race_date, p.race_name, p.target_finish_time, p.gpx_data, p.total_elevation_target 
        FROM user_metrics m JOIN connected_platforms p ON m.user_id = p.user_id 
        ORDER BY record_date DESC LIMIT 60`);
      client.release();
      return res.json(result.rows);
    }

    // STRAVA CALLBACK
    if (query && query.code) {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });
      const { access_token, athlete } = tokenRes.data;
      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=50', {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });
      
      const client = await pool.connect();
      const uid = athlete.id.toString();

      // Pastikan user terdaftar di connected_platforms
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
      
      // JALANKAN KALKULASI SETELAH SYNC
      await calculateMetrics(uid);
      
      return res.send("<script>window.location.href='/'</script>");
    }

    return res.status(200).json({ status: "Apexnity Active" });
  } catch (e) { 
    return res.status(500).json({ error: e.message }); 
  }
};
