/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 · T15 (adversario, ronda 1) por HTTP: alcance y permisos con la sesión viva (desasignado, degradado a Lectura, desactivado),
// periodo y cliente forjados en el cuerpo, lectura que no mezcla otro cliente con el mismo proveedor ni otro estudio con el mismo RUC, y
// las cinco escrituras del mismo mes a la vez con el archivado. Caja negra (spec D-5, plan «HTTP»); caja blanca: la visibilidad se
// mira en la transacción (`clienteVisible`) y las funciones de 0066 solo exigen membresía activa, así que todo depende del guard.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  declaracionesCA1,
  facturaVenta,
  M,
  montosCompra,
  NO_ENCONTRADO,
  rutaEliminar,
  rutaHistorial,
  rutaManual,
  rutaObtener,
  rutaUsada,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const P = "202601";
const u = (): string => E.titular.id;
const miembro = (rol: "contador" | "asistente" | "lectura"): Promise<Actor> => v.b.c.p.b.miembro(E.tenantId, rol);
const cuerpoManual = (version: number, motivo = "Libro físico") => ({
  gravadas: "10.00",
  exportaciones: "0.00",
  noGravadas: "5.00",
  motivo,
  version,
});
const lecturas = (c: { id: string }) => [
  { metodo: "GET" as const, ruta: rutaVista(c.id, M) },
  { metodo: "GET" as const, ruta: rutaHistorial(c.id, P) },
];
const escrituras = (c: { id: string }) => [
  { metodo: "POST" as const, ruta: rutaObtener(c.id), cuerpo: { periodo: M } },
  { metodo: "PUT" as const, ruta: rutaManual(c.id, P), cuerpo: cuerpoManual(0) },
  { metodo: "POST" as const, ruta: rutaEliminar(c.id, "202602"), cuerpo: { motivo: "x", version: 1 } },
  { metodo: "PUT" as const, ruta: rutaUsada(c.id, M), cuerpo: { porcentaje: "50.00", version: 0 } },
];

// ===========================================================================================================================
describe("permisos y alcance con la sesión viva (D-5, CA-9)", () => {
  it("Contador desasignado: tras retirar la asignación, la misma sesión recibe 404 en las seis rutas y no escribe ni encola", async () => {
    const contador = await miembro("contador");
    const c = await v.cliente(E, { colaboradores: [contador.id] });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202602", version: 1, autor: u() });
    const control = await v.http(contador, "PUT", rutaUsada(c.id, "202609"), { porcentaje: "40.00", version: 0 });
    expect(control.status, control.text).toBe(200);

    const q = await v.http(E.titular, "DELETE", `/clientes/${c.id}/asignaciones/${contador.id}`);
    expect(q.status, q.text).toBe(204);
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const estados: number[] = [];
    for (const p of [...lecturas(c), ...escrituras(c)]) {
      const r = await v.http(contador, p.metodo, p.ruta, (p as any).cuerpo);
      estados.push(r.status);
      if (r.status === 404) expect(r.body).toEqual(NO_ENCONTRADO);
    }
    expect(estados).toEqual([404, 404, 404, 404, 404, 404]);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("Contador degradado a Lectura con la sesión viva: lee (200) y recibe 403 al escribir; desactivado: ni lee ni escribe (sin 5xx); nada escrito", async () => {
    const degradado = await miembro("contador");
    const desactivado = await miembro("contador");
    const c = await v.cliente(E, { responsable: degradado.id, colaboradores: [desactivado.id] });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202602", version: 1, autor: u() });
    // Control: los dos escriben antes del cambio.
    expect((await v.http(degradado, "PUT", rutaUsada(c.id, "202608"), { porcentaje: "1.00", version: 0 })).status).toBe(200);
    expect((await v.http(desactivado, "PUT", rutaUsada(c.id, "202607"), { porcentaje: "1.00", version: 0 })).status).toBe(200);

    const rol = await v.http(E.titular, "PATCH", `/usuarios/${degradado.id}/rol`, { rol: "lectura" });
    expect(rol.status, rol.text).toBeLessThan(300);
    const des = await v.http(E.titular, "POST", `/usuarios/${desactivado.id}/desactivar`);
    expect(des.status, des.text).toBe(200);
    const antes = await v.fotoProrrata(E.tenantId, c.id);

    const lee = await v.http(degradado, "GET", rutaVista(c.id, M));
    expect(lee.status, lee.text).toBe(200);
    const deg: Record<string, number> = {};
    for (const p of escrituras(c)) deg[`${p.metodo} ${p.ruta}`] = (await v.http(degradado, p.metodo, p.ruta, p.cuerpo)).status;
    expect(Object.values(deg), JSON.stringify(deg)).toEqual([403, 403, 403, 403]);

    const desac: Record<string, number> = {};
    for (const p of [...lecturas(c), ...escrituras(c)])
      desac[`${p.metodo} ${p.ruta}`] = (await v.http(desactivado, p.metodo, p.ruta, (p as any).cuerpo)).status;
    for (const [ruta, st] of Object.entries(desac)) expect([401, 403, 404], `${ruta}: ${st}`).toContain(st);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });
});

// ===========================================================================================================================
describe("cuerpo forjado: periodo, cliente o estudio que no son los de la ruta (D-5, plan «HTTP»: esquemas .strict())", () => {
  it("las cuatro escrituras con periodo, clienteId o tenantId en el cuerpo: 400 solicitud_invalida y nada escrito en ninguno de los dos clientes", async () => {
    const F = await v.estudio();
    const a = await v.cliente(E, {});
    const b = await v.cliente(E, {});
    const ajeno = await v.cliente(F, {});
    await v.sembrarManual(E.tenantId, a.id, { periodo: P, version: 1, autor: u() });
    const extra = { periodo: "202602", clienteId: b.id, tenantId: F.tenantId };
    const casos = [
      { metodo: "POST" as const, ruta: rutaObtener(a.id), cuerpo: { periodo: M, clienteId: b.id } },
      { metodo: "POST" as const, ruta: rutaObtener(a.id), cuerpo: { periodo: M, clienteId: ajeno.id, tenantId: F.tenantId } },
      { metodo: "PUT" as const, ruta: rutaManual(a.id, P), cuerpo: { ...cuerpoManual(1), ...extra } },
      { metodo: "PUT" as const, ruta: rutaManual(a.id, P), cuerpo: { ...cuerpoManual(1), periodo: "202602" } },
      { metodo: "POST" as const, ruta: rutaEliminar(a.id, P), cuerpo: { motivo: "x", version: 1, periodo: "202602" } },
      { metodo: "PUT" as const, ruta: rutaUsada(a.id, M), cuerpo: { porcentaje: "50.00", version: 0, periodo: "202609" } },
      { metodo: "PUT" as const, ruta: rutaUsada(a.id, M), cuerpo: { porcentaje: "50.00", version: 0, clienteId: b.id } },
    ];
    const fotos = async () => [
      await v.fotoProrrata(E.tenantId, a.id),
      await v.fotoProrrata(E.tenantId, b.id),
      await v.fotoProrrata(F.tenantId, ajeno.id),
    ];
    const antes = await fotos();
    const obs: string[] = [];
    for (const k of casos) {
      const r = await v.http(E.titular, k.metodo, k.ruta, k.cuerpo);
      obs.push(`${r.status} ${r.body?.codigo}`);
    }
    expect(obs).toEqual(casos.map(() => "400 solicitud_invalida"));
    expect(await fotos()).toEqual(antes);
  });
});

// ===========================================================================================================================
describe("la lectura no mezcla otro cliente con el mismo proveedor ni otro estudio con el mismo RUC (CA-8)", () => {
  it("IGV estimado, meses y prorrata usada salen solo de las filas del cliente pedido", async () => {
    const F = await v.estudio();
    const c = await v.cliente(E, {});
    const otro = await v.cliente(E, {});
    // Mismo RUC en otro estudio (el RUC no es único entre estudios).
    const gemelo = await v.cliente(F, { ruc: c.ruc });
    const PROVEEDOR = "20700000123";
    async function compras(t: string, cl: Cliente, filas: { d: "DG" | "DGNG" | "DNG"; bi: string; igv: string }[]): Promise<void> {
      const propuestaId = await v.sembrarPropuesta(t, cl.id, { periodo: M, libro: "compras", nuevas: filas.length, usuarioId: t === E.tenantId ? u() : F.titular.id });
      for (const [i, f] of filas.entries())
        await v.sembrarCompra(t, cl.id, {
          periodo: M,
          serie: "F010",
          numero: String(i + 1),
          doc: PROVEEDOR,
          propuestaId,
          usuarioId: t === E.tenantId ? u() : F.titular.id,
          montos: montosCompra(f.d, f.bi, f.igv),
        });
    }
    // El cliente pedido: 12 PDT (CA1), ventas de M con IGV 180.00 y una compra DG de 100.00 del proveedor.
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1(), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "1000.00", "180.00")], u());
    await compras(E.tenantId, c, [{ d: "DG", bi: "555.56", igv: "100.00" }]);
    // Otro cliente del estudio con el MISMO proveedor y el mismo comprobante, y montos grandes.
    await v.sembrarDeclaraciones(E.tenantId, otro.id, declaracionesCA1().map((d) => ({ ...d, prorrataUsada: "12.34" })), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, otro.id, M, [facturaVenta("F001", 1, "50000.00", "9000.00")], u());
    await compras(E.tenantId, otro, [
      { d: "DG", bi: "16666.67", igv: "3000.00" },
      { d: "DGNG", bi: "6858.72", igv: "1234.57" },
    ]);
    // El gemelo de otro estudio (mismo RUC): PDT con prorrata usada, manual, prorrata ingresada, ventas y compras.
    await v.sembrarDeclaraciones(F.tenantId, gemelo.id, declaracionesCA1().map((d) => ({ ...d, prorrataUsada: "11.11" })), { periodoHasta: M });
    await v.sembrarManual(F.tenantId, gemelo.id, { periodo: "202510", autor: F.titular.id });
    await v.sembrarUsada(F.tenantId, gemelo.id, { periodo: M, porcentaje: "22.22", autor: F.titular.id });
    await v.sembrarVentasSire(F.tenantId, gemelo.id, M, [facturaVenta("F001", 1, "70000.00", "12600.00")], F.titular.id);
    await compras(F.tenantId, gemelo, [{ d: "DGNG", bi: "1000.00", igv: "180.00" }]);

    const r = await v.http(E.titular, "GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", porcentaje: "83.89" });
    expect(r.body.igvEstimado).toMatchObject({
      estado: "calculado",
      igvVentas: "180.00",
      creditoDg: "100.00",
      igvDgng: "0.00",
      creditoDgng: "0.00",
      resultado: "80.00",
      situacion: "a_pagar",
    });
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.diferencia).toBeNull();
    expect(r.body.ventana.map((m: any) => m.origen)).toEqual(Array(12).fill("declarado"));
    const h = await v.http(E.titular, "GET", rutaHistorial(c.id, "202510"));
    expect(h.status, h.text).toBe(200);
    expect(h.body.manual).toEqual([]);
  });
});

// ===========================================================================================================================
describe("concurrencia por HTTP: manual ∥ manual ∥ eliminar ∥ prorrata usada ∥ obtener ∥ archivar (D-4, D-5)", () => {
  const RONDAS = 6;
  it(`cada respuesta es una del contrato (nunca 5xx) y las versiones del manual quedan contiguas; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await v.cliente(E, {});
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
      const [g1, g2, el, us, ob, ar] = await Promise.all([
        v.http(E.titular, "PUT", rutaManual(c.id, P), cuerpoManual(1, "uno")),
        v.http(E.titular, "PUT", rutaManual(c.id, P), cuerpoManual(1, "dos")),
        v.http(E.titular, "POST", rutaEliminar(c.id, P), { motivo: "tres", version: 1 }),
        v.http(E.titular, "PUT", rutaUsada(c.id, M), { porcentaje: "50.00", version: 0 }),
        v.http(E.titular, "POST", rutaObtener(c.id), { periodo: M }),
        v.http(E.titular, "POST", `/clientes/${c.id}/archivar`),
      ]);
      const s = (r: { status: number; body: any }) => `${r.status}${r.body?.codigo ? ` ${r.body.codigo}` : ""}`;
      const ctx = `ronda ${ronda}: ${[g1, g2, el, us, ob, ar].map(s).join(" | ")}`;
      for (const r of [g1, g2, el])
        expect(["200", "409 mes_cambiado", "409 cliente_archivado"], ctx).toContain(s(r).replace(/^200.*/, "200"));
      expect(["200", "409 cliente_archivado"], ctx).toContain(s(us).replace(/^200.*/, "200"));
      expect(["202", "409 cliente_archivado"], ctx).toContain(s(ob).replace(/^202.*/, "202"));
      expect(ar.status, ctx).toBe(200);
      expect([g1, g2, el].filter((r) => r.status === 200).length, ctx).toBeLessThanOrEqual(1);
      const versiones = (await v.manualesBd(c.id, P)).map((m: any) => Number(m.version));
      expect(versiones, ctx).toEqual(versiones.map((_: number, i: number) => i + 1));
      expect((await v.usadasBd(c.id, M)).length, ctx).toBe(us.status === 200 ? 1 : 0);
      expect((await v.trabajosDescarga(E.tenantId, c.id)).length, ctx).toBe(ob.status === 202 ? 1 : 0);
    }
  });
});
