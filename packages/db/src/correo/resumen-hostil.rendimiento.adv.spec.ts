// Spec 028 · T18 (ronda adversarial 2, adversario · opus): R-16 con datos hostiles. El tope de 300 ms del resumen se midió (T4) con 600
// clientes y 50 mensajes repartidos por cliente y un Dueño con «todos los clientes». Aquí el reparto es el peor: UN cliente con 30.000
// mensajes nuevos (no históricos, sin atender, uno de cada 7 crítico) y los otros 599 sin mensajes, y un Contador que llega a los 600
// por asignaciones (camino de `filtroAlcance`, no «todos»). Mínimo de 7 corridas tras una de calentamiento (lección de 027, T24a); va en
// un archivo `*.rendimiento*.spec.ts` para quedar fuera de las configs de cobertura. Solo pruebas: un fallo es un hallazgo H-028-2-n.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leerResumen } from "./index";
import { DESDE, PERIODO, abrirArnes, type Arnes, type Estudio } from "./soporte-prueba";

const CLIENTES = 600;
const MENSAJES = 30_000;
const CORRIDAS = 7;
const TOPE_MS = 300;

let h: Arnes;
let e: Estudio;

beforeAll(async () => {
  h = await abrirArnes();
  e = await h.nuevoEstudio();
  const c = await h.admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select $1, '6' || lpad(g::text, 10, '0'), 'Cliente hostil T18 ' || g from generate_series(1, $2::int) g`,
      [e.tenantId, CLIENTES],
    );
    await c.query(
      `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo)
       select tenant_id, id, $2, 'responsable' from cliente where tenant_id = $1`,
      [e.tenantId, e.contador.id],
    );
    // Todos los mensajes en el mismo cliente (el primero por razón social), todos nuevos respecto del corte.
    await c.query(
      `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                  version_catalogo, avisado, historico, atendido_en, atendido_por, primera_captura_en, ultima_captura_en)
       select $1, (select id from cliente where tenant_id = $1 order by razon_social limit 1), 'H-' || n.j, 'Asunto T18', 'SUNAT',
              $2::timestamptz - (n.j::text || ' minutes')::interval,
              case when n.j % 7 = 0 then 'coactiva' else 'otro' end, n.j % 7 = 0, case when n.j % 7 = 0 then 'codigo' else null end,
              1, false, false, null, null,
              $2::timestamptz + ((n.j % 600 + 1) || ' seconds')::interval, $2::timestamptz + ((n.j % 600 + 1) || ' seconds')::interval
         from generate_series(1, $3::int) as n(j)`,
      [e.tenantId, DESDE, MENSAJES],
    );
    await c.query(
      `insert into compra_periodo (tenant_id, cliente_id, periodo, estado)
       select tenant_id, id, $2, 'abierto' from cliente where tenant_id = $1`,
      [e.tenantId, PERIODO],
    );
    await c.query("analyze cliente");
    await c.query("analyze asignacion");
    await c.query("analyze buzon_mensaje");
    await c.query("analyze compra_periodo");
    await c.query("analyze venta_periodo");
    await c.query("analyze job_registro");
  } finally {
    c.release(true);
  }
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("R-16 con datos hostiles: un cliente con 30.000 mensajes nuevos, Contador con 600 asignaciones", () => {
  it(`mínimo de ${CORRIDAS} corridas < ${TOPE_MS} ms y el conteo del cliente es exacto`, async () => {
    const p = { usuarioId: e.contador.id, desde: DESDE, periodo: PERIODO, todos: false };
    const calentamiento = await h.comoWorker(e, (tx) => leerResumen(tx, p));
    expect(calentamiento.length).toBe(CLIENTES);
    expect(Math.max(...calentamiento.map((f) => f.nuevos))).toBe(MENSAJES);
    const tiempos: number[] = [];
    for (let i = 0; i < CORRIDAS; i++) {
      tiempos.push(
        await h.comoWorker(e, async (tx) => {
          const t0 = performance.now();
          await leerResumen(tx, p);
          return performance.now() - t0;
        }),
      );
    }
    expect(Math.min(...tiempos), `tiempos (ms): ${tiempos.map((t) => t.toFixed(1)).join(", ")}`).toBeLessThan(TOPE_MS);
  }, 180_000);
});
