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

  const { code, state } = req.query; // 'state' kita pakai buat nandain platform (strava/suunto/coros)

  if (req.method === 'GET' && code) {
    try {
      let platform = state || 'strava'; // Default ke strava kalau state kosong
      let tokenUrl, clientId, clientSecret;

      // Setting tiap platform
      if (platform === 'strava') {
        tokenUrl = 'https://www.strava.com/oauth/token';
        clientId = process.env.STRAVA_CLIENT_ID;
        clientSecret = process.env.STRAVA_CLIENT_SECRET;
      } else if (platform === 'suunto') {
        tokenUrl = 'https://cloud-api.suunto.com/oauth/token';
        clientId = process.env.SUUNTO_CLIENT_ID;
        clientSecret = process.env.SUUNTO_CLIENT_SECRET;
      }

      const response = await axios.post(tokenUrl, {
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code'
      });

      const { access_token, refresh_token } = response.data;
      const remote_user_id = response.data.athlete?.id || response.data.user_id;

      const client = await pool.connect();
      await client.query(
        `INSERT INTO connected_platforms (user_id, platform_name, access_token, refresh_token) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (user_id, platform_name) DO UPDATE SET access_token = $3, refresh_token = $4`,
        [remote_user_id.toString(), platform, access_token, refresh_token]
      );
      client.release();

      return res.send(`<h1>${platform.toUpperCase()} Berhasil Terhubung!</h1><p>Sekarang platform ini sudah masuk radar ApexSync.</p>`);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(200).json({ status: "ready" });
};
