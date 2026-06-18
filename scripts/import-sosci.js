const fs = require("fs");
const { Pool } = require("pg");
const { parse } = require("csv-parse/sync");

const DATABASE_URL = process.env.DATABASE_URL;
const csvPath = process.argv[2];

if (!DATABASE_URL) {
  console.error("Fehler: DATABASE_URL ist nicht gesetzt.");
  process.exit(1);
}

if (!csvPath) {
  console.error(
    "Fehler: Es wurde keine SoSci-Datei angegeben.\n" +
    "Beispiel: npm run import:sosci -- data/sosci-notenvergabe.csv"
  );
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`Fehler: Die Datei wurde nicht gefunden: ${csvPath}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

const treatmentMap = {
  1: 9,
  2: 11,
  3: 13,
  4: 15
};

const roleMap = {
  1: "student",
  2: "professor",
  3: "external",
  4: "none"
};

function toInteger(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .replace(",", ".");

  const parsed = Number(normalized);

  return Number.isInteger(parsed) ? parsed : null;
}

function toDate(value) {
  if (!value || String(value).trim() === "") {
    return new Date();
  }

  const parsed = new Date(String(value).trim());

  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

async function ensureDatabaseStructure() {
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
      user_agent TEXT
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
   * Verhindert, dass derselbe SoSci-Fall mehrfach importiert wird.
   * PostgreSQL erlaubt weiterhin mehrere NULL-Werte für neue Render-Fälle.
   */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS responses_source_case_unique
    ON responses (data_source, source_case_id);
  `);
}

async function importSoSciData() {
  await ensureDatabaseStructure();

  /*
   * Der SoSci-Export liegt als UTF-16-Datei vor und verwendet
   * Tabulatoren als Spaltentrenner.
   */
  const fileBuffer = fs.readFileSync(csvPath);
  const fileText = fileBuffer.toString("utf16le");

  const rows = parse(fileText, {
    columns: true,
    delimiter: "\t",
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true
  });

  let imported = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const row of rows) {
    const sourceCaseId =
      row.CASE !== undefined && row.CASE !== null
        ? String(row.CASE).trim()
        : null;

    const consent = toInteger(row.NV01);
    const condition = toInteger(row.NV02);
    const finalGrade = toInteger(row.NV08);
    const finished = toInteger(row.FINISHED);
    const viewer = toInteger(row.Q_VIEWER);

    const demand = treatmentMap[condition];

    /*
     * Importiert werden:
     * - Einwilligung gegeben
     * - Befragung abgeschlossen
     * - kein Fragebogen-Vorschaumodus
     * - gültiges Treatment
     * - gültige finale Bewertung
     */
    const validCase =
      sourceCaseId !== null &&
      consent === 1 &&
      finished === 1 &&
      viewer === 0 &&
      [1, 2, 3, 4].includes(condition) &&
      [9, 11, 13, 15].includes(demand) &&
      finalGrade !== null &&
      finalGrade >= 0 &&
      finalGrade <= 15;

    if (!validCase) {
      invalid += 1;
      continue;
    }

    const roleCode = toInteger(row.NV09);
    const roleCheck = roleMap[roleCode] || null;

    const recalledDemand = toInteger(row.NV12_01);

    const pressure = toInteger(row.NV11_01);
    const restrictedFreedom = toInteger(row.NV11_02);
    const manipulative = toInteger(row.NV11_03);
    const anger = toInteger(row.NV11_04);
    const appropriate = toInteger(row.NV11_05);
    const fair = toInteger(row.NV11_06);

    const durationSeconds = toInteger(row.TIME_SUM);
    const createdAt = toDate(row.STARTED);

    const result = await pool.query(
      `
        INSERT INTO responses (
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
          user_agent
        )
        VALUES (
          $1,
          'sosci_import',
          'sosci_nv_2026',
          $2,

          TRUE,
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

          NULL,
          NULL,

          $14,
          'SoSci Survey import'
        )
        ON CONFLICT DO NOTHING
        RETURNING id;
      `,
      [
        createdAt,
        sourceCaseId,

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

        durationSeconds
      ]
    );

    if (result.rowCount === 1) {
      imported += 1;
    } else {
      duplicates += 1;
    }
  }

  console.log("------------------------------------");
  console.log("SoSci-Import abgeschlossen");
  console.log("------------------------------------");
  console.log(`Zeilen in der SoSci-Datei: ${rows.length}`);
  console.log(`Neu importiert: ${imported}`);
  console.log(`Bereits vorhanden: ${duplicates}`);
  console.log(`Ungültig oder unvollständig: ${invalid}`);
  console.log("------------------------------------");
}

importSoSciData()
  .catch((error) => {
    console.error("Der SoSci-Import ist fehlgeschlagen:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
