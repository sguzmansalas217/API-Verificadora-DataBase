import express from "express";
import cors from "cors";
import compression from "compression";
import pkg from "pg";
import dotenv from "dotenv";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

dotenv.config();
const { Pool } = pkg;

// 🔒 Sin API_KEY en el .env no arranca (antes caía a una clave conocida)
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("❌ Falta API_KEY en el .env, el servidor no arranca");
  process.exit(1);
}

// 🔒 Firebase solo para verificar el token del usuario logueado (no requiere credenciales)
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || "verificadora-2909f" });
const firebaseAuth = getAuth();

// 🔒 CORS: si CORS_ORIGINS viene en el .env (separado por comas), solo esos origenes pueden llamar la API
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(compression());
app.use(express.json());

// 🔒 Pide la API key Y el token de Firebase del usuario logueado
const verificarApiKey = async (req, res, next) => {
  const key = req.headers["x-api-key"];

  if (!key || key !== API_KEY) {
    return res.status(403).json({ error: "No autorizado" });
  }

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Sesión requerida" });
  }

  try {
    req.user = await firebaseAuth.verifyIdToken(token);
  } catch {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }

  next();
};

// 🔒 Solo se aceptan nombres de columna que existan de verdad en la tabla
// (evita que manden SQL disfrazado de nombre de columna)
const IDENTIFICADOR_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;
const columnasPorTabla = {};

async function cargarColumnas() {
  const r = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  for (const k of Object.keys(columnasPorTabla)) delete columnasPorTabla[k];
  for (const { table_name, column_name } of r.rows) {
    (columnasPorTabla[table_name] ??= new Set()).add(column_name.toLowerCase());
  }
}

async function validarColumnas(tabla, columnas) {
  const esValida = (c) => IDENTIFICADOR_VALIDO.test(c) && columnasPorTabla[tabla]?.has(c.toLowerCase());

  if (!columnas.every(esValida)) {
    // puede que se haya agregado una columna nueva: recargar una vez antes de rechazar
    await cargarColumnas();
  }

  const invalidas = columnas.filter(c => !esValida(c));
  if (invalidas.length > 0) {
    const err = new Error(`Columnas no permitidas: ${invalidas.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

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
  if (diffDias > 25) {
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
  await validarColumnas('registros', columnas);
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
  const { fecha_desde, fecha_hasta, ...igualdad } = filters || {};

  let query = `SELECT * FROM ${tabla}`;
  const values = [];
  const condiciones = [];

  await validarColumnas(tabla, Object.keys(igualdad));

  Object.keys(igualdad).forEach((k) => {
    values.push(igualdad[k]);
    condiciones.push(`${k} = $${values.length}`);
  });

  if (fecha_desde) {
    values.push(fecha_desde);
    condiciones.push(`fecharegistro >= $${values.length}`);
  }
  if (fecha_hasta) {
    values.push(fecha_hasta);
    condiciones.push(`fecharegistro <= $${values.length}`);
  }

  if (condiciones.length > 0) {
    query += ` WHERE ${condiciones.join(" AND ")}`;
  }

  const result = await pool.query(query, values);
  return result.rows;
}

// 🔹 Función genérica para insertar registro
async function insertTabla(tabla, data) {

  const columnas = Object.keys(data);
  await validarColumnas(tabla, columnas);
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

app.get("/api/registros/nota-actual", verificarApiKey, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH notas_limpias AS (
        SELECT DISTINCT
          nota,
          CAST(regexp_replace(nota::text, '[^0-9]', '', 'g') AS INTEGER) AS numero
        FROM registros
        WHERE nota IS NOT NULL
          AND nota::text ~ '[0-9]+'
      )
      SELECT nl.nota, nl.numero
      FROM notas_limpias nl
      WHERE EXISTS (SELECT 1 FROM notas_limpias n WHERE n.numero = nl.numero - 1)
        AND EXISTS (SELECT 1 FROM notas_limpias n WHERE n.numero = nl.numero - 2)
        AND EXISTS (SELECT 1 FROM notas_limpias n WHERE n.numero = nl.numero - 3)
        AND EXISTS (SELECT 1 FROM notas_limpias n WHERE n.numero = nl.numero - 4)
        AND EXISTS (SELECT 1 FROM notas_limpias n WHERE n.numero = nl.numero - 5)
      ORDER BY nl.numero DESC
      LIMIT 1;
    `);

    res.json({
      notaActual: result.rows[0]?.nota || "SIN NOTA",
      valida: !!result.rows[0],
      faltantes: []
    });

  } catch (error) {
    console.error("Error obteniendo nota actual:", error);
    res.status(500).json({ error: error.message });
  }
});

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
    res.status(err.status || 500).json({ error: err.message });
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
    res.status(err.status || 500).json({ error: err.message });
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
    res.status(err.status || 500).json({ error: err.message });
  }
});

async function updateTabla(tabla, id, data) {
  const columnas = Object.keys(data);
  const valores = Object.values(data);

  if (columnas.length === 0) {
    throw new Error("No hay datos para actualizar");
  }

  await validarColumnas(tabla, columnas);

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

// 🔹 Obtener todos los registros federales
app.get("/registrofederal", verificarApiKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM registrofederal ORDER BY fecharegistro DESC;`);
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener registros federales:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Actualizar registro federal por id
app.put("/registrofederal/:id", verificarApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const data = { ...req.body };
    delete data.id;

    const columnas = Object.keys(data);
    const valores  = Object.values(data);

    if (columnas.length === 0) {
      return res.status(400).json({ error: "No hay datos para actualizar" });
    }

    await validarColumnas('registrofederal', columnas);

    const setClause = columnas.map((col, i) => `${col} = $${i + 1}`).join(", ");
    const result = await pool.query(
      `UPDATE registrofederal SET ${setClause} WHERE id = $${columnas.length + 1} RETURNING *;`,
      [...valores, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Registro no encontrado" });
    }

    res.json({ mensaje: "Registro federal actualizado", registro: result.rows[0] });
  } catch (error) {
    console.error("Error al actualizar registro federal:", error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// 🔹 Guardar registro federal
app.post("/registrofederal-guardar", verificarApiKey, async (req, res) => {
  try {
    const {
      Parque,
      Placa,
      NoSerie,
      Marca,
      Tipo,
      Ejes,
      Modelo,
      Propietario,
      Combustible,
      Fisico,
      Emisiones1,
      Emisiones2,
      UsuarioActual
    } = req.body;

    if (!Parque || !Placa || !NoSerie || !Marca || !Tipo || !Ejes || !Modelo || !Propietario || !Combustible) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const result = await pool.query(
      `INSERT INTO registrofederal (parque, placa, noserie, marca, tipo, ejes, modelo, propietario, combustible, fisico, emisiones1, emisiones2, usuarioactual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *;`,
      [Parque, Placa, NoSerie, Marca, Tipo, Ejes, Modelo, Propietario, Combustible, Fisico || null, Emisiones1 || null, Emisiones2 || null, UsuarioActual || "UsuarioNodeJS"]
    );

    res.json({ mensaje: "Registro federal guardado correctamente", registro: result.rows[0] });

  } catch (error) {
    console.error("Error al guardar registro federal:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Registrar folio federal (Emisiones o Físico) contra el catálogo de parques vehiculares
app.post("/registrofederal-folio", verificarApiKey, async (req, res) => {
  try {
    const { folio, placa, nombre, fecha, registrofederal_id, confirmarSobrescritura, usuarioactual } = req.body;

    if (!folio || !placa || !nombre || !fecha) {
      return res.status(400).json({ error: "Folio, Placa, Nombre y Fecha son obligatorios" });
    }

    const placaNorm = placa.trim().toUpperCase();
    const nombreNorm = nombre.trim().toUpperCase().replace(/\s+/g, " ");
    const folioNorm = folio.replace(/\s+/g, "").toUpperCase();

    let vehiculo;

    if (registrofederal_id) {
      const r = await pool.query(`SELECT * FROM registrofederal WHERE id = $1`, [registrofederal_id]);
      if (r.rows.length === 0) {
        return res.status(404).json({ error: "El vehículo indicado no existe" });
      }
      if (r.rows[0].placa.trim().toUpperCase() !== placaNorm) {
        return res.status(400).json({ error: "El id indicado no corresponde a la placa proporcionada" });
      }
      vehiculo = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT * FROM registrofederal WHERE upper(btrim(placa)) = $1`,
        [placaNorm]
      );

      if (r.rows.length === 0) {
        return res.status(404).json({ error: "Placa no encontrada en el catálogo de parques vehiculares" });
      }

      if (r.rows.length > 1) {
        return res.status(409).json({
          error: "Placa ambigua, se encontró más de un vehículo",
          candidatos: r.rows.map(v => ({
            id: v.id,
            parque: v.parque,
            marca: v.marca,
            tipo: v.tipo,
            propietario: v.propietario
          }))
        });
      }

      vehiculo = r.rows[0];
    }

    let tipo, columna, periodo = null;

    if (/^[MA]\d+$/.test(folioNorm)) {
      tipo = "fisico";
      columna = "fisico";
    } else if (/^\d+$/.test(folioNorm)) {
      tipo = "emisiones";
      const mes = new Date(fecha).getUTCMonth() + 1;
      if (mes >= 1 && mes <= 6) {
        columna = "emisiones1";
        periodo = 1;
      } else {
        columna = "emisiones2";
        periodo = 2;
      }
    } else {
      return res.status(400).json({ error: "Formato de folio no reconocido" });
    }

    const folioAnterior = vehiculo[columna];

    if (folioAnterior && !confirmarSobrescritura) {
      return res.status(409).json({
        requiereConfirmacion: true,
        folioAnterior,
        mensaje: `Ya existe un folio (${folioAnterior}) registrado en ${columna}. ¿Deseas sobrescribirlo?`
      });
    }

    const actualizado = await pool.query(
      `UPDATE registrofederal SET ${columna} = $1, nombre = $2 WHERE id = $3 RETURNING *;`,
      [folioNorm, nombreNorm, vehiculo.id]
    );

    await pool.query(
      `INSERT INTO registrofederal_folios
        (registrofederal_id, folio, tipo, periodo, folio_anterior, nombre, fecha, placa, parque, usuarioactual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [vehiculo.id, folioNorm, tipo, periodo, folioAnterior || null, nombre, fecha, placaNorm, vehiculo.parque, usuarioactual || "UsuarioNodeJS"]
    );

    res.json({
      mensaje: "Folio registrado correctamente",
      sobrescrito: !!folioAnterior,
      folioAnterior: folioAnterior || null,
      registro: actualizado.rows[0]
    });

  } catch (error) {
    console.error("Error al registrar folio federal:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Crear Orden de Trabajo y asignarle folio (atomico, persistente, nunca se repite ni se reinicia)
// tipoOrden: 'federal' (folio F######) o 'estatal' (folio E######), contador independiente por tipo.
const TIPOS_ORDEN_VALIDOS = ["federal", "estatal"];
const SECUENCIA_POR_TIPO = {
  federal: "orden_trabajo_folio_federal_seq",
  estatal: "orden_trabajo_folio_estatal_seq",
};
const PREFIJO_POR_TIPO = { federal: "F", estatal: "E" };

app.post("/orden-trabajo/folio", verificarApiKey, async (req, res) => {
  try {
    const {
      tipoOrden, parque, cliente, telefono, fecha, facturaOR, razonSocial, rfc,
      calleNumero, colonia, estadoMunicipio, mail,
      certFisico, certEmisiones1, certEmisiones2,
      total, vehiculos, usuarioactual
    } = req.body;

    const tipo = TIPOS_ORDEN_VALIDOS.includes(tipoOrden) ? tipoOrden : "federal";
    const secuencia = SECUENCIA_POR_TIPO[tipo];

    const numeroResult = await pool.query(`SELECT nextval('${secuencia}') AS numero;`);
    const numero = numeroResult.rows[0].numero;

    const result = await pool.query(
      `INSERT INTO orden_trabajo_folios
        (tipo, numero, parque, cliente, telefono, fecha, factura_or, razon_social, rfc,
         calle_numero, colonia, estado_municipio, mail,
         cert_fisico, cert_emisiones1, cert_emisiones2,
         total, vehiculos, usuarioactual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *;`,
      [
        tipo, numero, parque || null, cliente || null, telefono || null, fecha || null,
        facturaOR || null, razonSocial || null, rfc || null,
        calleNumero || null, colonia || null, estadoMunicipio || null, mail || null,
        !!certFisico, !!certEmisiones1, !!certEmisiones2,
        total ?? null, JSON.stringify(vehiculos || []), usuarioactual || "UsuarioNodeJS"
      ]
    );

    const orden = result.rows[0];
    const folio = PREFIJO_POR_TIPO[tipo] + String(orden.numero).padStart(6, "0");

    res.json({ numero: orden.numero, folio, orden });
  } catch (error) {
    console.error("Error al asignar folio de orden de trabajo:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Listar Órdenes de Trabajo ya generadas (para consultarlas / reimprimirlas)
app.get("/orden-trabajo", verificarApiKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM orden_trabajo_folios ORDER BY numero DESC;`);
    res.json(result.rows);
  } catch (error) {
    console.error("Error al listar órdenes de trabajo:", error);
    res.status(500).json({ error: error.message });
  }
});

// Columnas de cada vehiculo que se pueden editar desde una orden y propagar a su tabla de origen.
// Nunca se usan nombres de columna que vengan del request: solo los de esta whitelist.
const COLUMNAS_EDITABLES_VEHICULO = {
  federal: ["fisico", "emisiones1", "emisiones2"],
  estatal: ["nota", "certificado", "multa", "costo", "referencia", "nombrecliente"],
};
const TABLA_ORIGEN_POR_TIPO = { federal: "registrofederal", estatal: "registros" };
const COLUMNAS_NUMERICAS_VEHICULO = ["multa", "costo", "certificado"];

// Busca un vehiculo por placa en su tabla de origen. Devuelve { vehiculo } o { error, status }.
async function buscarVehiculoOrden(db, tipo, placa, parque) {
  if (tipo === "federal") {
    const r = await db.query(
      `SELECT id, placa, parque, fisico, emisiones1, emisiones2
         FROM registrofederal WHERE upper(btrim(placa)) = upper(btrim($1)) ORDER BY id DESC;`,
      [placa]
    );
    if (r.rows.length === 0) return { status: 404, error: "Placa no encontrada en Datos Federales" };
    if (parque) {
      const mismoParque = r.rows.find(v => v.parque === parque);
      if (!mismoParque) return { status: 409, error: `La placa pertenece a otro parque (${r.rows[0].parque})` };
      return { vehiculo: mismoParque };
    }
    return { vehiculo: r.rows[0] };
  }

  const r = await db.query(
    `SELECT id, placa, nota, certificado, multa, costo, referencia, nombrecliente
       FROM registros WHERE upper(btrim(placa)) = upper(btrim($1))
      ORDER BY (porhacer = 'SI') DESC, fecharegistro DESC, id DESC LIMIT 1;`,
    [placa]
  );
  if (r.rows.length === 0) return { status: 404, error: "Placa no encontrada en registros estatales" };
  return { vehiculo: r.rows[0] };
}

// 🔹 Buscar un vehiculo por placa para agregarlo a una orden existente
app.get("/orden-trabajo/buscar-vehiculo", verificarApiKey, async (req, res) => {
  try {
    const { tipo, placa, parque } = req.query;
    if (!TIPOS_ORDEN_VALIDOS.includes(tipo)) return res.status(400).json({ error: "Tipo de orden no valido" });
    if (!placa || !placa.trim()) return res.status(400).json({ error: "Falta la placa" });

    const resultado = await buscarVehiculoOrden(pool, tipo, placa, parque || null);
    if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
    res.json(resultado.vehiculo);
  } catch (error) {
    console.error("Error al buscar vehiculo para orden:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Editar una Orden de Trabajo existente (mismo folio) y propagar cambios de vehiculos a su tabla de origen
app.put("/orden-trabajo/:tipo/:numero", verificarApiKey, async (req, res) => {
  const { tipo, numero } = req.params;
  if (!TIPOS_ORDEN_VALIDOS.includes(tipo)) return res.status(400).json({ error: "Tipo de orden no valido" });

  const {
    cliente, telefono, fecha, facturaOR, razonSocial, rfc,
    calleNumero, colonia, estadoMunicipio, mail,
    certFisico, certEmisiones1, certEmisiones2,
    total, vehiculos, cambiosVehiculos
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ordenResult = await client.query(
      `UPDATE orden_trabajo_folios SET
         cliente = $3, telefono = $4, fecha = $5, factura_or = $6, razon_social = $7, rfc = $8,
         calle_numero = $9, colonia = $10, estado_municipio = $11, mail = $12,
         cert_fisico = $13, cert_emisiones1 = $14, cert_emisiones2 = $15,
         total = $16, vehiculos = $17
       WHERE tipo = $1 AND numero = $2
       RETURNING *;`,
      [
        tipo, numero, cliente || null, telefono || null, fecha || null, facturaOR || null,
        razonSocial || null, rfc || null, calleNumero || null, colonia || null,
        estadoMunicipio || null, mail || null,
        !!certFisico, !!certEmisiones1, !!certEmisiones2,
        total ?? null, JSON.stringify(vehiculos || [])
      ]
    );

    if (ordenResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const orden = ordenResult.rows[0];
    const tablaOrigen = TABLA_ORIGEN_POR_TIPO[tipo];
    const columnasPermitidas = COLUMNAS_EDITABLES_VEHICULO[tipo];
    const noActualizados = [];

    for (const item of cambiosVehiculos || []) {
      const cambios = item?.cambios || {};
      const columnas = Object.keys(cambios).filter(c => columnasPermitidas.includes(c));
      if (columnas.length === 0) continue;

      let idVehiculo = item.id;
      if (!idVehiculo) {
        const encontrado = await buscarVehiculoOrden(client, tipo, item.placa || "", tipo === "federal" ? orden.parque : null);
        idVehiculo = encontrado.vehiculo?.id;
      }
      if (!idVehiculo) {
        noActualizados.push(item.placa);
        continue;
      }

      const valores = columnas.map(c => {
        const v = cambios[c];
        if (COLUMNAS_NUMERICAS_VEHICULO.includes(c) && (v === "" || v === undefined)) return null;
        return typeof v === "string" ? v.trim() : v;
      });
      const setClause = columnas.map((c, i) => `${c} = $${i + 1}`).join(", ");

      const upd = await client.query(
        `UPDATE ${tablaOrigen} SET ${setClause} WHERE id = $${columnas.length + 1};`,
        [...valores, idVehiculo]
      );
      if (upd.rowCount === 0) noActualizados.push(item.placa);
    }

    await client.query("COMMIT");
    res.json({ orden, noActualizados });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error al editar orden de trabajo:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// 🔹 Servidor
const PORT = process.env.PORT || 3000;
cargarColumnas()
  .catch(err => console.error("⚠️ No se pudieron cargar las columnas al arrancar (se reintenta en la primera peticion):", err.message))
  .finally(() => app.listen(PORT, () => console.log(`✅ API corriendo en http://localhost:${PORT}`)));