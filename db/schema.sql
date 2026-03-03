-- Minimal schema that matches api/metrics.js and api/save-strategy.js
-- Postgres 13+

CREATE TABLE IF NOT EXISTS connected_platforms (
  user_id           text PRIMARY KEY,
  platform_name     text,
  display_name      text,
  race_name         text,
  target_km         numeric,
  race_date         date,
  updated_at        timestamptz
);

CREATE TABLE IF NOT EXISTS activities (
  user_id               text NOT NULL,
  activity_id           text PRIMARY KEY,
  title                 text,
  distance              double precision,
  moving_time           integer,
  total_elevation_gain  double precision,
  tss                   double precision,
  start_date            timestamptz,
  type                  text,
  avg_hr                double precision,
  max_hr                double precision,
  updated_at            timestamptz
);

CREATE INDEX IF NOT EXISTS activities_user_date_idx
  ON activities (user_id, start_date DESC);

CREATE TABLE IF NOT EXISTS user_metrics (
  user_id      text NOT NULL,
  record_date  timestamptz NOT NULL,
  ctl          double precision,
  atl          double precision,
  tsb          double precision,
  PRIMARY KEY (user_id, record_date)
);

CREATE INDEX IF NOT EXISTS user_metrics_user_date_idx
  ON user_metrics (user_id, record_date DESC);

CREATE TABLE IF NOT EXISTS daily_summary (
  user_id         text NOT NULL,
  day             date NOT NULL,
  distance_m      double precision,
  moving_time_s   double precision,
  elev_m          double precision,
  tss             double precision,
  activity_count  integer,
  ctl             double precision,
  atl             double precision,
  tsb             double precision,
  PRIMARY KEY (user_id, day)
);
