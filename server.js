const express = require("express");
const { Pool } = require("pg");
const { stringify } = require("csv-stringify/sync");

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "gruppe6";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("WARNUNG: DATABASE_URL fehlt. Datenbankverbindung funktioniert erst auf Render mit Postgres.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static("public"));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      consent BOOLEAN NOT NULL,
      condition INTEGER NOT NULL,
      demand INTEGER NOT NULL,
      final_grade INTEGER NOT NULL,
      perceived_fairness INTEGER,
      perceived_exaggeration INTEGER,
      resistance INTEGER,
      seriousness INTEGER,
      age INTEGER,
      gender TEXT,
      university_relation TEXT,
      duration_seconds INTEGER,
      user_agent TEXT
    );
  `);
}

app.post("/api/submit", async (req, res) => {
  try {
    const {
      consent,
      condition,
      demand,
      finalGrade,
      perceivedFairness,
      perceivedExaggeration,
      resistance,
      seriousness,
      age,
      gender,
      universityRelation,
      durationSeconds
    } = req.body;

    if (consent !== true) {
      return res.status(400).json({ error: "Einwilligung fehlt." });
    }

    if (![1, 2, 3, 4].includes(Number(condition))) {
      return res.status(400).json({ error: "Ungültige Bedingung." });
    }

    if (![9, 11, 13, 15].includes(Number(demand))) {
      return res.status(400).json({ error: "Ungültige Forderung." });
    }

    if (!Number.isInteger(Number(finalGrade)) || Number(finalGrade) < 0 || Number(finalGrade) > 15) {
      return res.status(400).json({ error: "Finale Bewertung muss zwischen 0 und 15 liegen." });
    }

    await pool.query(
      `
      INSERT INTO responses (
        consent, condition, demand, final_grade,
        perceived_fairness, perceived_exaggeration, resistance, seriousness,
        age, gender, university_relation, duration_seconds, user_agent
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        consent,
        Number(condition),
        Number(demand),
        Number(finalGrade),
        perceivedFairness ? Number(perceivedFairness) : null,
        perceivedExaggeration ? Number(perceivedExaggeration) : null,
        resistance ? Number(resistance) : null,
        seriousness ? Number(seriousness) : null,
        age ? Number(age) : null,
        gender || null,
        universityRelation || null,
        durationSeconds ? Number(durationSeconds) : null,
        req.headers["user-agent"] || null
      ]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Serverfehler beim Speichern." });
  }
});

app.get("/admin/export", async (req, res) => {
  try {
    const password = req.query.password;

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).send("Nicht autorisiert.");
    }

    const result = await pool.query(`
      SELECT
        id,
        created_at,
        condition,
        demand,
        final_grade,
        perceived_fairness,
        perceived_exaggeration,
        resistance,
        seriousness,
        age,
        gender,
        university_relation,
        duration_seconds,
        user_agent
      FROM responses
      ORDER BY created_at ASC;
    `);

    const csv = stringify(result.rows, {
      header: true
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=notenvergabe_responses.csv");
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).send("Export fehlgeschlagen.");
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server läuft auf Port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Datenbank konnte nicht initialisiert werden:", error);
    process.exit(1);
  });
