// Tambahkan di dalam module.exports api/index.js kamu

if (method === 'POST' && url.includes('/api/generate-plan')) {
  try {
    const { user_id, target_km, target_type, days_left } = req.body;
    
    // Logika Sederhana AI Planner:
    // Minggu ini lari 40% dari target, naik 10% tiap minggu sampai puncak 3 minggu sebelum race.
    const weekly_target = target_km * 0.5; // Contoh: target 116km, minggu ini lari total 58km
    
    const plan = {
      mon: "Rest Day / Mobility",
      tue: `Easy Run: ${Math.round(weekly_target * 0.2)}km`,
      wed: `Strength & Hills: ${Math.round(weekly_target * 0.15)}km`,
      thu: `Tempo Run: ${Math.round(weekly_target * 0.2)}km`,
      fri: "Rest Day",
      sat: `Long Run: ${Math.round(weekly_target * 0.45)}km`,
      sun: "Recovery Walk / Rest"
    };

    const client = await pool.connect();
    await client.query(
      "INSERT INTO training_plans (user_id, week_start, plan_json) VALUES ($1, CURRENT_DATE, $2)",
      [user_id, JSON.stringify(plan)]
    );
    client.release();
    return res.json({ status: "Plan Generated", plan });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// Endpoint buat ambil plan terakhir
if (url.includes('/api/get-plan')) {
  const client = await pool.connect();
  const result = await client.query("SELECT * FROM training_plans WHERE user_id = $1 ORDER BY week_start DESC LIMIT 1", [query.user_id]);
  client.release();
  return res.json(result.rows[0] || {});
}
