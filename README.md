# Apexnity (ApexSync) – COROS/Strava Training Hub (Vercel)

Static dashboard (`index.html`) + 2 Vercel Serverless Functions:

- `GET /api/metrics` – Strava OAuth callback **and** dashboard data API
- `POST /api/save-strategy` – simpan target race (nama race, target km, tanggal)

## Required environment variables (Vercel)

- `DATABASE_URL` – PostgreSQL connection string (Neon/Supabase/etc)
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`

## Local dev

```bash
npm i
npm run dev
```

## Notes

- Strava authorize URL di `index.html` masih hard-coded ke domain deployment. Kalau ganti domain, update `redirect_uri`.
- Endpoint `GET /api/metrics` punya 2 mode:
  - mode callback: jika ada query `?code=...`
  - mode API: tanpa `code`, akan return JSON metrik untuk dashboard
