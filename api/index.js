const { Pool } = require('pg');
const axios = require('axios');

// Koneksi ke Database Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

module.exports = async (req, res) => {
  // Setup Header agar bisa diakses dari WebApp (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request dari browser
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- LOGIKA GET (Untuk Callback OAuth Strava/Suunto/Dll) ---
  if (req.method === 'GET') {
    const { code, scope } = req.query;

    // Jika ada parameter "code", berarti ini balasan dari Strava setelah user klik Authorize
    if (code) {
      try {
        // 1. Tukar "code" menjadi "access_token" di Strava
        const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, athlete, expires_at } = tokenResponse.data;

        // 2. Simpan atau Update token ke Database Neon
        const client = await pool.connect();
        const queryText = `
          INSERT INTO connected_platforms (user_id, platform_name, access_token) 
          VALUES ($1, $2, $3) 
          ON CONFLICT (user_id, platform_name) 
          DO UPDATE SET access_token = $3, created_at = CURRENT_TIMESTAMP
          RETURNING *;
        `;
        const values = [athlete.id.toString(), 'strava', access_token];
        await client.query(queryText, values);
        client.release();

        // 3. Tampilan Sukses di Browser User
        res.setHeader('Content-Type', 'text/html');
        return res.send(`
          <div style="font-family:sans-serif; text-align:center; padding:50px;">
            <h1 style="color:#FC4C02;">Koneksi Strava Berhasil!</h1>
            <p>Halo <b>${athlete.firstname}</b>, akun Strava kamu sudah terhubung ke ApexSync.</p>
            <a href="/" style="text-decoration:none; color:#007CC3;">Kembali ke Dashboard</a>
          </div>
        `);
      } catch (error) {
        console.error("OAuth Error:", error.response?.data || error.message);
        return res.status(500).json({ status: "error", pesan: "Gagal tukar token Strava" });
      }
    }

    // Jika dibuka biasa tanpa parameter
    return res.status(200).json({ status: "ready", pesan: "Backend ApexSync Aktif" });
  }

  // --- LOGIKA POST (Untuk Input Data Manual) ---
  if (req.method === 'POST') {
    try {
      const { user_id, platform_name, access_token } = req.body;

      if (!user_id || !platform_name || !access_token) {
        return res.status(400).json({ status: "gagal", pesan: "Data kurang lengkap" });
      }

      const client = await pool.connect();
      const queryText = `
        INSERT INTO connected_platforms (user_id, platform_name, access_token) 
        VALUES ($1, $2, $3) 
        ON CONFLICT (user_id, platform_name) 
        DO UPDATE SET access_token = $3;
      `;
      await client.query(queryText, [user_id, platform_name, access_token]);
      client.release();

      return res.status(200).json({ status: "sukses", pesan: "Data tersimpan ke database" });
    } catch (error) {
      return res.status(500).json({ status: "error", pesan: error.message });
    }
  }
};
