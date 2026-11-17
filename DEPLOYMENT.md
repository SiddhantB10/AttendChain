# Deploying AttendChain (Vercel + Render)

```
 Student / faculty browser  (HTTPS — needed for camera + location)
            │
            ▼
   Vercel  ── serves the web app (backend/static)
            │   /api/*  is forwarded (vercel.json rewrite)
            ▼
   Render  ── Docker: Flask + gunicorn + OpenCV/MediaPipe face AI
            │
            ├── MongoDB Atlas  (students, courses, attendance)
            └── Hedera testnet (AttendanceRegistry smart contract)
```

**Why two hosts?** The face-recognition backend needs ~400 MB of RAM, ~40 MB of AI models and a
long-running process, which doesn't fit Vercel's serverless functions. So Render runs the
backend and Vercel serves the pages. Because Vercel forwards `/api/*` to Render, the browser
sees **one HTTPS site**: no CORS setup, and camera + location keep working.

Vercel needs **no environment variables**. Every setting goes into **Render**.

---

## 0. Before you start

1. **Commit and push** everything (including `Dockerfile`, `render.yaml`, `vercel.json`) to GitHub.
   `.env` is git-ignored and must stay that way. Check with `git status` that `.env` is not listed.
2. Have these ready (from your local `.env`):
   - `MONGODB_URI` (your Atlas connection string)
   - `FACULTY_PRIVATE_KEY` (Hedera testnet ECDSA key)
3. Pick **new** passwords for the live site. Don't reuse any password that appears in this
   repository (the code and README are public):
   - an admin password (10+ characters)
   - a faculty password (8+ characters) for the seeded faculty accounts

## 1. MongoDB Atlas: allow Render to connect

Render's free plan has no fixed IP address, so Atlas must accept connections from anywhere:

1. Atlas → **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`) → Confirm.
2. Atlas → **Database Access**: make sure the user in your `MONGODB_URI` has a strong password.

Your database is named **`Attendchain`** (capital A). `render.yaml` already uses that name.
The name is case-sensitive: a different spelling starts an empty database.

## 2. Render: deploy the backend

1. <https://dashboard.render.com> → **New** → **Blueprint** → connect GitHub → pick the `AttendChain` repo.
2. Render reads `render.yaml` and creates the `attendchain-api` web service. It asks for the secret values:

   | Variable | What to enter |
   |---|---|
   | `ADMIN_PASSWORD` | your new admin password (10+ chars) |
   | `FACULTY_PASSWORD` | new password for `faculty@college.edu` / `hamilton@college.edu` |
   | `MONGODB_URI` | your Atlas connection string |
   | `FACULTY_PRIVATE_KEY` | your Hedera ECDSA private key (`0x…`) |

   `SECRET_KEY` and `ADMIN_TOKEN` are generated automatically. Everything else is pre-filled.
3. Click **Apply**. The first build takes about 10 minutes: it installs OpenCV/MediaPipe and downloads the AI models.
4. When it shows **Live**, open `https://attendchain-api.onrender.com/api/healthz`. You should see `{"ok":true}`.
   Then open `/api/health` and check `"chain_mode": "hedera"` and `"engine_type": "OpenCVFaceEngine"`.

> If Render gives the service a different address (e.g. `attendchain-api-x1y2.onrender.com`
> because the name was taken), copy it. You'll need it in step 3.

**If the deploy fails**, open the service → **Logs**. The server deliberately refuses to start
with unsafe settings and prints exactly what is missing, for example:
`Production configuration is not safe to start: ADMIN_PASSWORD must be set…`

## 3. Vercel: deploy the frontend

1. If your Render address is **not** `attendchain-api.onrender.com`, edit `vercel.json` →
   `"destination"` → put your address, then commit and push.
2. <https://vercel.com/new> → import the `AttendChain` repo.
3. Leave the settings as they are (`vercel.json` sets Framework = Other, no install/build,
   output = `backend/static`). Add **no** environment variables → **Deploy**.
4. Open `https://<your-project>.vercel.app`. The sign-in page should load.

## 4. Test the live site

- [ ] Sign in as admin (`admin@attendchain.edu` + your new `ADMIN_PASSWORD`).
- [ ] Sign in as faculty (`faculty@college.edu` + your `FACULTY_PASSWORD`) and create a course.
- [ ] On a **phone**, sign up as a student, enrol your face, join the course with the invite code.
- [ ] Faculty: **Take Attendance**. Student (on campus): **Scan Face & Mark Attendance**.
      You should get "Attendance Recorded" with a HashScan link.
- [ ] Off campus, the scan button stays disabled ("Outside campus").

## Environment variables: where each one goes

| Variable | Render | Local `.env` | Notes |
|---|---|---|---|
| `APP_ENV` | `production` | `development` | production enforces all safety checks |
| `SECRET_KEY` | auto-generated | optional | signs sign-in sessions |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✔ (password secret) | ✔ | central admin sign-in |
| `FACULTY_PASSWORD` | ✔ secret | optional | replaces demo password `faculty123` |
| `ADMIN_TOKEN` | auto-generated | optional | API token for scripts only |
| `DATABASE_BACKEND` | `mongodb` | `sqlite` or `mongodb` | |
| `MONGODB_URI` | ✔ secret | ✔ if mongodb | |
| `MONGODB_DB_NAME` | `Attendchain` | same | case-sensitive |
| `CHAIN_MODE` | `hedera` | any | |
| `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID`, `CONTRACT_ADDRESS` | pre-filled | ✔ | |
| `FACULTY_PRIVATE_KEY` | ✔ secret | ✔ | |
| `CAMPUS_*`, `GEOFENCE_*` | pre-filled | ✔ | campus zone |
| `MIN_ATTENDANCE_PERCENT`, `FACE_SIMILARITY_THRESHOLD` | pre-filled | ✔ | |
| `CORS_ORIGINS` | not needed | not needed | only if you skip the Vercel rewrite |
| `PORT` | set by Render | `5000` | |
| **Vercel** | **nothing** | | |

## Free-plan limits (read before your viva)

- **Render free sleeps after 15 minutes without traffic** and takes about a minute to wake.
  The first request after a pause may fail or hang: **open the site 2–3 minutes before class or
  the demo**. To remove the sleep, change `plan: free` → `plan: starter` ($7/month) in `render.yaml`.
- **Memory**: the free and Starter plans both have 512 MB. AttendChain measured ~90 MB at start
  and ~340 MB with all AI models loaded, so it fits, but not by much. If Render logs show
  *"Out of memory"*, use the Standard plan (2 GB).
- MongoDB Atlas free (M0) and Hedera testnet are fine for a college project.

## Updating the site

Push to GitHub → Render and Vercel both redeploy automatically.

## Running locally (unchanged)

```bash
pip install -r requirements.txt
python scripts/download_models.py
python -m backend.app          # http://localhost:5000
```

Locally, `APP_ENV` defaults to `development`: the sign-in page shows the demo shortcut buttons
and the dev fallbacks work. Your local SQLite or Atlas data is untouched.

## Security notes

- Sign-in uses personal, signed, expiring session tokens. Passwords are stored as salted hashes:
  old plaintext passwords are converted automatically the next time each person signs in.
- The old shortcut passwords (`admin123`, `student123`, `siddhant`, the default admin token)
  no longer work anywhere.
- On the live site, accounts still on the demo password `faculty123` can't sign in until
  `FACULTY_PASSWORD` is set (or an admin creates the account with a real password).
- Students can only see and change their own data, and can only mark **their own** attendance:
  the face scanned must match the signed-in student.
- 10 wrong passwords in 15 minutes for one account from one network blocks further tries for a while.
- To rotate a secret: change it in Render → **Environment** → Save (the service restarts).
  Changing `SECRET_KEY` signs everyone out.
