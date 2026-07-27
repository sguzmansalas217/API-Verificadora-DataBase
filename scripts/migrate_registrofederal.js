import pkg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { Pool } = pkg;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

const ddl = `
DROP TABLE IF EXISTS registrofederal_folios;
DROP TABLE IF EXISTS registrofederal;

CREATE TABLE registrofederal (
  id            SERIAL PRIMARY KEY,
  fecharegistro DATE NOT NULL DEFAULT CURRENT_DATE,
  parque        TEXT NOT NULL,
  placa         TEXT NOT NULL,
  noserie       TEXT,
  marca         TEXT,
  tipo          TEXT,
  ejes          INTEGER,
  modelo        INTEGER,
  propietario   TEXT,
  combustible   TEXT,
  fisico        TEXT,
  emisiones1    TEXT,
  emisiones2    TEXT,
  usuarioactual TEXT
);

CREATE INDEX idx_registrofederal_placa_norm ON registrofederal (upper(btrim(placa)));
CREATE INDEX idx_registrofederal_parque ON registrofederal (parque);

CREATE TABLE registrofederal_folios (
  id                 SERIAL PRIMARY KEY,
  registrofederal_id INTEGER REFERENCES registrofederal(id) ON DELETE SET NULL,
  folio              TEXT NOT NULL,
  tipo               TEXT NOT NULL CHECK (tipo IN ('emisiones', 'fisico')),
  periodo            SMALLINT CHECK (periodo IN (1, 2)),
  folio_anterior     TEXT,
  nombre             TEXT,
  fecha              DATE,
  placa              TEXT,
  parque             TEXT,
  usuarioactual      TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_registrofederal_folios_registrofederal_id ON registrofederal_folios (registrofederal_id);
CREATE INDEX idx_registrofederal_folios_placa ON registrofederal_folios (placa);
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(ddl);
    await client.query("COMMIT");
    console.log("OK: registrofederal y registrofederal_folios recreadas correctamente.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERROR en la migración:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
