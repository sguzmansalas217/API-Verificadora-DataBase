// Cuenta cuantos registros tiene un correo en la base (solo lectura), revisando todas las
// columnas de texto cuyo nombre contiene "usuario":
//   docker exec api-db-verificadora node scripts/registros_usuario.js correo@x.com [otro@x.com ...]
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function main() {
  const correos = process.argv.slice(2).map(c => c.trim().toLowerCase()).filter(Boolean);
  if (!correos.length) throw new Error("Uso: node scripts/registros_usuario.js correo@x.com");
  const columnas = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name ILIKE '%usuario%'
       AND data_type IN ('text', 'character varying')
     ORDER BY table_name, column_name`
  );
  for (const correo of correos) {
    console.log(`\n${correo}`);
    let total = 0;
    for (const { table_name, column_name } of columnas.rows) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM "${table_name}" WHERE lower(trim("${column_name}")) = $1`, [correo]);
      if (r.rows[0].n) console.log(`  ${table_name}.${column_name}: ${r.rows[0].n}`);
      total += r.rows[0].n;
    }
    console.log(`  Total: ${total}`);
  }
}

main()
  .catch(error => { console.error("❌", error.message); process.exitCode = 1; })
  .finally(() => pool.end());
