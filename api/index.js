const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

module.exports = async (req, res) => {
  // Atur CORS agar bisa diakses dari aplikasi Android
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const { user_id, platform_name, access_token } = req.body;

      if (!user_id || !platform_name || !access_token) {
        return res.status(400).json({ status: "gagal", pesan: "Data tidak lengkap!" });
      }

      const client = await pool.connect();
      const queryText = 'INSERT INTO connected_platforms(user_id, platform_name, access_token) VALUES($1, $2, $3) RETURNING *';
      const values = [user_id, platform_name, access_token];
      
      const result = await client.query(queryText, values);
      client.release();

      return res.status(200).json({ 
        status: "sukses", 
        pesan: "Mantap, token berhasil masuk ke Neon lewat Vercel!",
        data: result.rows[0]
      });
    } catch (error) {
      console.error(error); // Biar keliatan di log Vercel
      return res.status(500).json({ status: "gagal", pesan: "Database Error: " + error.message });
    }
  } else {
    // Kalau dibuka di browser (GET), kasih pesan ini biar nggak 500
    return res.status(200).json({ status: "ready", pesan: "Backend ApexSync aktif! Silakan kirim data via POST." });
  }
};
