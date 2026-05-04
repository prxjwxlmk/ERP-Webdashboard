# MotorStock — Manufacturing Inventory ERP Dashboard

> A self-hosted, role-based inventory and production management system built for **NGEF (HUBLI) Ltd.** — tracks raw & processed motor materials, Bill of Materials, production runs, transformer jobs, stock movements, and low-stock email alerts.

---

## ✨ Features

| Module | Description |
|---|---|
| **Inventory** | Manage raw & processed materials with quantity bars, min-stock thresholds, and photo attachments |
| **Motors & BOM** | Define motor models and their Bill of Materials; auto-deduct stock on production runs |
| **Production Log** | Record production runs with automatic material consumption and audit trail |
| **Stock-In** | Log incoming stock receipts per material with timestamps and user attribution |
| **Transformer Jobs** | Track transformer repair/assembly jobs, attach test result files (PDF, Excel, images), and manage job-specific material usage |
| **Reports** | Export stock summaries, stock-in history, production history, and BOM sheets to Excel or PDF |
| **Email Alerts** | Automatic low-stock notifications via SMTP (immediate + daily digest) |
| **Activity Log** | Full audit trail of every action taken across all modules |
| **Role-Based Access** | Five distinct roles with fine-grained route and UI permissions |

---

## 👥 Roles

| Role | Label | Permissions |
|---|---|---|
| `admin` | Admin | Full access — all reads, writes, deletes, and settings |
| `store` | Store Manager | Manage materials, stock-in, uploads; no system settings |
| `production` | Production Supervisor | Log production runs, process BOM, view inventory |
| `transformer` | Transformer Manager | Create/manage transformer jobs and their materials & files |
| `viewer` | Viewer | Read-only access to all sections |

---

## 🗂️ Project Structure

```
MotorStock/
├── server.js                  # Express backend — API routes + DB logic
├── motor-stock-dashboard.html # Main single-page ERP dashboard
├── motorstock.db              # SQLite database (auto-created)
├── auth.json                  # User credentials and roles
├── alert-config.json          # SMTP / email alert configuration
├── BACKUP.bat                 # Windows backup script
├── START SERVER.bat           # Windows one-click server launcher
├── package.json
└── uploads/                   # Auto-created — stores material/motor images
    └── transformer/           # Transformer job file attachments
```

---

## 🛠️ Tech Stack

- **Backend** — [Node.js](https://nodejs.org/) + [Express 5](https://expressjs.com/)
- **Database** — [SQLite](https://www.sqlite.org/) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode)
- **File Uploads** — [Multer](https://github.com/expressjs/multer)
- **Email** — [Nodemailer](https://nodemailer.com/)
- **Frontend** — Vanilla HTML/CSS/JS (no build step required)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm (bundled with Node.js)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/MotorStock.git
cd MotorStock

# 2. Install dependencies
npm install

# 3. Configure credentials (see Configuration section below)
#    Edit auth.json and alert-config.json before first run

# 4. Start the server
npm start
```

The dashboard will be available at **http://localhost:8080**

> **Windows users:** Double-click `START SERVER.bat` to launch the server without opening a terminal.

---

## ⚙️ Configuration

### 1. User Credentials — `auth.json`

Define usernames, passwords, and roles. Change all default passwords before deploying.

```json
{
  "admin":       { "password": "your-strong-password", "role": "admin",       "label": "Admin" },
  "store":       { "password": "your-strong-password", "role": "store",       "label": "Store Manager" },
  "production":  { "password": "your-strong-password", "role": "production",  "label": "Production Supervisor" },
  "transformer": { "password": "your-strong-password", "role": "transformer", "label": "Transformer Manager" },
  "viewer":      { "password": "your-strong-password", "role": "viewer",      "label": "Viewer" }
}
```

### 2. Email Alerts — `alert-config.json`

Configure SMTP for low-stock notifications. Gmail App Passwords are recommended.

```json
{
  "enabled": true,
  "smtpUser": "your-email@gmail.com",
  "smtpPass": "your-gmail-app-password",
  "recipients": "recipient@example.com"
}
```

> **Gmail App Password:** Go to Google Account → Security → 2-Step Verification → App Passwords. Do **not** use your main Gmail password here.

---

## 🗄️ Database Schema

The SQLite database is automatically created and migrated on first run. Core tables:

| Table | Purpose |
|---|---|
| `materials` | Inventory items (name, unit, qty, min_qty, category, type, image) |
| `motors` | Motor models (name, power, frame, image) |
| `bom` | Bill of Materials — links motors to materials with `qty_per` |
| `productions` | Production run history |
| `activity_log` | Full audit trail |
| `stock_in` | Incoming stock receipts |
| `transformer_jobs` | Transformer job records |
| `transformer_materials` | Materials consumed per transformer job |
| `transformer_files` | File attachments per transformer job |

---

## 📦 API Overview

All endpoints are under `/api/` and require session authentication.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/login` | Authenticate and start session |
| `GET` | `/api/data` | Fetch all materials, motors, BOM, and production data |
| `POST` | `/api/data` | Add or update a material or motor |
| `POST` | `/api/process-run` | Log a production run and deduct stock |
| `GET/POST` | `/api/stock-in` | View or add stock-in records |
| `GET/POST` | `/api/transformer/jobs` | List or create transformer jobs |
| `POST` | `/api/transformer/jobs/:id/files` | Attach files to a transformer job |
| `GET/POST` | `/api/alert-config` | View or update email alert settings |
| `POST` | `/api/alert-config/test` | Send a test alert email |

---

## 🔒 Security Notes

> **⚠️ This system is intended for use on a trusted local network.**

- Change all default passwords in `auth.json` immediately.
- Never commit `auth.json` or `alert-config.json` with real credentials — add them to `.gitignore`.
- The server has no HTTPS out of the box; use a reverse proxy (e.g., Nginx) with TLS if exposing externally.
- Session tokens are stored in memory and reset on server restart.

### Recommended `.gitignore`

```gitignore
node_modules/
motorstock.db
motorstock.db-shm
motorstock.db-wal
auth.json
alert-config.json
uploads/
backups/
*.db
*.db-shm
*.db-wal
```

---

## 💾 Backup

Run `BACKUP.bat` (Windows) to create a timestamped copy of the database in the `backups/` folder. For automated backups, schedule this script with Windows Task Scheduler or set up a cron job on Linux.

---

## 📋 License

This project is proprietary software developed for internal use at NGEF (HUBLI) Ltd. All rights reserved.
