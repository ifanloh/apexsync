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

// --------- METRICS CALCULATION ----------
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
    const tss = Number(act.tss) || 0;
    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;

    await client.query(
      `INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, record_date)
       DO UPDATE SET ctl=$3, atl=$4, tsb=$5`,
      [userId, act.start_date, ctl, atl, ctl - atl]
    );
  }
}

// --------- HELPER: resolve default user_id ----------
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

// --------- HANDLER ----------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Safe body parse
  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    // ignore
  }

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
        // Placeholder TSS (improve later)
        const tss = (act.moving_time / 3600) * 85;

        await client.query(
          `INSERT INTO activities
           (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
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
             updated_at=now()`,
          [
            uid,
            act.id.toString(),
            act.name,
            act.distance,
            act.moving_time,
            act.total_elevation_gain,
            tss,
            act.start_date,
            act.type,
          ]
        );
      }

      // Rebuild metrics after sync
      await calculateMetrics(client, uid);

      return res.redirect("/");
    } catch (e) {
      return res.status(500).json({ error: e.message });
    } finally {
      if (client) client.release();
    }
  }

  // ========= POST: update race target =========
  if (req.method === "POST") {
    const client = await pool.connect();
    try {
      const { user_id, race_name, target_km, race_date } = body || {};
      if (!user_id) return res.status(400).json({ error: "user_id required" });

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
  }

  // ========= GET: dashboard payload =========
  const client = await pool.connect();
  try {
    let userId = req.query?.user_id;
    if (!userId) userId = await resolveDefaultUserId(client);

    if (!userId) {
      // No data at all yet
      return res.json({ metrics: [], weekly: [], prs: {}, activities: [] });
    }

    // 1) Recent activities (needed by index.html)
    const activities = await client.query(
      `SELECT activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type
       FROM activities
       WHERE user_id=$1
       ORDER BY start_date DESC
       LIMIT 20`,
      [userId]
    );

    // 2) Metrics
    let metrics = await client.query(
      `SELECT m.*, p.display_name, p.race_name, p.target_km, p.race_date
       FROM user_metrics m
       LEFT JOIN connected_platforms p ON m.user_id=p.user_id
       WHERE m.user_id=$1
       ORDER BY m.record_date DESC
       LIMIT 120`,
      [userId]
    );

    // AUTO-FIX: if metrics empty but activities exist -> compute once
    if (metrics.rows.length === 0 && activities.rows.length > 0) {
      await calculateMetrics(client, userId);
      metrics = await client.query(
        `SELECT m.*, p.display_name, p.race_name, p.target_km, p.race_date
         FROM user_metrics m
         LEFT JOIN connected_platforms p ON m.user_id=p.user_id
         WHERE m.user_id=$1
         ORDER BY m.record_date DESC
         LIMIT 120`,
        [userId]
      );
    }

    // 3) Weekly volume
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

    // 4) PRs
    const prs = await client.query(
      `SELECT
        MAX(distance) as max_dist,
        MAX(total_elevation_gain) as max_elev,
        MIN(CASE WHEN distance BETWEEN 9500 AND 10500 THEN moving_time END) as best_10k
       FROM activities
       WHERE user_id=$1`,
      [userId]
    );

    return res.json({
      metrics: metrics.rows,
      weekly: weekly.rows,
      prs: prs.rows[0] || {},
      activities: activities.rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
