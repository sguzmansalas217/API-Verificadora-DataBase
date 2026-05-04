import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
const API_KEY = process.env.API_KEY || "mi_clave_secreta";

const verificarApiKey = (req, res, next) => {
  const key = req.headers["x-api-key"];

  if (!key || key !== API_KEY) {
    return res.status(403).json({ error: "No autorizado" });
  }

  next();
};

async function guardarConReglas(data) {
  console.log('datos -------------', data);
  const { placa, fecharegistro } = data;

  const fechaNueva = new Date(fecharegistro);
  const hoy = new Date();

  // 🔥 limpiar horas
  hoy.setHours(0, 0, 0, 0);
  fechaNueva.setHours(0, 0, 0, 0);


  // 🚫 VALIDAR FECHA FUTURA
  if (fechaNueva > hoy) {
    return "omitido_fecha_futura";
  }

  // 🔥 DIFERENCIA DE DÍAS
  const diffDias = (hoy - fechaNueva) / (1000 * 60 * 60 * 24);

  // 🚫 MÁS DE 7 DÍAS
  if (diffDias > 7) {
    return "omitido";
  }

  // 🔍 Buscar si existe
  const existe = await pool.query(
    `SELECT * FROM registros WHERE placa = $1 LIMIT 1`,
    [placa]
  );

  // 🟢 INSERT
  if (existe.rows.length === 0) {

    await insertTabla('registros', data);

    return "insertado";
  }

  // 🟡 UPDATE DINÁMICO (TODOS LOS CAMPOS)

  // ❌ columnas que NO quieres que se modifiquen
  const columnasExcluir = ['porhacer', 'referencia', 'referencia2'];

  // ✅ filtrar columnas
  const columnas = Object.keys(data).filter(col => !columnasExcluir.includes(col));
  const valores = columnas.map(col => data[col]);

  const setClause = columnas
    .map((col, i) => `${col} = $${i + 1}`)
    .join(", ");

  const query = `
    UPDATE registros 
    SET ${setClause}
    WHERE placa = $${columnas.length + 1}
  `;


  await pool.query(query, [...valores, placa]);

  return "actualizado";
}

// 🔹 Conexión a PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});


//////updata desde excel/////////////////////
app.post('/api/actualizacion-excel', verificarApiKey, async (req, res) => {
  try {
    
    const data = req.body;

    const {
      certificado,
      fecharegistro,
      placa
    } = data;
    console.log('data -------------', data);
    // 🔒 VALIDACIONES
    if (!certificado) {
      return res.status(400).json({ error: "Certificado requerido" });
    }

    if (!fecharegistro) {
      return res.status(400).json({ error: "Fecha registro requerida" });
    }

    if (!placa) {
      return res.status(400).json({ error: "Placa requerida" });
    }
    // 🔥 FORZAR SIEMPRE LINEA 1
    //data.linea = "Linea 1";

    const resultado = await guardarConReglas(data);

    return res.json({ resultado });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// 🔹 Test servidor
app.get("/", verificarApiKey, (req, res) => {
  res.send("Servidor funcionando");
});

// 🔹 Función genérica para obtener registros de cualquier tabla
async function getTabla(tabla, filters = {}) {
  
  let query = `SELECT * FROM ${tabla}`;
  const values = [];

  
  if (filters && Object.keys(filters).length > 0) {
    const where = Object.keys(filters).map((k, i) => {
      values.push(filters[k]);
      return `${k} = $${i + 1}`;
    }).join(" AND ");
    query += ` WHERE ${where}`;
    
  }
  const result = await pool.query(query, values);
  return result.rows;
}

// 🔹 Función genérica para insertar registro
async function insertTabla(tabla, data) {

  const columnas = Object.keys(data);
  const valores = Object.values(data);
  const placeholders = columnas.map((_, i) => `$${i + 1}`);
  const updates = columnas.map(col => `${col} = EXCLUDED.${col}`);

  let conflictColumn = '';

  if (tabla === 'registros') {
    conflictColumn = 'certificado';
  } else if (tabla === 'notas') {
    conflictColumn = 'certificado'; // 🔥 FIX IMPORTANTE
  } else if (tabla === 'porhacer') {
    conflictColumn = 'id';
  }

  // 🔥 SI NO HAY COLUMNA DE CONFLICTO → INSERT NORMAL
  if (!conflictColumn || data[conflictColumn] == null) {
    const query = `
      INSERT INTO ${tabla} (${columnas.join(",")})
      VALUES (${placeholders.join(",")})
      RETURNING *;
    `;

    const result = await pool.query(query, valores);
    return result.rows[0];
  }

  // 🔥 SI SÍ HAY → USA ON CONFLICT
  const query = `
    INSERT INTO ${tabla} (${columnas.join(",")})
    VALUES (${placeholders.join(",")})
    ON CONFLICT (${conflictColumn})
    DO UPDATE SET ${updates.join(",")}
    RETURNING *;
  `;

  const result = await pool.query(query, valores);
  return result.rows[0];
}
// 🔹 Endpoints por tabla
const tablas = ["registros", "notas", "porhacer"];

// GET → lee registros, opcionalmente con filtros
app.get("/api/:tabla", verificarApiKey, async (req, res) => {
  const { tabla } = req.params;
  const filters = req.query; // filtros opcionales vía query string

  if (!tablas.includes(tabla)) return res.status(400).json({ error: "Tabla no permitida" });

  try {
    const rows = await getTabla(tabla, filters);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST → inserta nuevo registro
app.post("/api/:tabla",verificarApiKey, async (req, res) => {
  const { tabla } = req.params;
  const data = req.body;

  if (!tablas.includes(tabla)) {
    return res.status(400).json({ error: "Tabla no permitida" });
  }

  try {
    let resultado;

    // 🔥 ESTE IF ES LA CLAVE
    if (tabla === 'registros') {
      resultado = await guardarConReglas(data);
    } else {
      resultado = await insertTabla(tabla, data);
    }

    res.json({ mensaje: "Proceso completo", resultado });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT → actualiza registro existente por id
app.put("/api/:tabla/:id", verificarApiKey, async (req, res) => {
  const { tabla, id } = req.params;
  const data = req.body;

  if (!tablas.includes(tabla)) return res.status(400).json({ error: "Tabla no permitida" });

  try {
    const row = await updateTabla(tabla, id, data);
    if (!row) return res.status(404).json({ error: "Registro no encontrado" });
    res.json({ mensaje: "Registro actualizado", registro: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function updateTabla(tabla, id, data) {
  const columnas = Object.keys(data);
  const valores = Object.values(data);

  if (columnas.length === 0) {
    throw new Error("No hay datos para actualizar");
  }

  const setClause = columnas
    .map((col, i) => `${col} = $${i + 1}`)
    .join(", ");

  const query = `
    UPDATE ${tabla}
    SET ${setClause}
    WHERE id = $${columnas.length + 1}
    RETURNING *;
  `;

  valores.push(id);

  const result = await pool.query(query, valores);
  return result.rows[0];
}

// 🔹 Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API corriendo en http://localhost:${PORT}`));