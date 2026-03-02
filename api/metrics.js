const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  const { query, method, body } = req;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // 1. SYNC CALLBACK FROM STRAVA
  if (query && query.code) {
    let client;
    try {
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: query.code,
        grant_type: 'authorization_code'
      });
      
      const { access_token, athlete } = tokenRes.data;
      const uid = athlete.id.toString();
      const athleteName = `${athlete.firstname} ${athlete.lastname}`;

      client = await pool.connect();
      
      // Update data atlet (Sekarang laci display_name sudah ada)
      await client.query(
        "INSERT INTO connected_platforms (user_id, platform_name, display_name) VALUES ($1, 'strava', $2) ON CONFLICT (user_id) DO UPDATE SET display_name = $2", 
        [uid, athleteName]
      );

      const actRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=100', { 
        headers: { 'Authorization': `Bearer ${access_token}` } 
      });

      for (const act of actRes.data) {
        const tss = (act.moving_time / 3600) * 85; 
        await client.query("DELETE FROM activities WHERE activity_id = $1", [act.id.toString()]);
        await client.query(
          "INSERT INTO activities (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", 
          [uid, act.id.toString(), act.name, act.distance, act.moving_time, act.total_elevation_gain, tss, act.start_date, act.type]
        );
      }
      
      await calculateMetrics(uid);
      return res.redirect('/');
    } catch (e) {
      return res.status(500).json({ error: "Sync Failed: " + e.message });
    } finally { if(client) client.release(); }
  }

  // 2. DATA REQUESTS (GET/POST)
  try {
    const client = await pool.connect();
    
    if (method === 'POST') {
      const { user_id, race_name, target_km, race_date } = body;
      await client.query("UPDATE connected_platforms SET race_name = $1, target_km = $2, race_date = $3 WHERE user_id = $4", [race_name, target_km, race_date, user_id]);
      client.release();
      return res.status(200).json({ status: "success" });
    }

    const result = await client.query(`
      SELECT m.*, p.display_name, p.race_name, p.target_km, p.race_date 
      FROM user_metrics m
      LEFT JOIN connected_platforms p ON m.user_id = p.user_id
      ORDER BY m.record_date DESC LIMIT 100`);
    
    const weekly = await client.query("SELECT to_char(start_date, 'Dy') as day, SUM(distance) as dist FROM activities WHERE start_date > NOW() - INTERVAL '7 days' GROUP BY day, start_date ORDER BY start_date ASC");
    const prs = await client.query("SELECT MAX(distance) as max_dist, MAX(total_elevation_gain) as max_elev, MIN(CASE WHEN distance BETWEEN 9500 AND 10500 THEN moving_time END) as best_10k FROM activities");

    client.release();
    return res.status(200).json({ metrics: result.rows, weekly: weekly.rows, prs: prs.rows[0] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
