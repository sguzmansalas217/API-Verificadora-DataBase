import XLSX from "xlsx";
import pkg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { Pool } = pkg;

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const FORCE = args.includes("--force");
const fileArg = args.find(a => !a.startsWith("--"));
const EXCEL_PATH = fileArg || "C:/Users/uic10017/Downloads/Parques Vehiculares 2026.xlsx";

function normalizar(valor) {
  if (valor === null || valor === undefined) return "";
  return valor
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
}

function detectarFilaEncabezado(filas) {
  for (let i = 0; i <= Math.min(4, filas.length - 1); i++) {
    const fila = filas[i] || [];
    if (fila.some(celda => normalizar(celda).includes("PLACA"))) {
      return i;
    }
  }
  return -1;
}

function mapearColumnas(encabezados) {
  const norm = encabezados.map(normalizar);
  const mapa = {};
  const noDetectado = [];

  const buscar = (pred) => norm.findIndex(pred);

  mapa.noEco = buscar(h => h.includes("ECO") || /^NO\.?\s*ECO/.test(h));
  mapa.placa = buscar(h => h.includes("PLACA"));
  mapa.noserie = buscar(h => h.includes("SERIE"));
  mapa.marca = buscar(h => h === "MARCA") !== -1 ? buscar(h => h === "MARCA") : buscar(h => h.includes("MARCA") && !h.includes("SUBMARCA"));
  mapa.tipo = buscar(h => h.includes("TIPO"));
  mapa.ejes = buscar(h => h.includes("EJE"));
  mapa.modelo = buscar(h => h.includes("MODELO") || h.includes("ANO") || h.includes("AÑO"));
  mapa.propietario = buscar(h => h.includes("PROPIETARIO") || h.includes("NOMBRE"));
  mapa.combustible = buscar(h => h.includes("COMBU"));
  mapa.fisico = buscar(h => h.includes("FISIC"));

  const candidatosEmisiones = [];
  norm.forEach((h, idx) => {
    if (
      h.includes("EMISION") ||
      h.includes("ISONES") || // cubre typos como "EMIEISONES"
      /E\.?C\.?\s*\d/.test(h) ||
      (h.includes("PERIODO") && /[12]/.test(h))
    ) {
      candidatosEmisiones.push(idx);
    }
  });

  mapa.emisiones1 = -1;
  mapa.emisiones2 = -1;
  let ordenAsumido = false;

  const marcador1 = candidatosEmisiones.find(idx => /1(RO|ER|RA)?\b|^1\b/.test(norm[idx]) || norm[idx].includes("1"));
  const marcador2 = candidatosEmisiones.find(idx => /2(DO|DA)?\b/.test(norm[idx]) || norm[idx].includes("2"));

  if (marcador1 !== undefined) mapa.emisiones1 = marcador1;
  if (marcador2 !== undefined) mapa.emisiones2 = marcador2;

  if (mapa.emisiones1 === -1 && mapa.emisiones2 === -1 && candidatosEmisiones.length === 2) {
    mapa.emisiones1 = candidatosEmisiones[0];
    mapa.emisiones2 = candidatosEmisiones[1];
    ordenAsumido = true;
  }

  for (const campo of ["placa", "noserie", "marca", "tipo", "ejes", "modelo", "propietario", "combustible", "fisico", "emisiones1", "emisiones2"]) {
    if (mapa[campo] === -1 || mapa[campo] === undefined) noDetectado.push(campo);
  }

  return { mapa, noDetectado, ordenAsumido };
}

function celda(fila, idx) {
  if (idx === undefined || idx === -1 || idx === null) return null;
  const v = fila[idx];
  if (v === undefined || v === null) return null;
  const s = v.toString().trim();
  return s === "" ? null : s;
}

function celdaEntero(fila, idx) {
  const s = celda(fila, idx);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function procesarWorkbook(workbook) {
  const reporte = [];
  const filasParaInsertar = [];

  for (const nombreHoja of workbook.SheetNames) {
    const hoja = workbook.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "", raw: false });

    const filaEncabezadoIdx = detectarFilaEncabezado(filas);

    if (filaEncabezadoIdx === -1) {
      reporte.push({ hoja: nombreHoja, omitida: true, motivo: "No se detectó columna Placa en las primeras filas" });
      continue;
    }

    const encabezados = filas[filaEncabezadoIdx];
    const { mapa, noDetectado, ordenAsumido } = mapearColumnas(encabezados);

    let leidas = 0;
    let descartadasPorPlacaVacia = 0;
    const filasHoja = [];

    for (let i = filaEncabezadoIdx + 1; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.every(c => normalizar(c) === "")) continue;

      const placa = celda(fila, mapa.placa);
      if (!placa) {
        descartadasPorPlacaVacia++;
        continue;
      }

      leidas++;
      filasHoja.push({
        parque: nombreHoja.trim(),
        placa,
        noserie: celda(fila, mapa.noserie),
        marca: celda(fila, mapa.marca),
        tipo: celda(fila, mapa.tipo),
        ejes: celdaEntero(fila, mapa.ejes),
        modelo: celdaEntero(fila, mapa.modelo),
        propietario: celda(fila, mapa.propietario),
        combustible: celda(fila, mapa.combustible),
        fisico: celda(fila, mapa.fisico)?.toUpperCase() || null,
        emisiones1: celda(fila, mapa.emisiones1)?.toUpperCase() || null,
        emisiones2: celda(fila, mapa.emisiones2)?.toUpperCase() || null,
      });
    }

    filasParaInsertar.push(...filasHoja);

    reporte.push({
      hoja: nombreHoja,
      omitida: false,
      filaEncabezadoUsada: filaEncabezadoIdx,
      columnasNoDetectadas: noDetectado,
      ordenEmisionesAsumido: ordenAsumido,
      filasLeidas: leidas,
      filasDescartadasPorPlacaVacia: descartadasPorPlacaVacia,
    });
  }

  return { reporte, filasParaInsertar };
}

function imprimirReporte(reporte, filasParaInsertar) {
  console.log(`\n=== Reporte de importación: ${EXCEL_PATH} ===\n`);

  for (const r of reporte) {
    if (r.omitida) {
      console.log(`⛔ ${r.hoja}: OMITIDA — ${r.motivo}`);
      continue;
    }
    const advertencias = [];
    if (r.columnasNoDetectadas.length > 0) advertencias.push(`columnas no detectadas: ${r.columnasNoDetectadas.join(", ")}`);
    if (r.ordenEmisionesAsumido) advertencias.push("orden de emisiones 1/2 asumido por posición, verificar manualmente");

    console.log(
      `✅ ${r.hoja}: fila encabezado=${r.filaEncabezadoUsada}, filas leídas=${r.filasLeidas}, descartadas por placa vacía=${r.filasDescartadasPorPlacaVacia}` +
      (advertencias.length ? `  ⚠️  ${advertencias.join(" | ")}` : "")
    );
  }

  const hojasOmitidas = reporte.filter(r => r.omitida).length;
  const hojasOk = reporte.length - hojasOmitidas;

  console.log(`\nTotales: ${reporte.length} hojas, ${hojasOk} procesadas, ${hojasOmitidas} omitidas, ${filasParaInsertar.length} filas listas para insertar.\n`);
}

async function commitABaseDeDatos(filasParaInsertar) {
  const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
  });

  const client = await pool.connect();
  try {
    const existentes = await client.query(`SELECT count(*)::int AS n FROM registrofederal WHERE parque IS NOT NULL`);
    if (existentes.rows[0].n > 0 && !FORCE) {
      console.error(`ERROR: ya existen ${existentes.rows[0].n} filas con parque asignado. Usa --force si de verdad quieres insertar de nuevo.`);
      process.exitCode = 1;
      return;
    }

    await client.query("BEGIN");

    for (const fila of filasParaInsertar) {
      await client.query(
        `INSERT INTO registrofederal
          (parque, placa, noserie, marca, tipo, ejes, modelo, propietario, combustible, fisico, emisiones1, emisiones2, usuarioactual)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          fila.parque, fila.placa, fila.noserie, fila.marca, fila.tipo, fila.ejes, fila.modelo,
          fila.propietario, fila.combustible, fila.fisico, fila.emisiones1, fila.emisiones2, "ImportExcel"
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`OK: se insertaron ${filasParaInsertar.length} vehículos en registrofederal.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERROR durante el commit, se revirtió todo:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  console.log(`Leyendo: ${EXCEL_PATH}`);
  const workbook = XLSX.readFile(EXCEL_PATH);
  const { reporte, filasParaInsertar } = procesarWorkbook(workbook);

  imprimirReporte(reporte, filasParaInsertar);

  if (!COMMIT) {
    console.log("Modo dry-run (no se escribió nada en la base de datos). Usa --commit para insertar.");
    return;
  }

  await commitABaseDeDatos(filasParaInsertar);
}

main().catch(err => {
  console.error("ERROR:", err.message);
  process.exitCode = 1;
});
