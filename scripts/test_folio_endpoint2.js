import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const BASE = "http://localhost:3000";
const API_KEY = process.env.API_KEY;

async function call(nombreCaso, body) {
  const res = await fetch(`${BASE}/registrofederal-folio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`\n--- ${nombreCaso} ---`);
  console.log("status:", res.status);
  console.log("columna resultante -> fisico:", data.registro?.fisico, "emisiones1:", data.registro?.emisiones1, "emisiones2:", data.registro?.emisiones2);
  return { status: res.status, data };
}

async function main() {
  await call("Emisiones periodo1 en fresco (19RC8N, fecha marzo)", {
    folio: "30001", placa: "19RC8N", nombre: "TURISMO AUTOCLASS", fecha: "2026-03-01"
  });

  await call("Emisiones periodo2 en fresco (96RD8J, fecha octubre)", {
    folio: "30002", placa: "96RD8J", nombre: "TURISMO AUTOCLASS", fecha: "2026-10-01"
  });

  await call("Fisico Arrastre en fresco (526WL8, folio A555)", {
    folio: "A555", placa: "526WL8", nombre: "SERVICIO DE CARGA ESTRELLA BLANCA", fecha: "2026-01-01"
  });
}

main().catch(err => {
  console.error("ERROR:", err.message);
  process.exitCode = 1;
});
