const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  // Pengamanan Cron
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const client = await pool.connect();
    
    // 1. Cari semua aturan sinkronisasi yang aktif
    const rules = await client.query("SELECT * FROM sync_rules WHERE is_active = TRUE");

    for (let rule of rules.rows) {
      // 2. Ambil token platform asal (Source)
      const sourceData = await client.query(
        "SELECT * FROM connected_platforms WHERE user_id = $1 AND platform_name = $2",
        [rule.user_id, rule.source_platform]
      );

      // 3. Ambil token platform tujuan (Destination)
      const destData = await client.query(
        "SELECT * FROM connected_platforms WHERE user_id = $1 AND platform_name = $2",
        [rule.user_id, rule.dest_platform]
      );

      if (sourceData.rows.length > 0 && destData.rows.length > 0) {
        const tokenSource = sourceData.rows[0].access_token;
        const tokenDest = destData.rows[0].access_token;

        // LOGIC SINKRONISASI (Contoh Strava -> Garmin)
        console.log(`Syncing ${rule.source_platform} to ${rule.dest_platform} for user ${rule.user_id}`);
        
        // Di sini kita bakal panggil fungsi download FIT file dari source
        // Dan upload ke destination menggunakan API masing-masing.
      }
    }

    client.release();
    return res.status(200).json({ status: "Sync rules processed" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
