/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b · T18 (rojo): corrección de H-012b-1 (ronda adversarial 1). Toda escritura de ventas se comporta como las de compras
// (014): si falta la fila de `venta_periodo` la crea `abierto` y la toma `FOR SHARE` ANTES de decidir (D5, P-9, plan: orden de
// bloqueo). Así, un «revisar» simultáneo espera a la escritura en curso, o la escritura ve `revisado` y recibe 403.
//  - Invariante: una escritura de ventas de quien NO tiene `sire.aprobar_generar` no se confirma después de que el periodo
//    quedó `revisado`. Se prueba con excluir, agregar e importar, en los dos órdenes:
//      · escritura primero: la escritura ya pasó el control de estado y queda esperando en su INSERT (una transacción ajena
//        retiene la clave); con ella en curso el contador marca `revisado`. O «revisar» espera, o la escritura se rechaza (403
//        `periodo_revisado`) sin efecto.
//      · «revisar» primero: la escritura recibe 403 `periodo_revisado` y no deja efecto (control: ya pasa hoy).
//  - Hoy (rojo): `estadoParaEscribir` (ventas/apoyo.ts) no crea la fila ni la bloquea si falta o está `abierto` sin marca, y
//    «revisar» termina mientras la escritura sigue en curso; esta se confirma después, con el periodo `revisado`.
// Las adversariales de T17 (`exclusion-r1.adv.int.spec.ts`) no cambian; esta amplía el invariante a agregar e importar.
import { createDb, type ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, descuadrada, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, boletas290y292, csvVentas, cuerpoVenta, fila } from "../../../test/soporte-ventas.js";

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

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOTIVO = "Llegó descuadrada del SIRE";

type Cliente = { id: string; ruc: string };
type Conexion = { query(texto: string, valores?: unknown[]): Promise<unknown> };
interface Resultado {
  status: number;
  body: any;
  text: string;
}

/** Una escritura de ventas del asistente (sin `sire.aprobar_generar`) lista para correr contra un cliente nuevo. */
interface Escritura {
  /** Retiene en `cx` (sin confirmar) lo que hará esperar a la escritura en su INSERT, una vez que pasó el control de estado. */
  retener(cx: Conexion): Promise<void>;
  ejecutar(): Promise<Resultado>;
  /** Filas que la escritura dejó confirmadas (0 o 1). */
  efectos(): Promise<number>;
  /** Patrón (ILIKE) del INSERT en el que queda esperando. */
  patron: string;
  statusOk: number;
  c: Cliente;
}

const SQL_VENTA_RETENIDA = `insert into venta (tenant_id, cliente_id, periodo, origen, clave, tipo, serie, numero, numero_n, fecha,
    tipo_doc_contraparte, doc_contraparte, moneda, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total, creada_por)
  values ($1, $2, $3, 'manual', $4, '03', $5, $6, $7, '2026-10-05', '0', '-', 'PEN', 100, 18, 0, 0, 0, 0, 0, 118, $8)`;

async function clienteNuevo(filas = boletas290y292()): Promise<{ c: Cliente; ids: string[] }> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
  const ids = await v.sembrarVentas(E.tenantId, c.id, filas, { usuarioId: E.titular.id });
  return { c, ids };
}

const retenerVenta = (c: Cliente, serie: string, numero: number) => async (cx: Conexion) => {
  await cx.query(SQL_VENTA_RETENIDA, [E.tenantId, c.id, PERIODO, `03|${serie}|${numero}`, serie, String(numero), numero, E.titular.id]);
};
const ventasConClave = async (c: Cliente, clave: string): Promise<number> =>
  (await A.sql("select count(*)::int as n from venta where cliente_id = $1 and clave = $2", [c.id, clave]))[0].n;

const ESCRITURAS = {
  excluir: async (): Promise<Escritura> => {
    const { c, ids } = await clienteNuevo([...boletas290y292(), descuadrada("D001", 1)]);
    const ventaId = ids[2]!;
    return {
      c,
      patron: "%insert into venta_exclusion%",
      statusOk: 200,
      retener: async (cx) => {
        await cx.query(
          `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por)
           values ($1, $2, $3, $4, 'retencion de la prueba', $5)`,
          [E.tenantId, c.id, PERIODO, ventaId, E.titular.id],
        );
      },
      ejecutar: () => v.llamar(asistente, "POST", `${base(c.id)}/${ventaId}/excluir`, { motivo: MOTIVO }),
      efectos: async () => (await A.exclusiones(c.id)).filter((x) => !x.restaurada).length,
    };
  },
  agregar: async (): Promise<Escritura> => {
    const { c } = await clienteNuevo();
    return {
      c,
      patron: "%insert into venta (%",
      statusOk: 201,
      retener: retenerVenta(c, "M001", 7001),
      ejecutar: () => v.llamar(asistente, "POST", base(c.id), cuerpoVenta("M001", 7001)),
      efectos: () => ventasConClave(c, "03|M001|7001"),
    };
  },
  importar: async (): Promise<Escritura> => {
    const { c } = await clienteNuevo();
    return {
      c,
      patron: "%insert into venta (%",
      statusOk: 201,
      retener: retenerVenta(c, "M001", 7002),
      ejecutar: async () => {
        const r = await v.bin(asistente, "POST", `${base(c.id)}/importar/confirmar`, csvVentas([fila("M001", 7002)]));
        return { status: r.status, body: r.json, text: r.texto };
      },
      efectos: () => ventasConClave(c, "03|M001|7002"),
    };
  },
} as const;
type Nombre = keyof typeof ESCRITURAS;
const NOMBRES = Object.keys(ESCRITURAS) as Nombre[];

/** Estado inicial de `venta_periodo`: sin fila (equivale a `abierto`), `abierto` sin marca o `abierto` reabierto (con marca). */
const ESTADOS_INICIALES = [
  ["sin fila de venta_periodo", "sin_fila"],
  ["venta_periodo `abierto` sin marca (la que crea la descarga del worker)", "abierto"],
  ["venta_periodo `abierto` reabierto (con marca)", "reabierto"],
] as const;
type EstadoInicial = (typeof ESTADOS_INICIALES)[number][1];

async function prepararEstado(c: Cliente, inicial: EstadoInicial): Promise<void> {
  if (inicial === "abierto") await A.estadoVentas(E.tenantId, c.id, PERIODO, "abierto", null);
  if (inicial === "reabierto") await A.estadoVentas(E.tenantId, c.id, PERIODO, "abierto", contador.id);
}

/** Espera a que una sesión de la app esté bloqueada en el INSERT dado (la escritura ya pasó el control de estado). */
async function esperarBloqueada(patron: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await A.sql(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
      [patron],
    );
    if (r[0].n > 0) return;
    await dormir(50);
  }
  throw new Error("la escritura nunca llegó a esperar en el INSERT");
}

describe("H-012b-1 · una escritura de ventas sin sire.aprobar_generar no se confirma después de `revisado`", () => {
  describe.each(NOMBRES)("%s", (nombre) => {
    it.each(ESTADOS_INICIALES)(
      "escritura primero, %s: o «revisar» espera a la escritura, o esta recibe 403 periodo_revisado sin efecto",
      async (_caso, inicial) => {
        const w = await ESCRITURAS[nombre]();
        await prepararEstado(w.c, inicial);

        // Una transacción ajena retiene la clave: la escritura del asistente pasa el control de estado (lee «abierto») y queda
        // esperando en su INSERT. Con ella en curso, el contador marca `revisado`.
        const cx = await admin.pool.connect();
        let escribir: Promise<Resultado> | undefined;
        let revisar: Resultado | undefined;
        let revisarAntes = false;
        try {
          await cx.query("BEGIN");
          await w.retener(cx);
          escribir = w.ejecutar();
          await esperarBloqueada(w.patron);

          const pedido = v.llamar(contador, "POST", `${base(w.c.id)}/estado/revisar`, {});
          const r = await Promise.race([pedido, dormir(3000).then(() => null)]);
          revisarAntes = r !== null;
          if (r !== null) revisar = r;
          await cx.query("ROLLBACK");
          if (r === null) revisar = await pedido;
        } finally {
          await cx.query("ROLLBACK").catch(() => undefined);
          cx.release();
        }
        const escritura = await escribir!;

        expect(revisar?.status, revisar?.text).toBe(200);
        expect((await A.periodoVentas(w.c.id))?.estado).toBe("revisado");
        if (revisarAntes) {
          // «revisar» se confirmó mientras la escritura seguía abierta: la escritura, que se confirmaría después, tiene que
          // verse rechazada (P-9, D5) y no dejar nada.
          expect(
            { status: escritura.status, codigo: escritura.body?.codigo, efectos: await w.efectos() },
            `${nombre}: la escritura de quien no tiene sire.aprobar_generar se confirmó después de que el periodo quedó revisado`,
          ).toEqual({ status: 403, codigo: "periodo_revisado", efectos: 0 });
        } else {
          // «revisar» esperó a la escritura (FOR SHARE vs FOR UPDATE): la escritura se hizo con el periodo `abierto`.
          expect(escritura.status, escritura.text).toBe(w.statusOk);
          expect(await w.efectos()).toBe(1);
        }
      },
    );

    it.each(ESTADOS_INICIALES)(
      "«revisar» primero, %s: la escritura recibe 403 periodo_revisado y no deja efecto",
      async (_caso, inicial) => {
        const w = await ESCRITURAS[nombre]();
        await prepararEstado(w.c, inicial);
        const revisar = await v.llamar(contador, "POST", `${base(w.c.id)}/estado/revisar`, {});
        expect(revisar.status, revisar.text).toBe(200);

        const escritura = await w.ejecutar();

        expect(escritura.status, escritura.text).toBe(403);
        expect(escritura.body).toEqual({ codigo: "periodo_revisado" });
        expect(await w.efectos()).toBe(0);
        expect(await A.periodoVentas(w.c.id)).toMatchObject({ estado: "revisado", marcado_por: contador.id });
      },
    );
  });

  it("una escritura que se confirma deja la fila de venta_periodo `abierto` sin marca (excluir, agregar e importar)", async () => {
    for (const nombre of NOMBRES) {
      const w = await ESCRITURAS[nombre]();
      expect(await A.periodoVentas(w.c.id), `${nombre}: sin fila antes de escribir`).toBeNull();
      const r = await w.ejecutar();
      expect(r.status, `${nombre}: ${r.text}`).toBe(w.statusOk);
      expect(await A.periodoVentas(w.c.id), `${nombre}: la fila que crea la escritura`).toEqual({ estado: "abierto", marcado_por: null });
    }
  });
});
