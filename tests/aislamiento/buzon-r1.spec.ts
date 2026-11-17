// Spec 023 · T17 (rojo) · H-023-1-5 (baja): el INSERT del worker en las tablas del buzón queda acotado por columnas (0054, D-3, D-5).
// El worker no puede fijar `ultima_programada_en` ni `ultima_solicitud_en` al crear el estado (las fija solo el programador por
// `encolar_buzon_programados` y el backend), ni insertar un mensaje con `contenido_ruta` ya puesto (se saltaría la auditoría
// `buzon.contenido_obtenido` y el contenido se fija una sola vez). Cada caso acepta una de dos salidas: 42501, o la fila queda con el
// valor por defecto (NULL). Lo legítimo del worker (captura, estado y mensaje nuevo) sigue funcionando. Todo con rollback.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirAdmin,
  comoAdmin,
  comoRol,
  EscenarioBuzon,
  probar,
  rutaBuzon,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let X: string;
let c1: ClientePrueba;
let c2: ClientePrueba;
let c3: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(4);
  eb = new EscenarioBuzon(admin);
  X = (await eb.estudio()).id;
  c1 = await eb.et.cliente(X);
  c2 = await eb.et.cliente(X);
  c3 = await eb.et.cliente(X);
});
afterAll(async () => {
  await eb?.limpiar();
  await admin?.end();
});

const comoWorker = <T>(fn: Parameters<typeof comoRol<T>>[3]) =>
  comoRol(admin, "contapp_worker", X, fn);

describe("H-023-1-5 · estado de captura: el worker no fija las franjas del programador ni del backend", () => {
  it("insertar con ultima_programada_en y ultima_solicitud_en da 42501, o la fila queda con ambas en NULL", async () => {
    const r = await comoWorker(async (c) => {
      const intento = await probar(
        c,
        `insert into buzon_estado_cliente (tenant_id, cliente_id, ultima_programada_en, ultima_solicitud_en)
         values ($1, $2, 'infinity', 'infinity')`,
        [X, c1.id],
      );
      const fila = intento.ok
        ? (
            await c.query(
              "select ultima_programada_en, ultima_solicitud_en from buzon_estado_cliente where cliente_id = $1",
              [c1.id],
            )
          ).rows[0]
        : null;
      return { intento, fila };
    });
    if (r.intento.ok)
      expect(r.fila, "la fila insertada").toEqual({
        ultima_programada_en: null,
        ultima_solicitud_en: null,
      });
    else expect(r.intento.code).toBe("42501");
  });

  it("el estado que sí escribe el worker (última captura, sincronizado, cursor pendiente) se inserta y se actualiza con ON CONFLICT", async () => {
    const r = await comoWorker(async (c) => {
      const sql = `insert into buzon_estado_cliente (cliente_id, ultima_captura_en, cursor_pendiente, sincronizado_en)
        values ($1::uuid, now(), $2::text, case when $3::boolean then now() end)
        on conflict (tenant_id, cliente_id) do update
           set ultima_captura_en = excluded.ultima_captura_en, cursor_pendiente = excluded.cursor_pendiente,
               sincronizado_en = coalesce(buzon_estado_cliente.sincronizado_en, excluded.sincronizado_en)`;
      const crea = await probar(c, sql, [c2.id, "c1", false]);
      const actualiza = await probar(c, sql, [c2.id, null, true]);
      return { crea, actualiza };
    });
    expect(r.crea).toMatchObject({ ok: true, rowCount: 1 });
    expect(r.actualiza).toMatchObject({ ok: true, rowCount: 1 });
  });
});

describe("H-023-1-5 · mensaje: el worker no inserta el contenido ya fijado", () => {
  const insertarConContenido = `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico,
      version_catalogo, contenido_ruta, contenido_bytes, contenido_obtenido_en)
    values ($1, $2, 'W-1', 'Boletín', 'SUNAT', now() - interval '40 days', 'otro', false, 1, $3, 10, now())`;

  it("insertar con contenido_ruta da 42501, o el contenido queda sin fijar y sin auditoría buzon.contenido_obtenido", async () => {
    const r = await comoWorker(async (c) => {
      const intento = await probar(c, insertarConContenido, [
        X,
        c3.id,
        rutaBuzon(X, c3.id, "txt"),
      ]);
      if (!intento.ok) return { intento, fila: null, auditoria: 0 };
      const fila = (
        await c.query(
          "select contenido_ruta, contenido_bytes, contenido_obtenido_en from buzon_mensaje where cliente_id = $1 and id_sunat = 'W-1'",
          [c3.id],
        )
      ).rows[0];
      const auditoria = await comoAdmin(c, "contapp_worker", async () =>
        Number(
          (
            await c.query(
              "select count(*)::int as n from auditoria where tenant_id = $1 and accion = 'buzon.contenido_obtenido'",
              [X],
            )
          ).rows[0].n,
        ),
      );
      return { intento, fila, auditoria };
    });
    if (r.intento.ok) {
      expect(r.fila, "la fila insertada").toEqual({
        contenido_ruta: null,
        contenido_bytes: null,
        contenido_obtenido_en: null,
      });
      expect(r.auditoria, "auditoría de contenido").toBe(0);
    } else expect(r.intento.code).toBe("42501");
  });

  it("el mensaje nuevo que sí captura el worker (sin contenido) se inserta", async () => {
    const r = await comoWorker((c) =>
      probar(
        c,
        `insert into buzon_mensaje (cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico, motivo_critico,
           version_catalogo, avisado, leido_sunat, adjuntos_declarados)
         values ($1::uuid, 'W-2', 'Boletín', 'SUNAT', now() - interval '40 days', null, 'otro', false, null, 1, false, false, 0)
         on conflict (tenant_id, cliente_id, id_sunat) do nothing returning id`,
        [c3.id],
      ),
    );
    expect(r).toMatchObject({ ok: true, rowCount: 1 });
  });
});
