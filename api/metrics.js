const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    const client = await pool.connect();
    
    // 1. Ambil Metrik untuk Grafik & Gauge (CTL, ATL, TSB)
    const metrics = await client.query("SELECT * FROM user_metrics ORDER BY record_date DESC LIMIT 90");
    
    // 2. Ambil Aktivitas Terbaru (Recent Activities)
    const recentActivities = await client.query("SELECT * FROM activities ORDER BY start_date DESC LIMIT 10");
    
    // 3. Ambil Rekor Pribadi (Personal Records)
    const prs = await client.query(`
      SELECT 
        MAX(distance) as max_dist, 
        MAX(total_elevation_gain) as max_elev,
        MIN(CASE WHEN distance >= 990 AND distance <= 1100 THEN moving_time END) as best_1k,
        MIN(CASE WHEN distance >= 4900 AND distance <= 5100 THEN moving_time END) as best_5k
      FROM activities
    `);

    // 4. Ambil Data Mingguan (Weekly Activity)
    const weekly = await client.query(`
      SELECT 
        to_char(start_date, 'Dy') as day, 
        SUM(distance) as dist 
      FROM activities 
      WHERE start_date > NOW() - INTERVAL '7 days'
      GROUP BY day, start_date ORDER BY start_date ASC
    `);

    client.release();
    
    return res.status(200).json({
      metrics: metrics.rows,
      activities: recentActivities.rows,
      summary: prs.rows[0],
      weekly: weekly.rows
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
