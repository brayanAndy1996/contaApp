// Spec 014 (T10, rojo): GET /clientes/:clienteId/periodos/:periodo/compras/resumen (RF-068, RF-069, D-8, D-9; CA-9, DU-20).
// Contrato (plan: «Contratos: HTTP» y «Decisiones: Resumen y Excel»; `resumenComprasSchema` de `@contapp/shared`):
//  - 200 `{ estado, casilleros: { original, vigente, diferencia }, conIgv: { n, casilleros }, sinIgv: { n, casilleros },
//    filasSinConvertir: string[] }`. Cada `casilleros` trae las 10 columnas de 010 y el `total`, todas cadenas con 2 decimales.
//  - `original`: versión 1 de las filas del SIRE (excluidas incluidas, agregadas fuera). `vigente`: versión vigente sin excluidas ni
//    descartadas, con las agregadas. `diferencia` = vigente − original. Todo con `Money` en el servidor.
//  - Las filas USD se convierten con `convertirAPen` de 010 (cada columna redondeada, total = suma de las columnas); la que no se
//    puede convertir (sin tipo de cambio) sale en `filasSinConvertir` (su id) y no suma, igual que `resumirCambios` de 012.
//  - «Con IGV» y «sin IGV» separan las filas vigentes por la suma de IGV de la fila distinta o igual a 0.00, con su cantidad.
//  - `estado` es el de `compra_periodo` (`abierto` si no hay fila).
//  - Sin tope (DU-20): con más de 5.000 filas vivas en el periodo el resumen cuenta todas, sin cortar.
// Rojo: el módulo `compras` aún no existe (T15): toda ruta responde 404 de ruta inexistente.
import {
  convertirAPen,
  MontosComprobante,
  TipoCambio,
} from "@contapp/domain";
import { resumenComprasSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  centimos,
  COLUMNAS,
  deCentimos,
  filasFixtureCompras,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () =>
  v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id] });
const u = (): string => E.titular.id;
const resumen = (a: Actor, c: Cliente, periodo = PERIODO) =>
  v.llamar(a, "GET", `${base(c.id, periodo)}/resumen`);
const CLAVES_CASILLERO = [...COLUMNAS, "total"].sort();

/** Las filas PEN del fixture de 009 (San Juan, mixta, bolsas y gravada común); `sanJuanCorregido` deja su versión 2 aceptada. */
async function sembrarPen(c: Cliente, sanJuanCorregido: boolean): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 4, usuarioId: u() });
  for (const f of filasFixtureCompras().filter((x) => x.moneda === "PEN")) {
    const sanJuan = f.numero === "1040";
    ids[`${f.serie}-${f.numero}`] = await v.sembrarCompra(E.tenantId, c.id, {
      serie: f.serie,
      numero: f.numero,
      doc: f.rucContraparte,
      razonSocial: f.razonSocialContraparte ?? null,
      fecha: f.fechaEmision,
      propuestaId,
      usuarioId: u(),
      montos: {
        biDg: f.biDg,
        igvDg: f.igvDg,
        biDgng: f.biDgng,
        igvDgng: f.igvDgng,
        biDng: f.biDng,
        igvDng: f.igvDng,
        noGravado: f.noGravado,
        isc: f.isc,
        icbper: f.icbper,
        otrosTributos: f.otros,
        total: f.total,
      },
      ...(sanJuan && sanJuanCorregido
        ? { versiones: [{ montos: { biDg: "0.00", isc: "770.00" }, accion: "sugerencia" }] }
        : {}),
    });
  }
  return ids;
}

describe("CA-9 · resumen por casillero: original, vigente y diferencia (RF-068, D-8)", () => {
  it("San Juan corregido: BI de DG −770.00 e ISC +770.00 frente a la original, con el total intacto", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, true);
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(resumenComprasSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.estado).toBe("abierto");

    // Original: la versión 1 de las 4 filas PEN (770.00 + 21.48 + 100.00 + 150.00 de BI DG, etc.).
    expect(r.body.casilleros.original).toEqual({
      biDg: "1041.48",
      igvDg: "46.61",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "0.00",
      igvDng: "0.00",
      noGravado: "0.00",
      isc: "0.00",
      icbper: "1.50",
      otrosTributos: "0.00",
      total: "1089.59",
    });
    expect(r.body.casilleros.vigente).toEqual({
      biDg: "271.48",
      igvDg: "46.61",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "0.00",
      igvDng: "0.00",
      noGravado: "0.00",
      isc: "770.00",
      icbper: "1.50",
      otrosTributos: "0.00",
      total: "1089.59",
    });
    expect(r.body.casilleros.diferencia).toEqual({
      biDg: "-770.00",
      igvDg: "0.00",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "0.00",
      igvDng: "0.00",
      noGravado: "0.00",
      isc: "770.00",
      icbper: "0.00",
      otrosTributos: "0.00",
      total: "0.00",
    });
    expect(r.body.filasSinConvertir).toEqual([]);
  });

  it("sin correcciones, vigente y original son iguales y la diferencia es cero en todos los casilleros", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, false);
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.casilleros.vigente).toEqual(r.body.casilleros.original);
    for (const k of CLAVES_CASILLERO) expect(r.body.casilleros.diferencia[k], k).toBe("0.00");
  });

  it("separa compras con y sin IGV con sus cantidades (la fila con IGV 0.00 es «sin IGV»)", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, true);
    const r = await resumen(contador, c);
    expect(r.body.conIgv.n).toBe(3); // mixta, bolsas y gravada común
    expect(r.body.sinIgv.n).toBe(1); // San Juan: IGV 0.00
    expect(r.body.sinIgv.casilleros).toMatchObject({ biDg: "0.00", igvDg: "0.00", isc: "770.00", total: "770.00" });
    expect(r.body.conIgv.casilleros).toMatchObject({ biDg: "271.48", igvDg: "46.61", icbper: "1.50", isc: "0.00", total: "319.59" });
    // Los dos grupos suman el vigente.
    for (const k of CLAVES_CASILLERO) {
      expect(centimos(r.body.conIgv.casilleros[k]) + centimos(r.body.sinIgv.casilleros[k]), k).toBe(centimos(r.body.casilleros.vigente[k]));
    }
    expect(Object.keys(r.body.conIgv).sort()).toEqual(["casilleros", "n"]);
  });

  it("todos los casilleros son cadenas con dos decimales, nunca number", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, true);
    const r = await resumen(contador, c);
    for (const grupo of [r.body.casilleros.original, r.body.casilleros.vigente, r.body.casilleros.diferencia, r.body.conIgv.casilleros, r.body.sinIgv.casilleros]) {
      expect(Object.keys(grupo).sort()).toEqual(CLAVES_CASILLERO);
      for (const x of Object.values(grupo)) expect(x).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(Number.isInteger(r.body.conIgv.n)).toBe(true);
  });

  it("un periodo sin compras: todo en cero, estado abierto y nada que convertir", async () => {
    const c = await nuevoCliente();
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toBe("abierto");
    for (const grupo of [r.body.casilleros.original, r.body.casilleros.vigente, r.body.casilleros.diferencia]) {
      for (const x of Object.values(grupo)) expect(x).toBe("0.00");
    }
    expect(r.body.conIgv.n).toBe(0);
    expect(r.body.sinIgv.n).toBe(0);
    expect(r.body.filasSinConvertir).toEqual([]);
  });

  it("el resumen es del periodo y del cliente pedidos: otro periodo y otro cliente no suman", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, false);
    const otro = await nuevoCliente();
    await sembrarPen(otro, true);
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F777", numero: "1", usuarioId: u(), periodo: "202609" });
    const r = await resumen(contador, c);
    expect(r.body.casilleros.original.total).toBe("1089.59");
    expect(r.body.conIgv.n + r.body.sinIgv.n).toBe(4);
  });

  it("el estado del periodo sale de compra_periodo", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, false);
    expect((await resumen(contador, c)).body.estado).toBe("abierto");
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    expect((await resumen(contador, c)).body.estado).toBe("revisado");
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    expect((await resumen(contador, c)).body.estado).toBe("generado");
  });
});

describe("D-8 · excluidas, descartadas y agregadas en el resumen", () => {
  it("la excluida sale del vigente pero cuenta en la original; la agregada solo en el vigente; la descartada en ninguno", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 2, usuarioId: u() });
    // Base: una fila del SIRE de 100.00 + 18.00.
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "1", doc: "20700000011", propuestaId, usuarioId: u() });
    // Excluida: su versión 1 (200.00 + 36.00) cuenta en la original; la vigente no.
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "2",
      doc: "20700000012",
      propuestaId,
      usuarioId: u(),
      montos: { biDg: "200.00", igvDg: "36.00" },
      versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
    });
    // Agregada a mano (50.00 + 9.00): solo en el vigente.
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "3",
      doc: "20700000013",
      origen: "agregada",
      usuarioId: u(),
      montos: { biDg: "50.00", igvDg: "9.00" },
    });
    // Descartada (agregada que se quitó): en ninguno.
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "4",
      doc: "20700000014",
      origen: "agregada",
      descartada: true,
      usuarioId: u(),
      montos: { biDg: "999.00", igvDg: "179.82" },
    });
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.casilleros.original).toMatchObject({ biDg: "300.00", igvDg: "54.00", total: "354.00" });
    expect(r.body.casilleros.vigente).toMatchObject({ biDg: "150.00", igvDg: "27.00", total: "177.00" });
    expect(r.body.casilleros.diferencia).toMatchObject({ biDg: "-150.00", igvDg: "-27.00", total: "-177.00" });
    expect(r.body.conIgv.n).toBe(2);
    expect(r.body.sinIgv.n).toBe(0);
  });

  it("una fila editada cuenta con su versión vigente en el vigente y con la 1 en la original", async () => {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "1",
      usuarioId: u(),
      montos: { biDg: "100.00", igvDg: "18.00" },
      versiones: [{ montos: { biDg: "120.00", igvDg: "21.60" }, accion: "editar" }, { montos: { biDg: "130.00", igvDg: "23.40" }, accion: "editar" }],
    });
    const r = await resumen(contador, c);
    expect(r.body.casilleros.original).toMatchObject({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(r.body.casilleros.vigente).toMatchObject({ biDg: "130.00", igvDg: "23.40", total: "153.40" });
    expect(r.body.casilleros.diferencia).toMatchObject({ biDg: "30.00", igvDg: "5.40", total: "35.40" });
  });

  it("montos negativos (notas de crédito) restan en los casilleros", async () => {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "1", usuarioId: u(), montos: { biDg: "100.00", igvDg: "18.00" } });
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "2", doc: "20700000012", usuarioId: u(), montos: { biDg: "-40.00", igvDg: "-7.20" } });
    const r = await resumen(contador, c);
    expect(r.body.casilleros.vigente).toMatchObject({ biDg: "60.00", igvDg: "10.80", total: "70.80" });
  });
});

describe("D-8 · filas en USD: se convierten con convertirAPen o salen en filasSinConvertir", () => {
  it("F001-4062 (USD 0.15 + 0.03 a 3.300) suma lo que da convertirAPen de 010, columna por columna, y no sale en filasSinConvertir", async () => {
    const c = await nuevoCliente();
    const usd = filasFixtureCompras().find((f) => f.numero === "4062")!;
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: usd.serie,
      numero: usd.numero,
      doc: usd.rucContraparte,
      moneda: "USD",
      tipoCambio: usd.tipoCambio!,
      fecha: usd.fechaEmision,
      usuarioId: u(),
      montos: { biDg: usd.biDg, igvDg: usd.igvDg, total: usd.total },
    });
    const esperado = convertirAPen(
      MontosComprobante.desde("USD", { biDg: usd.biDg, igvDg: usd.igvDg, total: usd.total } as never),
      TipoCambio.desde(usd.tipoCambio!),
    );
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.filasSinConvertir).toEqual([]);
    for (const k of COLUMNAS) expect(r.body.casilleros.vigente[k], k).toBe(esperado.obtener(k as never).toString());
    expect(r.body.casilleros.vigente.total).toBe(esperado.total.toString());
    expect(r.body.casilleros.original).toEqual(r.body.casilleros.vigente);
    expect(r.body.conIgv.n).toBe(1);
  });

  it("una fila USD sin tipo de cambio sale en filasSinConvertir (su id) y no suma", async () => {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "1", usuarioId: u(), montos: { biDg: "100.00", igvDg: "18.00" } });
    const sinTc = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "2",
      doc: "20700000012",
      moneda: "USD",
      tipoCambio: null,
      usuarioId: u(),
      montos: { biDg: "10.00", igvDg: "1.80" },
    });
    const r = await resumen(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.filasSinConvertir).toEqual([sinTc]);
    expect(r.body.casilleros.original).toMatchObject({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(r.body.casilleros.vigente).toMatchObject({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
  });

  it("una USD sin tipo de cambio repetida no repite su id", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "1",
      moneda: "USD",
      tipoCambio: null,
      usuarioId: u(),
      montos: { biDg: "10.00", igvDg: "1.80" },
      versiones: [{ montos: { biDg: "20.00", igvDg: "3.60" }, accion: "editar" }],
    });
    const r = await resumen(contador, c);
    expect(r.body.filasSinConvertir).toEqual([id]);
  });
});

describe("DU-20 · más de 5.000 filas vivas: el resumen cuenta todas, sin cortar", () => {
  it("5.300 filas del SIRE más una excluida, una editada y una agregada: los casilleros salen exactos", async () => {
    const c = await nuevoCliente();
    const filas = await v.sembrarVolumen(E.tenantId, c.id, 5300, { usuarioId: u() });
    expect(filas).toHaveLength(5300);
    const propuestaId = (await v.compras(c.id))[0]!.propuesta_id!;
    // F010-1 excluida (200.00 + 36.00 en la original); F010-2 editada de 50.00 + 9.00 a 60.00 + 10.80; F010-3 agregada de 10.00 + 1.80.
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F010",
      numero: "1",
      doc: "20700000021",
      propuestaId,
      usuarioId: u(),
      montos: { biDg: "200.00", igvDg: "36.00" },
      versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
    });
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F010",
      numero: "2",
      doc: "20700000022",
      propuestaId,
      usuarioId: u(),
      montos: { biDg: "50.00", igvDg: "9.00" },
      versiones: [{ montos: { biDg: "60.00", igvDg: "10.80" }, accion: "editar" }],
    });
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F010",
      numero: "3",
      doc: "20700000023",
      origen: "agregada",
      usuarioId: u(),
      montos: { biDg: "10.00", igvDg: "1.80" },
    });

    const r = await resumen(contador, c);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.ms, "resumen de más de 5.000 filas").toBeLessThan(10_000);
    const base5300 = 5300n * 10000n; // BI de 100.00 en céntimos
    const igv5300 = 5300n * 1800n;
    const tot5300 = 5300n * 11800n;
    // Original: las 5.300, la excluida (200.00) y la editada en su versión 1 (50.00); sin la agregada.
    expect(r.body.casilleros.original.biDg).toBe(deCentimos(base5300 + 20000n + 5000n));
    expect(r.body.casilleros.original.igvDg).toBe(deCentimos(igv5300 + 3600n + 900n));
    expect(r.body.casilleros.original.total).toBe(deCentimos(tot5300 + 23600n + 5900n));
    // Vigente: las 5.300, la editada en su versión 2 (60.00) y la agregada (10.00); sin la excluida.
    expect(r.body.casilleros.vigente.biDg).toBe(deCentimos(base5300 + 6000n + 1000n));
    expect(r.body.casilleros.vigente.igvDg).toBe(deCentimos(igv5300 + 1080n + 180n));
    expect(r.body.casilleros.vigente.total).toBe(deCentimos(tot5300 + 7080n + 1180n));
    expect(r.body.casilleros.diferencia.biDg).toBe(deCentimos(6000n + 1000n - 20000n - 5000n));
    expect(r.body.conIgv.n).toBe(5302); // 5.300 + la editada + la agregada (la excluida no cuenta)
    expect(r.body.sinIgv.n).toBe(0);
    expect(r.body.filasSinConvertir).toEqual([]);
  });

  it("justo 5.001 filas: la fila 5.001 cuenta (no hay corte en 5.000)", async () => {
    const c = await nuevoCliente();
    await v.sembrarVolumen(E.tenantId, c.id, 5001, { usuarioId: u() });
    const r = await resumen(contador, c);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.body.conIgv.n).toBe(5001);
    expect(r.body.casilleros.vigente.biDg).toBe(deCentimos(5001n * 10000n));
    expect(r.body.casilleros.vigente.total).toBe(deCentimos(5001n * 11800n));
  });
});

describe("D-11 · permisos del resumen", () => {
  it("lectura (clientes.ver) lo ve; el cliente archivado también", async () => {
    const c = await nuevoCliente();
    await sembrarPen(c, false);
    expect((await resumen(lectura, c)).status).toBe(200);
    const archivado = await v.cliente(E, { responsable: contador.id, archivado: true });
    expect((await resumen(contador, archivado)).status).toBe(200);
  });

  it("sin sesión, 401", async () => {
    const c = await nuevoCliente();
    expect((await resumen(contador, c)).status).toBe(200); // control: la ruta existe
    expect((await v.sinSesion("GET", `${base(c.id)}/resumen`)).status).toBe(401);
  });
});
