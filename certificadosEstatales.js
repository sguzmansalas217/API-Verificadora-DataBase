// 🔹 Certificados estatales (prueba): el front recorta cada certificado del PDF escaneado y manda
// la imagen; aqui se leen los datos principales con la API de Claude y se guardan junto con la
// imagen. Solo para los correos de CERTIFICADOS_USUARIOS.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const MODELO = process.env.CERTIFICADOS_MODELO || "claude-haiku-5-5";
// USD por millon de tokens (entrada, salida). El costo de cada lectura se guarda en la base
// pero no se envia a la pantalla; se consulta con SQL.
const PRECIOS = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

const listaCorreos = (valor) => valor.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
// Administradores: suben sin tope y eliminan. Cualquier usuario con sesion puede buscar,
// ver y descargar (verificarApiKey ya exige la sesion).
const ADMINISTRADORES = listaCorreos(process.env.CERTIFICADOS_USUARIOS || "sguzmansalas217@gmail.com");

// Usuarios que pueden subir para probar, con un tope de certificados (no eliminan).
const SUBIDA_LIMITADA = listaCorreos(process.env.CERTIFICADOS_SUBIDA_LIMITADA || "robertomuniz1096@gmail.com");
const LIMITE_PRUEBA = Number(process.env.CERTIFICADOS_LIMITE_PRUEBA) || 200;

const correo = (req) => (req.user?.email || "").toLowerCase();
const esAdministrador = (req) => ADMINISTRADORES.includes(correo(req));
const tieneSubidaLimitada = (req) => !esAdministrador(req) && SUBIDA_LIMITADA.includes(correo(req));
const esLector = (req) => !!req.user;

const TIPOS_IMAGEN = ["image/webp", "image/jpeg", "image/png"];

const Certificado = z.object({
  certificado: z.string().describe("Folio grande junto a AG_UI"),
  certificado_repetido: z.string().describe("El mismo folio impreso a la derecha; vacio si no se ve"),
  placa: z.string(),
  nombre: z.string().describe("Nombre del propietario"),
  serie: z.string().describe("Numero de serie (VIN)"),
  marca: z.string(),
  fecha: z.string().describe("Formato YYYY-MM-DD"),
  centro: z.string().describe("Numero de centro de verificacion"),
});

const PROMPT = `Certificado de verificacion vehicular escaneado. Extrae los datos impresos en negro
(no las etiquetas del formato). Si un campo no se ve, deja "".`;

let cliente = null;
function clienteAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  cliente ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cliente;
}

export async function crearTablasCertificados(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS certificados_estatales (
      id                   SERIAL PRIMARY KEY,
      certificado          TEXT,
      certificado_repetido TEXT,
      placa                TEXT,
      nombre               TEXT,
      serie                TEXT,
      marca                TEXT,
      fecha                DATE,
      centro               TEXT,
      revisar              BOOLEAN NOT NULL DEFAULT false,
      motivo_revisar       TEXT,
      archivo_pdf          TEXT,
      pagina               INTEGER,
      modelo               TEXT,
      tokens_entrada       INTEGER,
      tokens_salida        INTEGER,
      costo_usd            NUMERIC(10, 6),
      usuarioactual        TEXT,
      created_at           TIMESTAMP NOT NULL DEFAULT now()
    );
    -- La imagen va en su propia tabla para que listar/buscar no cargue los bytes.
    CREATE TABLE IF NOT EXISTS certificados_estatales_imagen (
      certificado_id INTEGER PRIMARY KEY REFERENCES certificados_estatales(id) ON DELETE CASCADE,
      tipo           TEXT NOT NULL,
      bytes          INTEGER NOT NULL,
      imagen         BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_certificados_estatales_placa ON certificados_estatales (placa);
    CREATE INDEX IF NOT EXISTS idx_certificados_estatales_certificado ON certificados_estatales (certificado);
  `);
}

// Motivos para marcar un certificado para revision manual.
function motivosRevision(c) {
  const motivos = [];
  if (!c.certificado) motivos.push("sin certificado");
  else if (c.certificado_repetido && c.certificado_repetido !== c.certificado) motivos.push("folios no coinciden");
  if (!c.placa) motivos.push("sin placa");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.fecha)) motivos.push("fecha no legible");
  return motivos;
}

export function registrarRutasCertificados(app, { pool, verificarApiKey }) {
  const exigir = (permitido) => (req, res, next) =>
    permitido(req) ? next() : res.status(403).json({ error: "Sin acceso a certificados estatales" });
  const soloAdministradores = [verificarApiKey, exigir(esAdministrador)];
  const lectores = [verificarApiKey, exigir(esLector)];
  const quienesSuben = [verificarApiKey, exigir(req => esAdministrador(req) || tieneSubidaLimitada(req))];

  const certificadosSubidos = async (req) => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM certificados_estatales WHERE lower(usuarioactual) = $1`, [correo(req)]);
    return r.rows[0].n;
  };

  // Lo que puede hacer el usuario en la pantalla (la pantalla no decide sola).
  app.get("/certificados-estatales/permisos", ...lectores, async (req, res) => {
    try {
      const admin = esAdministrador(req);
      const limitado = tieneSubidaLimitada(req);
      res.json({
        puedeSubir: admin || limitado,
        puedeEliminar: admin,
        limite: limitado ? LIMITE_PRUEBA : null,
        usados: limitado ? await certificadosSubidos(req) : null,
      });
    } catch (error) {
      console.error("Error al obtener permisos de certificados:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Lee una imagen de certificado y la guarda. Body: { imagen (base64), tipo, archivo, pagina }
  app.post("/certificados-estatales", ...quienesSuben, async (req, res) => {
    const anthropic = clienteAnthropic();
    if (!anthropic) return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en el .env de la API" });

    if (tieneSubidaLimitada(req) && (await certificadosSubidos(req)) >= LIMITE_PRUEBA) {
      return res.status(403).json({ error: `Llegaste al límite de ${LIMITE_PRUEBA} certificados de prueba`, limiteAlcanzado: true });
    }

    const { imagen, tipo = "image/webp", archivo, pagina } = req.body;
    if (!imagen || !TIPOS_IMAGEN.includes(tipo)) {
      return res.status(400).json({ error: "Imagen requerida (webp, jpeg o png en base64)" });
    }

    let r;
    try {
      r = await anthropic.messages.parse({
        model: MODELO,
        max_tokens: 2000,
        output_config: { effort: "low", format: zodOutputFormat(Certificado) },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: tipo, data: imagen } },
            { type: "text", text: PROMPT },
          ],
        }],
      });
    } catch (error) {
      console.error("Error al leer certificado con la IA:", error);
      const status = error instanceof Anthropic.APIError ? 502 : 500;
      return res.status(status).json({ error: `No se pudo leer el certificado: ${error.message}` });
    }

    // Si la IA no regreso datos (rechazo o respuesta cortada), se guarda igual la imagen para revisar.
    const limpiar = v => (v ?? "").toString().trim().toUpperCase();
    const leido = r.parsed_output ?? {};
    const c = Object.fromEntries(Object.keys(Certificado.shape).map(k => [k, limpiar(leido[k])]));
    const motivos = r.parsed_output ? motivosRevision(c) : [`la IA no regreso datos (${r.stop_reason})`];
    const [pIn, pOut] = PRECIOS[MODELO] ?? [0, 0];
    const costo = (r.usage.input_tokens * pIn + r.usage.output_tokens * pOut) / 1e6;
    const buffer = Buffer.from(imagen, "base64");

    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const ins = await db.query(
        `INSERT INTO certificados_estatales
           (certificado, certificado_repetido, placa, nombre, serie, marca, fecha, centro,
            revisar, motivo_revisar, archivo_pdf, pagina, modelo, tokens_entrada, tokens_salida, costo_usd, usuarioactual)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id, certificado, certificado_repetido, placa, nombre, serie, marca,
                   to_char(fecha, 'YYYY-MM-DD') AS fecha, centro, revisar, motivo_revisar,
                   archivo_pdf, pagina, created_at`,
        [c.certificado, c.certificado_repetido, c.placa, c.nombre, c.serie, c.marca,
         /^\d{4}-\d{2}-\d{2}$/.test(c.fecha) ? c.fecha : null, c.centro,
         motivos.length > 0, motivos.join(", ") || null, archivo || null, pagina ?? null,
         MODELO, r.usage.input_tokens, r.usage.output_tokens, costo, req.user.email]
      );
      await db.query(
        `INSERT INTO certificados_estatales_imagen (certificado_id, tipo, bytes, imagen) VALUES ($1, $2, $3, $4)`,
        [ins.rows[0].id, tipo, buffer.length, buffer]
      );
      await db.query("COMMIT");
      res.json({ ...ins.rows[0], bytes: buffer.length });
    } catch (error) {
      await db.query("ROLLBACK");
      console.error("Error al guardar certificado estatal:", error);
      res.status(500).json({ error: error.message });
    } finally {
      db.release();
    }
  });

  // Lista / busca (?q= en placa, nombre, certificado o serie). No incluye la imagen.
  app.get("/certificados-estatales", ...lectores, async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      const result = await pool.query(
        `SELECT c.id, c.certificado, c.certificado_repetido, c.placa, c.nombre, c.serie, c.marca,
                to_char(c.fecha, 'YYYY-MM-DD') AS fecha, c.centro, c.revisar, c.motivo_revisar,
                c.archivo_pdf, c.pagina, c.usuarioactual, c.created_at, i.bytes, i.tipo
         FROM certificados_estatales c
         LEFT JOIN certificados_estatales_imagen i ON i.certificado_id = c.id
         WHERE $1 = '' OR c.placa ILIKE '%' || $1 || '%' OR c.nombre ILIKE '%' || $1 || '%'
            OR c.certificado ILIKE '%' || $1 || '%' OR c.serie ILIKE '%' || $1 || '%'
         ORDER BY c.id DESC
         LIMIT 500`,
        [q]
      );
      // Solo el administrador recibe los datos internos de la carga.
      const filas = esAdministrador(req)
        ? result.rows
        : result.rows.map(({ usuarioactual, archivo_pdf, pagina, ...resto }) => resto);
      res.json(filas);
    } catch (error) {
      console.error("Error al buscar certificados estatales:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/certificados-estatales/:id/imagen", ...lectores, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT tipo, imagen FROM certificados_estatales_imagen WHERE certificado_id = $1`,
        [req.params.id]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Imagen no encontrada" });
      res.set("Content-Type", r.rows[0].tipo);
      res.set("Cache-Control", "private, max-age=86400");
      res.send(r.rows[0].imagen);
    } catch (error) {
      console.error("Error al obtener imagen de certificado:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/certificados-estatales/:id", ...soloAdministradores, async (req, res) => {
    try {
      const r = await pool.query(`DELETE FROM certificados_estatales WHERE id = $1`, [req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Certificado no encontrado" });
      res.json({ mensaje: "Certificado eliminado" });
    } catch (error) {
      console.error("Error al eliminar certificado estatal:", error);
      res.status(500).json({ error: error.message });
    }
  });
}
