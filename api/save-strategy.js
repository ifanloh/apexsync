const { Pool } = require("pg");

if (!global._pool) {
  global._pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}
const pool = global._pool;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch {}

  const { user_id, race_name, target_km, race_date } = body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE connected_platforms
       SET race_name=$1,
           target_km=$2,
           race_date=$3,
           updated_at=now()
       WHERE user_id=$4`,
      [race_name || null, target_km || null, race_date || null, user_id]
    );

    return res.json({ status: "success" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
