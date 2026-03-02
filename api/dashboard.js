const { Pool } = require("pg");
const axios = require("axios");

// Reuse pool across serverless invocations
if (!global._pool) {
  global._pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}
const pool = global._pool;

/**
 * COROS-like: HR-based training load
 * We approximate using Bannister TRIMP-like model.
 *
 * Inputs:
 * - moving_time_s
 * - avg_hr
 * - hr_rest, hr_max (estimated if not available)
 *
 * Output:
 * - load score (store into activities.tss)
 */
function estimateHrRestMaxFallback({ avgHr, maxHr }) {
  // Reasonable fallbacks if user settings are absent
  const hrRest = 55; // typical; COROS uses resting HR baseline
  let hrMax = 190;

  if (Number.isFinite(maxHr) && maxHr > 120) hrMax = maxHr;
  else if (Number.isFinite(avgHr) && avgHr > 120) hrMax = Math.max(180, Math.min(205, avgHr + 35));

  return { hrRest, hrMax };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function calcHrLoadTRIMP(movingTimeS, avgHr, hrRest, hrMax) {
  const durMin = (Number(movingTimeS) || 0) / 60;
  const aHr = Number(avgHr);

  if (!Number.isFinite(durMin) || durMin <= 0) return 0;
  if (!Number.isFinite(aHr) || aHr <= 0) {
    // No HR data -> degrade to duration-only low fidelity
    // (still better than nothing, but will differ vs COROS)
    return durMin * 1.0;
  }

  const denom = (hrMax - hrRest);
  if (!Number.isFinite(denom) || denom <= 10) return durMin * 1.0;

  // HR reserve ratio
  const hrr = clamp((aHr - hrRest) / denom, 0, 1);

  // Bannister TRIMP (male constants). COROS is proprietary; this approximates the curve.
  // TRIMP = duration_min * hrr * 0.64 * exp(1.92*hrr)
  const trimp = durMin * hrr * 0.64 * Math.exp(1.92 * hrr);

  // Scale to a "load score" similar magnitude to COROS TL:
  // COROS TL often lands ~30-200 per session depending intensity/duration.
  // This factor calibrates typical runs into similar range.
  const scaled = trimp * 10;

  return Math.round(scaled * 10) / 10;
}

async function calculateMetrics(client, userId) {
  const res = await client.query(
    `SELECT tss, start_date
     FROM activities
     WHERE user_id = $1
     ORDER BY start_date ASC`,
    [userId]
  );

  let ctl = 0;
  let atl = 0;

  for (const act of res.rows) {
    const load = Number(act.tss) || 0;

    ctl = ctl + (load - ctl) / 42;
    atl = atl + (load - atl) / 7;

    await client.query(
      `INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, record_date)
       DO UPDATE SET ctl=$3, atl=$4, tsb=$5`,
      [userId, act.start_date, ctl, atl, ctl - atl]
    );
  }
}

async function upsertDailySummaryFromActivities(client, userId) {
  // aggregate by day
  await client.query(
    `INSERT INTO daily_summary (user_id, day, distance_m, moving_time_s, elev_m, tss, activity_count)
     SELECT
       user_id,
       DATE(start_date) AS day,
       COALESCE(SUM(distance),0) AS distance_m,
       COALESCE(SUM(moving_time),0) AS moving_time_s,
       COALESCE(SUM(total_elevation_gain),0) AS elev_m,
       COALESCE(SUM(tss),0) AS tss,
       COUNT(*) AS activity_count
     FROM activities
     WHERE user_id = $1
     GROUP BY user_id, DATE(start_date)
     ON CONFLICT (user_id, day)
     DO UPDATE SET
       distance_m = EXCLUDED.distance_m,
       moving_time_s = EXCLUDED.moving_time_s,
       elev_m = EXCLUDED.elev_m,
       tss = EXCLUDED.tss,
       activity_count = EXCLUDED.activity_count`,
    [userId]
  );

  // bring ctl/atl/tsb into daily_summary
  await client.query(
    `UPDATE daily_summary d
     SET ctl = m.ctl, atl = m.atl, tsb = m.tsb
     FROM user_metrics m
     WHERE d.user_id = m.user_id
       AND d.day = DATE(m.record_date)
       AND d.user_id = $1`,
    [userId]
  );
}

async function resolveDefaultUserId(client) {
  const cp = await client.query(
    `SELECT user_id
     FROM connected_platforms
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`
  );
  if (cp.rows?.[0]?.user_id) return cp.rows[0].user_id;

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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Safe body parse
  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch {}

  // ========= STRAVA CALLBACK =========
  if (req.query?.code) {
    let client;
    try {
      const tokenRes = await axios.post("https://www.strava.com/oauth/token", {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: req.query.code,
        grant_type: "authorization_code",
      });

      const { access_token, athlete } = tokenRes.data;
      const uid = athlete.id.toString();
      const athleteName = `${athlete.firstname} ${athlete.lastname}`;

      client = await pool.connect();

      await client.query(
        `INSERT INTO connected_platforms (user_id, platform_name, display_name, updated_at)
         VALUES ($1,'strava',$2, now())
         ON CONFLICT (user_id)
         DO UPDATE SET display_name=$2, platform_name='strava', updated_at=now()`,
        [uid, athleteName]
      );

      const actRes = await axios.get(
        "https://www.strava.com/api/v3/athlete/activities?per_page=100",
        { headers: { Authorization: `Bearer ${access_token}` } }
      );

      for (const act of actRes.data) {
        const movingTime = act.moving_time || 0;
        const avgHr = act.average_heartrate ?? null;
        const maxHr = act.max_heartrate ?? null;

        const { hrRest, hrMax } = estimateHrRestMaxFallback({
          avgHr: Number(avgHr),
          maxHr: Number(maxHr),
        });

        // COROS-like load score
        const load = calcHrLoadTRIMP(movingTime, avgHr, hrRest, hrMax);

        await client.query(
          `INSERT INTO activities
           (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type, avg_hr, max_hr, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (activity_id)
           DO UPDATE SET
             user_id=$1,
             title=$3,
             distance=$4,
             moving_time=$5,
             total_elevation_gain=$6,
             tss=$7,
             start_date=$8,
             type=$9,
             avg_hr=$10,
             max_hr=$11,
             updated_at=now()`,
          [
            uid,
            act.id.toString(),
            act.name,
            act.distance,
            movingTime,
            act.total_elevation_gain,
            load,
            act.start_date,
            act.type,
            avgHr,
            maxHr,
          ]
        );
      }

      // Rebuild metrics & daily summary
      await calculateMetrics(client, uid);
      await upsertDailySummaryFromActivities(client, uid);

      return res.redirect("/");
    } catch (e) {
      return res.status(500).json({ error: e.message });
    } finally {
      if (client) client.release();
    }
  }

  // ========= DATA REQUEST (legacy) =========
  const client = await pool.connect();
  try {
    let userId = req.query?.user_id;
    if (!userId) userId = await resolveDefaultUserId(client);

    if (!userId) {
      return res.json({ metrics: [], weekly: [], prs: {}, activities: [] });
    }

    const activities = await client.query(
      `SELECT activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type, avg_hr, max_hr
       FROM activities
       WHERE user_id=$1
       ORDER BY start_date DESC
       LIMIT 20`,
      [userId]
    );

    const metrics = await client.query(
      `SELECT m.*, p.display_name, p.race_name, p.target_km, p.race_date
       FROM user_metrics m
       LEFT JOIN connected_platforms p ON m.user_id=p.user_id
       WHERE m.user_id=$1
       ORDER BY m.record_date DESC
       LIMIT 120`,
      [userId]
    );

    const weekly = await client.query(
      `SELECT
         to_char(start_date,'Dy') as day,
         SUM(distance) as dist
       FROM activities
       WHERE user_id=$1
         AND start_date > NOW() - INTERVAL '7 days'
       GROUP BY day
       ORDER BY MIN(start_date)`,
      [userId]
    );

    const prs = await client.query(
      `SELECT
        MAX(distance) as max_dist,
        MAX(total_elevation_gain) as max_elev
       FROM activities
       WHERE user_id=$1`,
      [userId]
    );

    return res.json({
      metrics: metrics.rows,
      weekly: weekly.rows,
      prs: prs.rows[0] || {},
      activities: activities.rows.map((a) => ({
        activity_id: a.activity_id,
        title: a.title,
        type: a.type,
        distance_m: Number(a.distance) || 0,
        moving_time_s: Number(a.moving_time) || 0,
        elev_m: Number(a.total_elevation_gain) || 0,
        tss: Number(a.tss) || 0,
        avg_hr: a.avg_hr == null ? null : Number(a.avg_hr),
        max_hr: a.max_hr == null ? null : Number(a.max_hr),
        date: a.start_date ? new Date(a.start_date).toISOString() : null,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
