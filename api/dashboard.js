const { Pool } = require("pg");

// Reuse pool across serverless invocations
if (!global._pool) {
  global._pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}
const pool = global._pool;

function isoDate(d) {
  // d: Date -> YYYY-MM-DD
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseRange(req) {
  const now = new Date();
  const defaultTo = isoDate(now);
  const fromDate = new Date(now);
  fromDate.setUTCDate(fromDate.getUTCDate() - 90);
  const defaultFrom = isoDate(fromDate);

  const from = (req.query?.from || defaultFrom).slice(0, 10);
  const to = (req.query?.to || defaultTo).slice(0, 10);
  return { from, to };
}

async function resolveDefaultUserId(client) {
  // Prefer last updated connected platform, fallback to daily_summary, fallback to activities
  const cp = await client.query(
    `SELECT user_id
     FROM connected_platforms
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`
  );
  if (cp.rows?.[0]?.user_id) return cp.rows[0].user_id;

  const ds = await client.query(
    `SELECT user_id
     FROM daily_summary
     ORDER BY day DESC
     LIMIT 1`
  );
  if (ds.rows?.[0]?.user_id) return ds.rows[0].user_id;

  const a = await client.query(
    `SELECT user_id
     FROM activities
     ORDER BY start_date DESC
     LIMIT 1`
  );
  if (a.rows?.[0]?.user_id) return a.rows[0].user_id;

  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { from, to } = parseRange(req);

  const client = await pool.connect();
  try {
    let userId = req.query?.user_id;
    if (!userId) userId = await resolveDefaultUserId(client);

    if (!userId) {
      return res.json({
        profile: null,
        summary: { range: { from, to }, totals: {}, today: {} },
        timeseries: [],
        weekly: [],
        activities: [],
      });
    }

    // Profile / race target
    const profileRes = await client.query(
      `SELECT user_id, display_name, race_name, target_km, race_date
       FROM connected_platforms
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    const profileRow = profileRes.rows[0] || null;
    const profile = {
      user_id: userId,
      display_name: profileRow?.display_name || null,
      race: profileRow
        ? {
            name: profileRow.race_name || null,
            target_km: profileRow.target_km ?? null,
            date: profileRow.race_date ? String(profileRow.race_date).slice(0, 10) : null,
          }
        : { name: null, target_km: null, date: null },
    };

    // Daily timeseries from daily_summary (this is your COROS-like backbone)
    const ts = await client.query(
      `SELECT
         day,
         distance_m,
         moving_time_s,
         elev_m,
         tss,
         activity_count,
         ctl,
         atl,
         tsb
       FROM daily_summary
       WHERE user_id = $1
         AND day >= $2::date
         AND day <= $3::date
       ORDER BY day ASC`,
      [userId, from, to]
    );

    const timeseries = ts.rows.map((r) => ({
      date: String(r.day).slice(0, 10),
      distance_m: Number(r.distance_m) || 0,
      moving_time_s: Number(r.moving_time_s) || 0,
      elev_m: Number(r.elev_m) || 0,
      tss: Number(r.tss) || 0,
      count: Number(r.activity_count) || 0,
      ctl: r.ctl == null ? null : Number(r.ctl),
      atl: r.atl == null ? null : Number(r.atl),
      tsb: r.tsb == null ? null : Number(r.tsb),
    }));

    // Summary totals for range + today fitness/fatigue/form
    const totalsRes = await client.query(
      `SELECT
         COALESCE(SUM(distance_m),0) AS distance_m,
         COALESCE(SUM(moving_time_s),0) AS moving_time_s,
         COALESCE(SUM(elev_m),0) AS elev_m,
         COALESCE(SUM(tss),0) AS tss,
         COALESCE(SUM(activity_count),0) AS activity_count
       FROM daily_summary
       WHERE user_id = $1
         AND day >= $2::date
         AND day <= $3::date`,
      [userId, from, to]
    );

    const todayRes = await client.query(
      `SELECT ctl, atl, tsb, day
       FROM daily_summary
       WHERE user_id = $1
       ORDER BY day DESC
       LIMIT 1`,
      [userId]
    );

    const totals = totalsRes.rows[0] || {};
    const today = todayRes.rows[0] || {};

    // Weekly aggregates (week starts Monday)
    const weeklyRes = await client.query(
      `SELECT
         date_trunc('week', day::timestamp)::date AS week_start,
         COALESCE(SUM(distance_m),0) AS distance_m,
         COALESCE(SUM(moving_time_s),0) AS moving_time_s,
         COALESCE(SUM(elev_m),0) AS elev_m,
         COALESCE(SUM(tss),0) AS tss,
         COALESCE(SUM(activity_count),0) AS activity_count
       FROM daily_summary
       WHERE user_id = $1
         AND day >= $2::date
         AND day <= $3::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId, from, to]
    );

    const weekly = weeklyRes.rows.map((r) => ({
      week_start: String(r.week_start).slice(0, 10),
      distance_m: Number(r.distance_m) || 0,
      moving_time_s: Number(r.moving_time_s) || 0,
      elev_m: Number(r.elev_m) || 0,
      tss: Number(r.tss) || 0,
      count: Number(r.activity_count) || 0,
    }));

    // Activity feed (recent)
    const activitiesRes = await client.query(
      `SELECT
         activity_id,
         title,
         type,
         distance,
         moving_time,
         total_elevation_gain,
         tss,
         start_date
       FROM activities
       WHERE user_id = $1
       ORDER BY start_date DESC
       LIMIT 30`,
      [userId]
    );

    const activities = activitiesRes.rows.map((a) => ({
      activity_id: a.activity_id,
      title: a.title,
      type: a.type,
      distance_m: Number(a.distance) || 0,
      moving_time_s: Number(a.moving_time) || 0,
      elev_m: Number(a.total_elevation_gain) || 0,
      tss: Number(a.tss) || 0,
      date: a.start_date ? new Date(a.start_date).toISOString() : null,
    }));

    return res.json({
      profile,
      summary: {
        range: { from, to },
        totals: {
          distance_m: Number(totals.distance_m) || 0,
          moving_time_s: Number(totals.moving_time_s) || 0,
          elev_m: Number(totals.elev_m) || 0,
          tss: Number(totals.tss) || 0,
          activity_count: Number(totals.activity_count) || 0,
        },
        today: {
          day: today.day ? String(today.day).slice(0, 10) : null,
          ctl: today.ctl == null ? null : Number(today.ctl),
          atl: today.atl == null ? null : Number(today.atl),
          tsb: today.tsb == null ? null : Number(today.tsb),
        },
      },
      timeseries,
      weekly,
      activities,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
