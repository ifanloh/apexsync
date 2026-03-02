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
    // Tarik semua data metrik yang ada di database Neon
    const result = await client.query("SELECT * FROM user_metrics ORDER BY record_date DESC LIMIT 150");
    client.release();
    
    return res.status(200).json(result.rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
