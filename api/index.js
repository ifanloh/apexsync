const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  const { url, method, query } = req;

  // 1. ENDPOINT: AMBIL METRICS (CTL/ATL/TSB)
  if (url.includes('/api/metrics')) {
    const client = await pool.connect();
    const result = await client.query("SELECT * FROM user_metrics ORDER BY record_date DESC LIMIT 30");
    client.release();
    return res.json(result.rows);
  }

  // 2. ENDPOINT: AMBIL HEATMAP
  if (url.includes('/api/heatmap')) {
    const client = await pool.connect();
    const result = await client.query("SELECT * FROM daily_summary WHERE day > CURRENT_DATE - INTERVAL '1 year'");
    client.release();
    return res.json(result.rows);
  }

  // 3. LOGIKA SYNC (Pengganti Cron Job)
  // Kamu bisa tembak ini manual atau pakai cron-job.org
  if (url.includes('/api/sync-worker')) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    // ... Logika tarik data Strava terbaru ...
    return res.json({ status: "Sync Triggered" });
  }

  // 4. HANDLE OAUTH REDIRECT (STRAVA)
  if (query.code) {
    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });

      const { access_token, athlete } = tokenRes.data;
      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });

      const client = await pool.connect();
      for (const act of actRes.data) {
        const tss = (act.moving_time / 3600) * 0.85 * 100;
        await client.query(
          `INSERT INTO activities (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (activity_id) DO NOTHING`,
          [athlete.id.toString(), act.id.toString(), act.name, act.distance, act.moving_time, act.total_elevation_gain, tss, act.start_date]
        );
      }
      client.release();
      return res.send("<script>window.location.href='/'</script>");
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).json({ status: "Apexnity Engine Active" });
};
