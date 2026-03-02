const { Pool } = require('pg');
const axios = require('axios');
const { subHours } = require('date-fns');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  // Security Check for Vercel Cron
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const db = await pool.connect();
    const oneHourAgo = Math.floor(subHours(new Date(), 1).getTime() / 1000);

    // 1. Ambil aktivitas terbaru dari Strava
    const stravaUsers = await db.query("SELECT * FROM connected_platforms WHERE platform_name = 'strava'");
    
    for (let user of stravaUsers.rows) {
      const activities = await axios.get(`https://www.strava.com/api/v3/athlete/activities`, {
        params: { after: oneHourAgo },
        headers: { 'Authorization': `Bearer ${user.access_token}` }
      });

      if (activities.data.length > 0) {
        for (let act of activities.data) {
          console.log(`Lari baru terdeteksi di Strava: ${act.name}`);
          // Di sini kita akan tambahkan fungsi upload ke Suunto/Garmin
        }
      }
    }

    db.release();
    return res.status(200).json({ status: "Sync completed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
