const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, state } = req.query; // state: 'strava' atau 'suunto'

  if (req.method === 'GET' && code) {
    try {
      let platform = state || 'strava';
      let tokenUrl, clientId, clientSecret;

      if (platform === 'strava') {
        tokenUrl = 'https://www.strava.com/oauth/token';
        clientId = process.env.STRAVA_CLIENT_ID;
        clientSecret = process.env.STRAVA_CLIENT_SECRET;
      } else if (platform === 'suunto') {
        tokenUrl = 'https://cloud-api.suunto.com/oauth/token';
        clientId = process.env.SUUNTO_CLIENT_ID;
        clientSecret = process.env.SUUNTO_CLIENT_SECRET;
      }

      // Tukar code jadi Token
      const response = await axios.post(tokenUrl, {
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code'
      });

      const { access_token, refresh_token } = response.data;
      const remote_user_id = (platform === 'strava') ? response.data.athlete.id.toString() : response.data.user_id;

      const client = await pool.connect();
      // Simpan ke database (Satu User ID Muhammad Ma'mun Hariri bisa punya banyak platform)
      await client.query(
        `INSERT INTO connected_platforms (user_id, platform_name, access_token, refresh_token) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (user_id, platform_name) 
         DO UPDATE SET access_token = $3, refresh_token = $4, created_at = CURRENT_TIMESTAMP`,
        [remote_user_id, platform, access_token, refresh_token]
      );
      client.release();

      return res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:50px; background:#121212; color:white; height:100vh;">
          <h1 style="color:#00ff88;">${platform.toUpperCase()} Berhasil Terhubung!</h1>
          <p>ApexSync sudah mengamankan kunci akses kamu.</p>
          <a href="/" style="color:#aaa; text-decoration:none;">Kembali ke Dashboard</a>
        </div>
      `);
    } catch (error) {
      console.error(error.response?.data || error.message);
      return res.status(500).send("Gagal menyambungkan platform: " + error.message);
    }
  }

  return res.status(200).json({ status: "ready", service: "ApexSync Universal" });
};
