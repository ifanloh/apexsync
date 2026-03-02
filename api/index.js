const { Pool } = require('pg');

// Koneksi ke database Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export default async function handler(req, res) {
  // Kita atur CORS biar aplikasi Androidmu bisa akses tanpa diblokir
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const { user_id, platform_name, access_token } = req.body;

      const client = await pool.connect();
      
      // Query buat masukin data ke tabel connected_platforms
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
      return res.status(500).json({ status: "gagal", pesan: "Waduh error: " + error.message });
    }
  } else {
    return res.status(405).json({ status: "error", pesan: "Cuma nerima method POST ya!" });
  }
}