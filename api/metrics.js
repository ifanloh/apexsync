const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// FUNGSI HITUNG: Mengubah TSS menjadi grafik Fitness
async function calculateMetrics(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT tss, start_date FROM activities WHERE user_id = $1 ORDER BY start_date ASC", [userId]);
    let ctl = 0, atl = 0;
    for (let act of res.rows) {
      const tss = parseFloat(act.tss) || 0;
      ctl = ctl + (tss - ctl) / 42;
      atl = atl + (tss - atl) / 7;
      await client.query("DELETE FROM user_metrics WHERE user_id = $1 AND record_date = $2", [userId, act.start_date]);
      await client.query("INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb) VALUES ($1, $2, $3, $4, $5)", [userId, act.start_date, ctl, atl, ctl - atl]);
    }
  } finally { client.release(); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, query, method, body } = req;

  try {
    // API INI SEKARANG NAMPILIN SEMUA DATA TANPA SYARAT JOIN
    if (url.includes('/api/metrics')) {
      const client = await pool.connect();
      const result = await client.query("SELECT * FROM user_metrics ORDER BY record_date DESC LIMIT 150");
      client.release();
      return res.json(result.rows);
    }

    // SIMPAN STRATEGY
    if (method === 'POST' && url.includes('/api/save-strategy')) {
      const { user_id, race_name, target_km, race_date } = body;
      const client = await pool.connect();
      await client.query("DELETE FROM connected_platforms WHERE user_id = $1", [user_id]);
      await client.query("INSERT INTO connected_platforms (user_id, race_name, target_km, race_date, platform_name) VALUES ($1, $2, $3, $4, 'strava')", [user_id, race_name, target_km, race_date]);
      client.release();
      return res.json({ status: "success" });
    }

    // SYNC STRAVA
    if (query && query.code) {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });
      const { access_token, athlete } = tokenRes.data;
      const uid = athlete.id.toString();
      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=100', {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });
      const client = await pool.connect();
      for (const act of actRes.data) {
        const tss = (act.moving_time / 3600) * 85; 
        await client.query("DELETE FROM activities WHERE activity_id = $1", [act.id.toString()]);
        await client.query("INSERT INTO activities (user_id, activity_id, title, distance, moving_time, tss, start_date) VALUES ($1, $2, $3, $4, $5, $6, $7)", [uid, act.id.toString(), act.name, act.distance, act.moving_time, tss, act.start_date]);
      }
      client.release();
      await calculateMetrics(uid);
      return res.send("<script>window.location.href='/'</script>");
    }
    return res.status(200).send("API Active");
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
