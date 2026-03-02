const { Pool } = require('pg');
const axios = require('axios');
const { subHours } = require('date-fns');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  // Pengamanan: Cuma Vercel Cron yang boleh jalanin ini
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const client = await pool.connect();
    
    // 1. Ambil semua user Strava dari Database
    const users = await client.query("SELECT * FROM connected_platforms WHERE platform_name = 'strava'");
    
    for (let user of users.rows) {
      const oneHourAgo = Math.floor(subHours(new Date(), 1).getTime() / 1000);

      // 2. Cek aktivitas terbaru di Strava
      const stravaRes = await axios.get(`https://www.strava.com/api/v3/athlete/activities`, {
        params: { after: oneHourAgo },
        headers: { 'Authorization': `Bearer ${user.access_token}` }
      });

      const activities = stravaRes.data;

      if (activities.length > 0) {
        for (let activity of activities) {
          console.log(`Menemukan lari baru: ${activity.name} oleh user ${user.user_id}`);
          
          // 3. DI SINI TEMPAT KIRIM KE GARMIN / SUUNTO / COROS
          // Untuk sekarang kita log dulu, nanti kita tambah fungsi kirimnya
          console.log(`Data: ${activity.distance} meter, Pace: ${activity.average_speed} m/s`);
        }
      }
    }

    client.release();
    return res.status(200).json({ success: true, message: 'Sync worker finished successfully' });
  } catch (error) {
    console.error("Sync Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};
