// 🔹 Certificados federales (prueba): el front manda cada pagina completa del PDF escaneado (sin
// recortar ni enderezar) y aqui la IA lee los datos principales. Los PDFs vienen separados por tipo:
//   fisico    -> dictamen fisico-mecanico (folio M-...) o de arrastre (folio A-...), 1 por hoja
//   emisiones -> dictamen de emisiones, puede haber 2 por hoja (dos renglones, misma imagen)
//   tarjeta   -> tarjeta de circulacion; se liga al fisico de la misma serie o placa al listar
// La imagen se guarda una vez por pagina. Permisos y modelo iguales que en estatales.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  MODELO, PRECIOS, LIMITE_PRUEBA, TIPOS_IMAGEN, correo, esAdministrador, tieneSubidaLimitada, esLector, clienteAnthropic,
} from "./certificadosEstatales.js";

const CLASES = ["fisico", "emisiones", "tarjeta"];

const Dictamen = (folio) => z.object({
  certificado: z.string().describe(folio),
  placa: z.string(),
  nombre: z.string().describe("Nombre o razon social del propietario"),
  serie: z.string().describe("Numero de serie / NIV"),
  marca: z.string(),
  fecha: z.string().describe("Fecha de verificacion, formato YYYY-MM-DD"),
  tarjeta: z.string().describe("Folio o numero de la tarjeta de circulacion; vacio si no aparece"),
});

const Tarjeta = z.object({
  folio: z.string().describe("Folio impreso de la tarjeta, el que esta debajo del codigo de barras (ej. 1054779). No uses numeros escritos a mano"),
  economico: z.string().describe("Numero economico de la unidad: el numero grande escrito a mano con marcador en la mitad vacia de la tarjeta, junto al codigo de barras (ej. 306). No es el numero de la calle del domicilio. Vacio si no hay"),
  placa: z.string(),
  nombre: z.string().describe("Nombre o razon social"),
  serie: z.string().describe("NIV / numero de serie"),
  marca: z.string(),
  fecha: z.string().describe("Fecha de expedicion, formato YYYY-MM-DD"),
});

const LECTURA = {
  fisico: {
    esquema: Dictamen("Folio del dictamen arriba a la derecha, ej. M-6183032 o A-..."),
    documento: "dictamen de verificacion fisico-mecanica",
  },
  emisiones: {
    esquema: Dictamen("No. del dictamen arriba a la derecha, ej. 22047502"),
    documento: "dictamen de verificacion de emisiones (puede haber 2 por hoja)",
  },
  tarjeta: {
    esquema: Tarjeta,
    documento: "tarjeta de circulacion federal (puede venir girada)",
  },
};

const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f);
const limpiar = (v) => (v ?? "").toString().trim().toUpperCase();
const sinEspacios = (v) => limpiar(v).replace(/\s+/g, "");

export async function crearTablasCertificadosFederales(pool) {
  await pool.query(`
    -- Una imagen por pagina del PDF; los documentos leidos de esa pagina la referencian.
    CREATE TABLE IF NOT EXISTS certificados_federales_pagina (
      id             SERIAL PRIMARY KEY,
      clase          TEXT NOT NULL,
      tipo           TEXT NOT NULL,
      bytes          INTEGER NOT NULL,
      imagen         BYTEA NOT NULL,
      archivo_pdf    TEXT,
      pagina         INTEGER,
      modelo         TEXT,
      tokens_entrada INTEGER,
      tokens_salida  INTEGER,
      costo_usd      NUMERIC(10, 6),
      usuarioactual  TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS certificados_federales (
      id             SERIAL PRIMARY KEY,
      clase          TEXT NOT NULL,
      certificado    TEXT,
      placa          TEXT,
      nombre         TEXT,
      serie          TEXT,
      marca          TEXT,
      fecha          DATE,
      tarjeta        TEXT,
      revisar        BOOLEAN NOT NULL DEFAULT false,
      motivo_revisar TEXT,
      pagina_id      INTEGER NOT NULL REFERENCES certificados_federales_pagina(id) ON DELETE CASCADE,
      usuarioactual  TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tarjetas_circulacion_federal (
      id             SERIAL PRIMARY KEY,
      folio          TEXT,
      placa          TEXT,
      nombre         TEXT,
      serie          TEXT,
      marca          TEXT,
      fecha          DATE,
      revisar        BOOLEAN NOT NULL DEFAULT false,
      motivo_revisar TEXT,
      pagina_id      INTEGER NOT NULL REFERENCES certificados_federales_pagina(id) ON DELETE CASCADE,
      usuarioactual  TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT now()
    );
    ALTER TABLE tarjetas_circulacion_federal ADD COLUMN IF NOT EXISTS economico TEXT;
    CREATE INDEX IF NOT EXISTS idx_certificados_federales_placa ON certificados_federales (placa);
    CREATE INDEX IF NOT EXISTS idx_certificados_federales_serie ON certificados_federales (serie);
    CREATE INDEX IF NOT EXISTS idx_certificados_federales_certificado ON certificados_federales (certificado);
    CREATE INDEX IF NOT EXISTS idx_tarjetas_federal_placa ON tarjetas_circulacion_federal (placa);
    CREATE INDEX IF NOT EXISTS idx_tarjetas_federal_serie ON tarjetas_circulacion_federal (serie);
  `);
}

function motivosRevision(d, clase) {
  const motivos = [];
  if (!(clase === "tarjeta" ? d.folio : d.certificado)) motivos.push(clase === "tarjeta" ? "sin folio" : "sin certificado");
  if (!d.placa) motivos.push("sin placa");
  if (!d.serie) motivos.push("sin serie");
  if (!fechaValida(d.fecha)) motivos.push("fecha no legible");
  return motivos;
}

// Los de arrastre (folio A-...) no llevan tarjeta de circulacion.
const llevaTarjeta = (c) => c.clase === "fisico" && !(c.certificado || "").startsWith("A");

export function registrarRutasCertificadosFederales(app, { pool, verificarApiKey }) {
  const exigir = (permitido) => (req, res, next) =>
    permitido(req) ? next() : res.status(403).json({ error: "Sin acceso a certificados federales" });
  const soloAdministradores = [verificarApiKey, exigir(esAdministrador)];
  const lectores = [verificarApiKey, exigir(esLector)];
  const quienesSuben = [verificarApiKey, exigir(req => esAdministrador(req) || tieneSubidaLimitada(req))];

  const paginasSubidas = async (req) => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM certificados_federales_pagina WHERE lower(usuarioactual) = $1`, [correo(req)]);
    return r.rows[0].n;
  };

  app.get("/certificados-federales/permisos", ...lectores, async (req, res) => {
    try {
      const admin = esAdministrador(req);
      const limitado = tieneSubidaLimitada(req);
      res.json({
        puedeSubir: admin || limitado,
        puedeEliminar: admin,
        limite: limitado ? LIMITE_PRUEBA : null,
        usados: limitado ? await paginasSubidas(req) : null,
      });
    } catch (error) {
      console.error("Error al obtener permisos de certificados federales:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Lee una pagina y guarda sus documentos. Body: { clase, imagen (base64), tipo, archivo, pagina }
  app.post("/certificados-federales", ...quienesSuben, async (req, res) => {
    const anthropic = clienteAnthropic();
    if (!anthropic) return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en el .env de la API" });

    if (tieneSubidaLimitada(req) && (await paginasSubidas(req)) >= LIMITE_PRUEBA) {
      return res.status(403).json({ error: `Llegaste al límite de ${LIMITE_PRUEBA} páginas de prueba`, limiteAlcanzado: true });
    }

    const { clase, imagen, tipo = "image/webp", archivo, pagina } = req.body;
    if (!CLASES.includes(clase)) return res.status(400).json({ error: "Tipo de documento no válido" });
    if (!imagen || !TIPOS_IMAGEN.includes(tipo)) {
      return res.status(400).json({ error: "Imagen requerida (webp, jpeg o png en base64)" });
    }

    const { esquema, documento } = LECTURA[clase];
    let r;
    try {
      r = await anthropic.messages.parse({
        model: MODELO,
        max_tokens: 2000,
        output_config: { effort: "low", format: zodOutputFormat(z.object({ documentos: z.array(esquema) })) },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: tipo, data: imagen } },
            { type: "text", text: `Hoja escaneada con ${documento}. Extrae los datos impresos de cada documento de la hoja (no las etiquetas del formato). Si un campo no se ve, deja "".` },
          ],
        }],
      });
    } catch (error) {
      console.error("Error al leer pagina federal con la IA:", error);
      const status = error instanceof Anthropic.APIError ? 502 : 500;
      return res.status(status).json({ error: `No se pudo leer la página: ${error.message}` });
    }

    // Folios, placas y series sin espacios ("M - 6183032" -> "M-6183032").
    const normalizar = (d) => Object.fromEntries(Object.keys(esquema.shape).map(k =>
      [k, ["nombre", "marca"].includes(k) ? limpiar(d[k]) : sinEspacios(d[k])]));
    let documentos = (r.parsed_output?.documentos ?? []).map(normalizar);
    // Si la IA no regreso nada se guarda un renglon vacio para que la pagina no se pierda.
    const sinDatos = documentos.length === 0;
    if (sinDatos) documentos = [normalizar({})];

    const [pIn, pOut] = PRECIOS[MODELO] ?? [0, 0];
    const costo = (r.usage.input_tokens * pIn + r.usage.output_tokens * pOut) / 1e6;
    const buffer = Buffer.from(imagen, "base64");

    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const pag = await db.query(
        `INSERT INTO certificados_federales_pagina
           (clase, tipo, bytes, imagen, archivo_pdf, pagina, modelo, tokens_entrada, tokens_salida, costo_usd, usuarioactual)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [clase, tipo, buffer.length, buffer, archivo || null, pagina ?? null,
         MODELO, r.usage.input_tokens, r.usage.output_tokens, costo, req.user.email]
      );
      const paginaId = pag.rows[0].id;
      const guardados = [];
      for (const d of documentos) {
        const motivos = sinDatos ? [`no se encontró ningún documento (${r.stop_reason})`] : motivosRevision(d, clase);
        const fecha = fechaValida(d.fecha) ? d.fecha : null;
        const ins = clase === "tarjeta"
          ? await db.query(
              `INSERT INTO tarjetas_circulacion_federal
                 (folio, economico, placa, nombre, serie, marca, fecha, revisar, motivo_revisar, pagina_id, usuarioactual)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING id, folio, economico, placa, nombre, serie, marca, revisar, motivo_revisar`,
              [d.folio, d.economico, d.placa, d.nombre, d.serie, d.marca, fecha, motivos.length > 0, motivos.join(", ") || null, paginaId, req.user.email])
          : await db.query(
              `INSERT INTO certificados_federales
                 (clase, certificado, placa, nombre, serie, marca, fecha, tarjeta, revisar, motivo_revisar, pagina_id, usuarioactual)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               RETURNING id, certificado, placa, nombre, serie, marca, tarjeta, revisar, motivo_revisar`,
              [clase, d.certificado, d.placa, d.nombre, d.serie, d.marca, fecha, d.tarjeta,
               motivos.length > 0, motivos.join(", ") || null, paginaId, req.user.email]);
        guardados.push(ins.rows[0]);
      }
      await db.query("COMMIT");
      res.json({ paginaId, bytes: buffer.length, documentos: guardados });
    } catch (error) {
      await db.query("ROLLBACK");
      console.error("Error al guardar pagina federal:", error);
      res.status(500).json({ error: error.message });
    } finally {
      db.release();
    }
  });

  const texto = (req, k) => (req.query[k] || "").toString().trim();
  const fecha = (req, k) => (fechaValida(texto(req, k)) ? texto(req, k) : "");
  // Solo el administrador recibe los datos internos de la carga.
  const ocultarInternos = (req, filas) => (esAdministrador(req)
    ? filas
    : filas.map(({ usuarioactual, archivo_pdf, pagina, ...resto }) => resto));

  // Certificados (fisico, arrastre, emisiones). A los fisicos se les liga la tarjeta mas reciente
  // con la misma serie (o placa, si la serie no se leyo igual).
  app.get("/certificados-federales", ...lectores, async (req, res) => {
    try {
      const tipo = texto(req, "tipo");
      const result = await pool.query(
        `SELECT c.id, c.clase, c.certificado, c.placa, c.nombre, c.serie, c.marca,
                to_char(c.fecha, 'YYYY-MM-DD') AS fecha, c.tarjeta, c.revisar, c.motivo_revisar,
                c.pagina_id, p.tipo, p.bytes, p.archivo_pdf, p.pagina, c.usuarioactual, c.created_at,
                t.id AS tarjeta_id, t.folio AS tarjeta_folio, t.economico, t.pagina_id AS tarjeta_pagina_id
         FROM certificados_federales c
         JOIN certificados_federales_pagina p ON p.id = c.pagina_id
         LEFT JOIN LATERAL (
           SELECT t.id, t.folio, t.economico, t.pagina_id
           FROM tarjetas_circulacion_federal t
           WHERE c.clase = 'fisico'
             AND ((c.serie <> '' AND t.serie = c.serie) OR (c.placa <> '' AND t.placa = c.placa))
           ORDER BY (t.serie = c.serie) DESC, t.id DESC
           LIMIT 1
         ) t ON true
         WHERE ($1 = '' OR ($1 = 'emisiones' AND c.clase = 'emisiones')
                OR ($1 = 'arrastre' AND c.clase = 'fisico' AND c.certificado LIKE 'A%')
                OR ($1 = 'fisico' AND c.clase = 'fisico' AND c.certificado NOT LIKE 'A%'))
           AND ($2 = '' OR c.certificado ILIKE '%' || $2 || '%')
           AND ($3 = '' OR c.placa ILIKE '%' || $3 || '%')
           AND ($4 = '' OR c.nombre ILIKE '%' || $4 || '%')
           AND ($5 = '' OR c.fecha >= NULLIF($5, '')::date)
           AND ($6 = '' OR c.fecha <= NULLIF($6, '')::date)
           AND ($7 = '' OR t.economico ILIKE '%' || $7 || '%')
         ORDER BY c.id DESC
         LIMIT 500`,
        [tipo, texto(req, "certificado"), texto(req, "placa"), texto(req, "nombre"), fecha(req, "desde"), fecha(req, "hasta"), texto(req, "economico")]
      );
      // Lo de la tarjeta se revisa al listar porque la tarjeta puede subirse despues del dictamen.
      const filas = result.rows.map(c => {
        const motivos = c.motivo_revisar ? [c.motivo_revisar] : [];
        if (llevaTarjeta(c)) {
          if (!c.tarjeta_id) motivos.push("sin tarjeta");
          else if (c.tarjeta && c.tarjeta_folio && c.tarjeta !== c.tarjeta_folio) motivos.push("folio de tarjeta no coincide");
        } else {
          c.tarjeta_id = c.tarjeta_folio = c.tarjeta_pagina_id = c.economico = null;
        }
        return { ...c, revisar: motivos.length > 0, motivo_revisar: motivos.join(", ") || null };
      });
      res.json(ocultarInternos(req, filas));
    } catch (error) {
      console.error("Error al buscar certificados federales:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/tarjetas-federales", ...lectores, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT t.id, t.folio, t.economico, t.placa, t.nombre, t.serie, t.marca, to_char(t.fecha, 'YYYY-MM-DD') AS fecha,
                t.revisar, t.motivo_revisar, t.pagina_id, p.tipo, p.bytes, p.archivo_pdf, p.pagina,
                t.usuarioactual, t.created_at
         FROM tarjetas_circulacion_federal t
         JOIN certificados_federales_pagina p ON p.id = t.pagina_id
         WHERE ($1 = '' OR t.folio ILIKE '%' || $1 || '%')
           AND ($2 = '' OR t.placa ILIKE '%' || $2 || '%')
           AND ($3 = '' OR t.nombre ILIKE '%' || $3 || '%')
           AND ($4 = '' OR t.fecha >= NULLIF($4, '')::date)
           AND ($5 = '' OR t.fecha <= NULLIF($5, '')::date)
         ORDER BY t.id DESC
         LIMIT 500`,
        [texto(req, "certificado"), texto(req, "placa"), texto(req, "nombre"), fecha(req, "desde"), fecha(req, "hasta")]
      );
      res.json(ocultarInternos(req, result.rows));
    } catch (error) {
      console.error("Error al buscar tarjetas federales:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/certificados-federales/pagina/:id/imagen", ...lectores, async (req, res) => {
    try {
      const r = await pool.query(`SELECT tipo, imagen FROM certificados_federales_pagina WHERE id = $1`, [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "Imagen no encontrada" });
      res.set("Content-Type", r.rows[0].tipo);
      res.set("Cache-Control", "private, max-age=86400");
      res.send(r.rows[0].imagen);
    } catch (error) {
      console.error("Error al obtener imagen federal:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Borra el renglon y la imagen de la pagina si ya ningun documento la usa
  // (en emisiones dos certificados comparten la misma hoja).
  const eliminar = (tabla) => async (req, res) => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const r = await db.query(`DELETE FROM ${tabla} WHERE id = $1 RETURNING pagina_id`, [req.params.id]);
      if (r.rowCount === 0) {
        await db.query("ROLLBACK");
        return res.status(404).json({ error: "No encontrado" });
      }
      await db.query(
        `DELETE FROM certificados_federales_pagina p WHERE p.id = $1
           AND NOT EXISTS (SELECT 1 FROM certificados_federales WHERE pagina_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM tarjetas_circulacion_federal WHERE pagina_id = p.id)`,
        [r.rows[0].pagina_id]
      );
      await db.query("COMMIT");
      res.json({ mensaje: "Eliminado" });
    } catch (error) {
      await db.query("ROLLBACK");
      console.error(`Error al eliminar de ${tabla}:`, error);
      res.status(500).json({ error: error.message });
    } finally {
      db.release();
    }
  };
  app.delete("/certificados-federales/:id", ...soloAdministradores, eliminar("certificados_federales"));
  app.delete("/tarjetas-federales/:id", ...soloAdministradores, eliminar("tarjetas_circulacion_federal"));
}
