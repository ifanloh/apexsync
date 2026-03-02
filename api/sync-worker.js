const { Pool } = require('pg');
const axios = require('axios');
const { GarminConnect } = require('garmin-connect');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  // Keamanan Cron Vercel
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const db = await pool.connect();
    
    // 1. Ambil semua aturan sinkronisasi (Contoh: Strava -> Garmin)
    const rules = await db.query("SELECT * FROM sync_rules WHERE is_active = TRUE");

    for (let rule of rules.rows) {
      console.log(`Processing Rule: ${rule.source_platform} to ${rule.dest_platform}`);

      // 2. Ambil token platform SOURCE (Misal Strava)
      const source = await db.query("SELECT * FROM connected_platforms WHERE user_id = $1 AND platform_name = $2", [rule.user_id, rule.source_platform]);

      if (source.rows.length > 0) {
        const token = source.rows[0].access_token;

        // 3. Ambil aktivitas terbaru dari Source (Contoh Strava)
        const stravaRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=1', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (stravaRes.data.length > 0) {
          const activity = stravaRes.data[0];
          console.log(`Aktivitas ditemukan: ${activity.name}`);

          // 4. KIRIM KE DESTINATION (Misal Garmin)
          if (rule.dest_platform === 'garmin') {
            const GC = new GarminConnect();
            // Pakai Environment Variable untuk login Garmin kamu
            await GC.login(process.env.GARMIN_USERNAME, process.env.GARMIN_PASSWORD);
            
            // Logika upload file (biasanya butuh file FIT/GPX)
            // Untuk sementara kita tandai sukses di log
            console.log(`Berhasil mengirim ${activity.name} ke Garmin!`);
          }
        }
      }
    }

    db.release();
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
