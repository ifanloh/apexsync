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

// Helper: HR-based training load (TRIMP) - tanpa faktor pengali
function estimateHrRestMaxFallback({ avgHr, maxHr }) {
  const hrRest = 55;
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
    // Fallback: durasi saja (asumsi intensitas rendah)
    return durMin * 1.0;
  }

  const denom = hrMax - hrRest;
  if (!Number.isFinite(denom) || denom <= 10) return durMin * 1.0;

  const hrr = clamp((aHr - hrRest) / denom, 0, 1);
  const trimp = durMin * hrr * 0.64 * Math.exp(1.92 * hrr);

  // ⚠️ PERBAIKAN: tidak dikali 10 lagi
  const scaled = trimp;

  return Math.round(scaled * 10) / 10;
}

async function calculateMetrics(client, userId) {
  const res = await client.query(
    `SELECT tss, start_date FROM activities WHERE user_id = $1 ORDER BY start_date ASC`,
    [userId]
  );
  let ctl = 0, atl = 0;
  for (const act of res.rows) {
    const load = Number(act.tss) || 0;
    ctl = ctl + (load - ctl) / 42;
    atl = atl + (load - atl) / 7;
    await client.query(
      `INSERT INTO user_metrics (user_id, record_date, ctl, atl, tsb)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, record_date) DO UPDATE SET ctl=$3, atl=$4, tsb=$5`,
      [userId, act.start_date, ctl, atl, ctl - atl]
    );
  }
}

async function upsertDailySummaryFromActivities(client, userId) {
  await client.query(
    `INSERT INTO daily_summary (user_id, day, distance_m, moving_time_s, elev_m, tss, activity_count)
     SELECT user_id, DATE(start_date) AS day,
       COALESCE(SUM(distance),0) AS distance_m,
       COALESCE(SUM(moving_time),0) AS moving_time_s,
       COALESCE(SUM(total_elevation_gain),0) AS elev_m,
       COALESCE(SUM(tss),0) AS tss,
       COUNT(*) AS activity_count
     FROM activities WHERE user_id = $1
     GROUP BY user_id, DATE(start_date)
     ON CONFLICT (user_id, day) DO UPDATE SET
       distance_m = EXCLUDED.distance_m,
       moving_time_s = EXCLUDED.moving_time_s,
       elev_m = EXCLUDED.elev_m,
       tss = EXCLUDED.tss,
       activity_count = EXCLUDED.activity_count`,
    [userId]
  );
  await client.query(
    `UPDATE daily_summary d
     SET ctl = m.ctl, atl = m.atl, tsb = m.tsb
     FROM user_metrics m
     WHERE d.user_id = m.user_id AND d.day = DATE(m.record_date) AND d.user_id = $1`,
    [userId]
  );
}

async function resolveDefaultUserId(client) {
  const cp = await client.query(
    `SELECT user_id FROM connected_platforms ORDER BY updated_at DESC NULLS LAST LIMIT 1`
  );
  if (cp.rows?.[0]?.user_id) return cp.rows[0].user_id;
  const a = await client.query(
    `SELECT user_id FROM activities ORDER BY start_date DESC LIMIT 1`
  );
  return a.rows?.[0]?.user_id || null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

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
         ON CONFLICT (user_id) DO UPDATE SET display_name=$2, platform_name='strava', updated_at=now()`,
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
        const { hrRest, hrMax } = estimateHrRestMaxFallback({ avgHr: Number(avgHr), maxHr: Number(maxHr) });
        const load = calcHrLoadTRIMP(movingTime, avgHr, hrRest, hrMax);

        await client.query(
          `INSERT INTO activities
           (user_id, activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type, avg_hr, max_hr, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (activity_id) DO UPDATE SET
             user_id=$1, title=$3, distance=$4, moving_time=$5,
             total_elevation_gain=$6, tss=$7, start_date=$8, type=$9,
             avg_hr=$10, max_hr=$11, updated_at=now()`,
          [uid, act.id.toString(), act.name, act.distance, movingTime,
           act.total_elevation_gain, load, act.start_date, act.type, avgHr, maxHr]
        );
      }

      await calculateMetrics(client, uid);
      await upsertDailySummaryFromActivities(client, uid);
      return res.redirect("/");
    } catch (e) {
      return res.status(500).json({ error: e.message });
    } finally {
      if (client) client.release();
    }
  }

  // ========= DATA REQUEST =========
  const client = await pool.connect();
  try {
    let userId = req.query?.user_id;
    if (!userId) userId = await resolveDefaultUserId(client);
    if (!userId) {
      return res.json({
        profile: null,
        today: { ctl: 0, atl: 0, tsb: 0 },
        totals: { distance_m: 0, moving_time_s: 0, elev_m: 0, tss: 0 },
        timeseries: [],
        weekly: [],
        activities: [],
        recovery: { pct: 0, hours: 0 },
        threshold_pace: 300,
        race_predictions: [],
        prs: { max_dist_km: 0, max_elev_m: 0 }
      });
    }

    // Profil
    const profileRes = await client.query(
      `SELECT display_name, race_name, target_km, race_date FROM connected_platforms WHERE user_id = $1`,
      [userId]
    );
    const profile = profileRes.rows[0] || {};

    // Timeseries (90 hari)
    const metricsRes = await client.query(
      `SELECT record_date, ctl, atl, tsb FROM user_metrics
       WHERE user_id = $1 AND record_date >= NOW() - INTERVAL '90 days'
       ORDER BY record_date ASC`,
      [userId]
    );

    // Today (nilai terkini)
    const todayRes = await client.query(
      `SELECT ctl, atl, tsb FROM user_metrics WHERE user_id = $1 ORDER BY record_date DESC LIMIT 1`,
      [userId]
    );
    const today = todayRes.rows[0] || { ctl: 0, atl: 0, tsb: 0 };

    // Totals
    const totalsRes = await client.query(
      `SELECT
         COALESCE(SUM(distance),0) AS distance_m,
         COALESCE(SUM(moving_time),0) AS moving_time_s,
         COALESCE(SUM(total_elevation_gain),0) AS elev_m,
         COALESCE(SUM(tss),0) AS tss
       FROM activities WHERE user_id = $1`,
      [userId]
    );

    // Aktivitas terbaru (20)
    const activitiesRes = await client.query(
      `SELECT activity_id, title, distance, moving_time, total_elevation_gain, tss, start_date, type
       FROM activities WHERE user_id = $1 ORDER BY start_date DESC LIMIT 20`,
      [userId]
    );

    // Volume mingguan (7 hari)
    const weeklyRes = await client.query(
      `SELECT to_char(start_date, 'Dy') AS day, SUM(distance) AS dist
       FROM activities
       WHERE user_id = $1 AND start_date > NOW() - INTERVAL '7 days'
       GROUP BY day ORDER BY MIN(start_date)`,
      [userId]
    );

    // === METRIK TAMBAHAN ===
    const atlVal = today.atl || 0;
    const recoveryPct = Math.max(0, Math.min(100, 100 - atlVal * 0.7));
    const recoveryHours = Math.round((100 - recoveryPct) * 0.6);

    const ctlVal = today.ctl || 0;
    let thresholdPace = 250 - 0.4 * ctlVal;
    thresholdPace = Math.max(240, Math.min(400, thresholdPace));

    const baseDist = 1.609;
    const baseTime = thresholdPace * baseDist;
    const distances = [5, 10, 21.1, 42.2];
    const racePredictions = distances.map(d => ({
      dist: d,
      time: baseTime * Math.pow(d / baseDist, 1.06)
    }));

    const prRes = await client.query(
      `SELECT MAX(distance) AS max_dist, MAX(total_elevation_gain) AS max_elev
       FROM activities WHERE user_id = $1`,
      [userId]
    );
    const maxDistM = prRes.rows[0]?.max_dist || 0;
    const maxElevM = prRes.rows[0]?.max_elev || 0;

    return res.json({
      profile: {
        display_name: profile.display_name || 'Athlete',
        race_name: profile.race_name || null,
        target_km: profile.target_km ? Number(profile.target_km) : null,
        race_date: profile.race_date || null
      },
      today: {
        ctl: Number(today.ctl) || 0,
        atl: Number(today.atl) || 0,
        tsb: Number(today.tsb) || 0
      },
      totals: {
        distance_m: Number(totalsRes.rows[0].distance_m) || 0,
        moving_time_s: Number(totalsRes.rows[0].moving_time_s) || 0,
        elev_m: Number(totalsRes.rows[0].elev_m) || 0,
        tss: Number(totalsRes.rows[0].tss) || 0
      },
      timeseries: metricsRes.rows.map(row => ({
        date: row.record_date.toISOString().split('T')[0],
        ctl: Number(row.ctl),
        atl: Number(row.atl),
        tsb: Number(row.tsb)
      })),
      weekly: weeklyRes.rows.map(row => ({
        day: row.day,
        km: (Number(row.dist) / 1000).toFixed(1)
      })),
      activities: activitiesRes.rows.map(a => ({
        id: a.activity_id,
        name: a.title,
        type: a.type,
        distance_km: (Number(a.distance) / 1000).toFixed(1),
        duration_s: Number(a.moving_time) || 0,
        tss: Number(a.tss) || 0,
        start_date: a.start_date
      })),
      recovery: {
        pct: Math.round(recoveryPct),
        hours: recoveryHours
      },
      threshold_pace: Math.round(thresholdPace),
      race_predictions: racePredictions,
      prs: {
        max_dist_km: maxDistM / 1000,
        max_elev_m: maxElevM
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
