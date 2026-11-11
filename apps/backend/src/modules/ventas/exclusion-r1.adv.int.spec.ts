/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b · T17 ronda adversarial 1 (adversario). Excluir ventas: permisos con el estado del periodo (P-9) en la ventana
// entre «revisar» y una escritura en curso, y el largo del motivo (D12). Solo pruebas; nada de producción.
//  - H-012b-1 (caja blanca): `estadoParaEscribir` (ventas/apoyo.ts) no crea la fila de `venta_periodo` ni la toma
//    `FOR SHARE` si falta o está `abierto` sin marca; «revisar» no toma el advisory del libro. Una exclusión de alguien sin
//    `sire.aprobar_generar` que ya leyó «abierto» se confirma DESPUÉS de que el periodo quedó `revisado` (P-9 dice 403).
//  - ADV-012b-a (caja negra): el motivo es de 1 a 200 caracteres (D12; la BD cuenta puntos de código con char_length).
import { createDb, type ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, descuadrada, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, boletas290y292 } from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let admin: ContappDb;

beforeAll(async () => {
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
  admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
});
afterAll(async () => {
  await admin?.close();
  await A?.cerrar();
  await v?.cerrar();
});

const MOTIVO = "Llegó descuadrada del SIRE";
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conDescuadrada(): Promise<{ c: { id: string; ruc: string }; ventaId: string }> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
  const ids = await v.sembrarVentas(E.tenantId, c.id, [...boletas290y292(), descuadrada("D001", 1)], { usuarioId: E.titular.id });
  return { c, ventaId: ids[2]! };
}

/** Espera a que una sesión de la app esté bloqueada en un INSERT a venta_exclusion (la exclusión ya pasó el control de estado). */
async function esperarBloqueada(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await A.sql(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%insert into venta_exclusion%'`,
    );
    if (r[0].n > 0) return;
    await dormir(50);
  }
  throw new Error("la exclusión nunca llegó a esperar en el INSERT");
}

describe("H-012b-1 · P-9: una exclusión sin sire.aprobar_generar no se confirma después de `revisado`", () => {
  it.each([
    ["sin fila de venta_periodo", false],
    ["con venta_periodo `abierto` sin marca (la que crea la descarga del worker)", true],
  ] as const)(
    "%s: o «revisar» espera a la exclusión en curso, o la exclusión recibe 403 periodo_revisado",
    async (_caso, conFila) => {
      const { c, ventaId } = await conDescuadrada();
      if (conFila) await A.estadoVentas(E.tenantId, c.id, PERIODO, "abierto", null);

      // Una transacción ajena retiene el índice único de vigentes de ESA venta: la exclusión del asistente pasa el control de
      // estado (lee «abierto») y queda esperando en su INSERT. Así la ventana es determinista.
      const cx = await admin.pool.connect();
      let excluir: Promise<any> | undefined;
      let revisarAntes = false;
      let revisar: any;
      try {
        await cx.query("BEGIN");
        await cx.query(
          `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por)
           values ($1, $2, $3, $4, 'retencion de la prueba', $5)`,
          [E.tenantId, c.id, PERIODO, ventaId, E.titular.id],
        );
        excluir = v.llamar(asistente, "POST", `${base(c.id)}/${ventaId}/excluir`, { motivo: MOTIVO });
        await esperarBloqueada();

        // Con la exclusión en curso, el contador marca `revisado`.
        const pedido = v.llamar(contador, "POST", `${base(c.id)}/estado/revisar`, {});
        const r = await Promise.race([pedido, dormir(3000).then(() => null)]);
        revisarAntes = r !== null;
        if (r !== null) revisar = r;
        await cx.query("ROLLBACK");
        if (r === null) revisar = await pedido;
      } finally {
        await cx.query("ROLLBACK").catch(() => undefined);
        cx.release();
      }
      const ex = await excluir!;

      expect(revisar.status, revisar.text).toBe(200);
      expect((await A.periodoVentas(c.id))?.estado).toBe("revisado");
      if (revisarAntes) {
        // «revisar» se confirmó mientras la exclusión seguía abierta: entonces la exclusión, que se confirma después, no puede
        // pasar con quien no tiene sire.aprobar_generar (P-9, D5).
        expect(
          { status: ex.status, codigo: ex.body?.codigo, vigentes: (await A.exclusiones(c.id)).filter((x) => !x.restaurada).length },
          "la exclusión del asistente quedó confirmada después de que el periodo se marcó revisado",
        ).toEqual({ status: 403, codigo: "periodo_revisado", vigentes: 0 });
      } else {
        expect(ex.status, ex.text).toBe(200);
      }
    },
  );
});

describe("ADV-012b-a · D12: el motivo es de 1 a 200 caracteres", () => {
  it("150 emojis son 150 caracteres (la BD los acepta): 200 y el motivo queda tal cual", async () => {
    const { c, ventaId } = await conDescuadrada();
    const motivo = "\u{1F600}".repeat(150);
    const r = await v.llamar(asistente, "POST", `${base(c.id)}/${ventaId}/excluir`, { motivo });
    expect(r.status, r.text).toBe(200);
    expect(r.body.exclusion?.motivo).toBe(motivo);
    const [fila] = await A.sql("select char_length(motivo)::int as n from venta_exclusion where venta_id = $1", [ventaId]);
    expect(fila?.n).toBe(150);
  });
});
