// Spec 028 (T4, rojo): rendimiento del resumen (R-16, CA-14). Armar el resumen de un usuario con 600 clientes y 30.000 mensajes tarda
// < 300 ms. Se toma el MÍNIMO de 7 corridas (más una de calentamiento que no cuenta; lección de 027, T24a): el mínimo mide el
// código y no el ruido de la máquina, y no se sube el tope para que pase. Va aparte de `resumen.spec.ts` (archivo
// `*.rendimiento.spec.ts`) para correrlo suelto 5 veces seguidas con la máquina cargada y dejarlo fuera de las configs de cobertura.
//
// Escena: un Dueño sin asignaciones con «todos los clientes» (los 600 entran), 50 mensajes por cliente (críticos, históricos,
// atendidos, nuevos y viejos), periodos de compras y ventas de `PERIODO` en los tres estados y una descarga completada para la
// mitad de los clientes por libro. Se siembra con SQL de volumen (superusuario, sin disparadores) y se corre `ANALYZE` como lo haría
// el autovacuum antes de medir. Si faltan las URLs de la BD, FALLA.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leerResumen } from "./index";
import {
  DESDE,
  PERIODO,
  abrirArnes,
  type Arnes,
  type Estudio,
} from "./soporte-prueba";

const CLIENTES = 600;
const POR_CLIENTE = 50;
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
       select $1, '5' || lpad(g::text, 10, '0'), 'Cliente volumen T4 ' || g from generate_series(1, $2::int) g`,
      [e.tenantId, CLIENTES],
    );
    await c.query(
      `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                  version_catalogo, avisado, historico, atendido_en, atendido_por, primera_captura_en, ultima_captura_en)
       select $1, c.id, 'V-' || n.j, 'Asunto T4', 'SUNAT', $3::timestamptz - (n.j::text || ' hours')::interval,
              case when n.j % 7 = 0 then 'coactiva' else 'otro' end, n.j % 7 = 0, case when n.j % 7 = 0 then 'codigo' else null end,
              1, false, n.j % 5 = 0,
              case when n.j % 3 = 0 then $3::timestamptz else null end, case when n.j % 3 = 0 then $2::uuid else null end,
              $3::timestamptz + ((n.j % 9 - 4) * 12 || ' hours')::interval, $3::timestamptz + ((n.j % 9 - 4) * 12 || ' hours')::interval
         from cliente c cross join generate_series(1, $4::int) as n(j)
        where c.tenant_id = $1`,
      [e.tenantId, e.dueno.id, DESDE, POR_CLIENTE],
    );
    // Periodos del mes evaluado: tercios abierto / revisado / generado por libro, con descarga completada para la mitad.
    await c.query(
      `insert into compra_periodo (tenant_id, cliente_id, periodo, estado)
       select tenant_id, id, $2, (array['abierto', 'revisado', 'generado'])[1 + (row_number() over (order by id) % 3)::int]
         from cliente where tenant_id = $1`,
      [e.tenantId, PERIODO],
    );
    await c.query(
      `insert into venta_periodo (tenant_id, cliente_id, periodo, estado)
       select tenant_id, id, $2, (array['generado', 'abierto', 'revisado'])[1 + (row_number() over (order by id) % 3)::int]
         from cliente where tenant_id = $1`,
      [e.tenantId, PERIODO],
    );
    await c.query(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
                                 max_intentos, intentos, iniciado_en, terminado_en)
       select c.tenant_id, c.id, c.ruc, 'sire.propuesta.descargar', 'sire', 'sire', 'interactivo', 'completado',
              jsonb_build_object('periodo', $2::text, 'libro', l.libro), sha256(convert_to(c.id::text || l.libro, 'UTF8')), $3::uuid,
              3, 1, now(), now()
         from cliente c cross join (values ('compras'), ('ventas')) as l(libro)
        where c.tenant_id = $1 and hashtext(c.id::text || l.libro) % 2 = 0`,
      [e.tenantId, PERIODO, e.dueno.id],
    );
    await c.query("analyze cliente");
    await c.query("analyze buzon_mensaje");
    await c.query("analyze job_registro");
    await c.query("analyze compra_periodo");
    await c.query("analyze venta_periodo");
  } finally {
    c.release(true);
  }
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("R-16: el resumen de un usuario con 600 clientes y 30.000 mensajes tarda < 300 ms", () => {
  it(`mínimo de ${CORRIDAS} corridas < ${TOPE_MS} ms (y el resultado no es vacío)`, async () => {
    const p = {
      usuarioId: e.dueno.id,
      desde: DESDE,
      periodo: PERIODO,
      todos: true,
    };
    const { rows } = await h.admin.query(
      "select (select count(*) from cliente where tenant_id = $1)::int as c, (select count(*) from buzon_mensaje where tenant_id = $1)::int as m",
      [e.tenantId],
    );
    expect(rows[0]).toEqual({ c: CLIENTES, m: CLIENTES * POR_CLIENTE });
    // Calentamiento: plan, caché y conexión.
    const calentamiento = await h.comoWorker(e, (tx) => leerResumen(tx, p));
    expect(calentamiento.length).toBeGreaterThan(CLIENTES / 2);
    expect(calentamiento.reduce((n, f) => n + f.nuevos, 0)).toBeGreaterThan(0);
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
    const minimo = Math.min(...tiempos);
    expect(
      minimo,
      `tiempos (ms): ${tiempos.map((t) => t.toFixed(1)).join(", ")}`,
    ).toBeLessThan(TOPE_MS);
  }, 120_000);
});
