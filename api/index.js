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

  // Endpoint 1: Ambil Data Grafik Performance Management Chart (PMC)
  if (method === 'GET' && url.includes('/api/metrics')) {
    const client = await pool.connect();
    const result = await client.query("SELECT * FROM user_metrics ORDER BY record_date DESC LIMIT 30");
    client.release();
    return res.json(result.rows);
  }

  // Endpoint 2: Handle OAuth Strava
  if (method === 'GET' && query.code) {
    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });

      const { access_token, athlete } = tokenRes.data;
      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=10', {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });

      const client = await pool.connect();
      for (const act of actRes.data) {
        // Rumus TSS Sederhana: (Moving Time / 3600) * (Intensity Factor^2) * 100
        // Sementara kita pakai konstanta intensitas 85% untuk ultra trail
        const tss = (act.moving_time / 3600) * 0.85 * 100;

        await client.query(
          `INSERT INTO activities (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (activity_id) DO NOTHING`,
          [athlete.id.toString(), act.id.toString(), act.name, act.distance, act.moving_time, act.total_elevation_gain, tss, act.start_date]
        );
      }
      client.release();
      return res.send("<script>window.location.href='/'</script>");
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({ status: "Apexnity Engine Running" });
};
