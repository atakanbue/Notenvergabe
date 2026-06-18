const express = require("express");
const { Pool } = require("pg");
const { stringify } = require("csv-stringify/sync");

const app = express();
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "gruppe6";

if (!DATABASE_URL) {
  console.warn("WARNUNG: DATABASE_URL ist nicht gesetzt.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function toOptionalInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : null;
}

function isValidLikert(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * Erstellt die Tabelle responses, falls sie noch nicht existiert.
 *
 * Die ALTER-TABLE-Befehle ergänzen fehlende Spalten in einer bereits
 * bestehenden alten Datenbank. Vorhandene Antworten werden nicht gelöscht.
 */
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      data_source TEXT NOT NULL DEFAULT 'render',
      survey_version TEXT NOT NULL DEFAULT 'render_v2',
      source_case_id TEXT,

      consent BOOLEAN NOT NULL,
      condition INTEGER NOT NULL,
      demand INTEGER NOT NULL,
      final_grade INTEGER NOT NULL,

      role_check TEXT,
      recalled_demand INTEGER,

      pressure INTEGER,
      restricted_freedom INTEGER,
      manipulative INTEGER,
      anger INTEGER,
      appropriate INTEGER,
      fair INTEGER,

      main_reason TEXT,
      comment TEXT,

      duration_seconds INTEGER,
      user_agent TEXT,

      perceived_fairness INTEGER,
      perceived_exaggeration INTEGER,
      resistance INTEGER,
      seriousness INTEGER,
      age INTEGER,
      gender TEXT,
      university_relation TEXT
    );
  `);

  const migrations = [
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS data_source
      TEXT NOT NULL DEFAULT 'render';
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS survey_version
      TEXT NOT NULL DEFAULT 'render_v2';
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS source_case_id TEXT;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS role_check TEXT;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS recalled_demand INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS pressure INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS restricted_freedom INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS manipulative INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS anger INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS appropriate INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS fair INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS main_reason TEXT;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS comment TEXT;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
    `,
    `
      ALTER TABLE responses
      ADD COLUMN IF NOT EXISTS user_agent TEXT;
    `
  ];

  for (const migration of migrations) {
    await pool.query(migration);
  }

  /*
   * Verhindert, dass derselbe aus SoSci importierte Fall mehrfach
   * in die Datenbank geschrieben wird.
   */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS responses_source_case_unique
    ON responses (data_source, source_case_id)
    WHERE source_case_id IS NOT NULL;
  `);

  console.log("Datenbank wurde erfolgreich initialisiert.");
}

/**
 * Testet, ob Web Service und Datenbank verbunden sind.
 *
 * Aufruf:
 * https://notenvergabe.onrender.com/health
 */
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1;");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch (error) {
    console.error("Healthcheck fehlgeschlagen:", error);

    res.status(500).json({
      ok: false,
      database: "disconnected"
    });
  }
});

/**
 * Speichert eine neue Teilnahme aus der Render-Webseite.
 */
app.post("/api/submit", async (req, res) => {
  try {
    const {
      consent,
      condition,
      demand,
      finalGrade,
      roleCheck,
      recalledDemand,
      pressure,
      restrictedFreedom,
      manipulative,
      anger,
      appropriate,
      fair,
      mainReason,
      comment,
      durationSeconds
    } = req.body;

    const conditionNumber = Number(condition);
    const demandNumber = Number(demand);
    const finalGradeNumber = Number(finalGrade);
    const recalledDemandNumber = toOptionalInteger(recalledDemand);

    if (consent !== true) {
      return res.status(400).json({
        error: "Einwilligung fehlt."
      });
    }

    if (![1, 2, 3, 4].includes(conditionNumber)) {
      return res.status(400).json({
        error: "Ungültige Bedingung."
      });
    }

    const expectedDemandByCondition = {
      1: 9,
      2: 11,
      3: 13,
      4: 15
    };

    if (expectedDemandByCondition[conditionNumber] !== demandNumber) {
      return res.status(400).json({
        error: "Bedingung und Forderung stimmen nicht überein."
      });
    }

    if (
      !Number.isInteger(finalGradeNumber) ||
      finalGradeNumber < 0 ||
      finalGradeNumber > 15
    ) {
      return res.status(400).json({
        error: "Die finale Bewertung muss zwischen 0 und 15 liegen."
      });
    }

    const allowedRoles = [
      "student",
      "professor",
      "external",
      "none"
    ];

    if (!allowedRoles.includes(roleCheck)) {
      return res.status(400).json({
        error: "Ungültige Rollenangabe."
      });
    }

    if (
      recalledDemandNumber === null ||
      recalledDemandNumber < 0 ||
      recalledDemandNumber > 15
    ) {
      return res.status(400).json({
        error: "Die erinnerte Forderung muss zwischen 0 und 15 liegen."
      });
    }

    const likertValues = {
      pressure: Number(pressure),
      restrictedFreedom: Number(restrictedFreedom),
      manipulative: Number(manipulative),
      anger: Number(anger),
      appropriate: Number(appropriate),
      fair: Number(fair)
    };

    if (!Object.values(likertValues).every(isValidLikert)) {
      return res.status(400).json({
        error: "Alle Skalenwerte müssen zwischen 1 und 5 liegen."
      });
    }

    if (
      typeof mainReason !== "string" ||
      mainReason.trim() === ""
    ) {
      return res.status(400).json({
        error: "Bitte geben Sie den wichtigsten Beweggrund an."
      });
    }

    const result = await pool.query(
      `
        INSERT INTO responses (
          data_source,
          survey_version,
          consent,
          condition,
          demand,
          final_grade,
          role_check,
          recalled_demand,
          pressure,
          restricted_freedom,
          manipulative,
          anger,
          appropriate,
          fair,
          main_reason,
          comment,
          duration_seconds,
          user_agent
        )
        VALUES (
          'render',
          'render_v2',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16
        )
        RETURNING id, created_at;
      `,
      [
        true,
        conditionNumber,
        demandNumber,
        finalGradeNumber,
        roleCheck,
        recalledDemandNumber,
        likertValues.pressure,
        likertValues.restrictedFreedom,
        likertValues.manipulative,
        likertValues.anger,
        likertValues.appropriate,
        likertValues.fair,
        mainReason.trim(),
        typeof comment === "string" && comment.trim() !== ""
          ? comment.trim()
          : null,
        toOptionalInteger(durationSeconds),
        req.headers["user-agent"] || null
      ]
    );

    res.status(201).json({
      ok: true,
      id: result.rows[0].id,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error("Fehler beim Speichern:", error);

    res.status(500).json({
      error: "Serverfehler beim Speichern."
    });
  }
});

/**
 * Exportiert alle Antworten als CSV.
 *
 * Beispiel:
 * https://notenvergabe.onrender.com/admin/export?password=DEIN_PASSWORT
 */
app.get("/admin/export", async (req, res) => {
  try {
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(401).send("Nicht autorisiert.");
    }

    const result = await pool.query(`
      SELECT
        id,
        created_at,
        data_source,
        survey_version,
        source_case_id,
        consent,
        condition,
        demand,
        final_grade,
        role_check,
        recalled_demand,
        pressure,
        restricted_freedom,
        manipulative,
        anger,
        appropriate,
        fair,
        main_reason,
        comment,
        duration_seconds,
        user_agent,

        perceived_fairness,
        perceived_exaggeration,
        resistance,
        seriousness,
        age,
        gender,
        university_relation

      FROM responses
      ORDER BY created_at ASC, id ASC;
    `);

    const csv = stringify(result.rows, {
      header: true,
      delimiter: ";"
    });

    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=notenvergabe_responses.csv"
    );

    /*
     * BOM sorgt dafür, dass Excel deutsche Umlaute korrekt erkennt.
     */
    res.send("\uFEFF" + csv);
  } catch (error) {
    console.error("Export fehlgeschlagen:", error);

    res.status(500).send("Export fehlgeschlagen.");
  }
});

/**
 * Datenbank initialisieren und danach den Server starten.
 */
initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server läuft auf Port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(
      "Datenbank konnte nicht initialisiert werden:",
      error
    );

    process.exit(1);
  });
