/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 (T6, rojo): R-STD, la sugerencia «DNG por perfil del cliente» (RF-113, HU-30; D-8, D-9, U-3, U-4; CA-9, CA-10, CA-11).
// Contrato (plan 025, «Contratos: domain» y «HTTP»: las rutas de compras de 014/015 no cambian; R-STD llega por `entornoDeReglas` (el perfil
// fiscal del cliente, columnas de 0026, y los proveedores con regla activa) y por `CODIGOS_REGLA` en aceptar y en la masiva por regla):
//  - Una evaluación (`agregar`, `editar`, descarga, re-evaluación) da el hallazgo R-STD de una fila solo si: el cliente cumple U-4 (zona
//    `amazonia`, ventas exoneradas y sin ventas mixtas), el proveedor NO tiene regla aprendida activa (del destino que sea, también DG), la
//    fila tiene base gravada DG o DGNG distinta de cero y no fue clasificada por el contador. Su vista: `{regla: "R-STD", destino: "DNG",
//    explicacion: "DNG por perfil del cliente", sugerencia: {tipo: "clasificar"}, requiereConfirmacion: false, dato: null, masiva: true}`.
//    Convive con R-NEW, R-ISC y R-MIX; se puede apagar en el estudio (`PUT /estudio/reglas-motor/R-STD`).
//  - Aceptarla (una: `POST …/:id/sugerencias/aceptar {versionBase, regla: "R-STD"}`, sin `confirmar` ni `dato`; en masa:
//    `POST …/masivas/aceptar {items, regla: "R-STD"}`) da exactamente los montos de `cambiarDestino(DNG)`, es decir, de clasificar a mano
//    en DNG (también con DG y DGNG a la vez y en USD); la fila queda `clasificada`. No inserta en `regla_confirmacion`.
//  - Tras clasificar a mano no vuelve a sugerirse (la aceptación de una versión vieja es 409 `revisar_de_nuevo`).
//  - D-9, RNF-052: el perfil se lee al evaluar; cambiarlo después no toca versiones ni hallazgos guardados (solo inserción) y la aceptación
//    de un hallazgo que la evaluación actual ya no produce es 409 `revisar_de_nuevo` sin escribir; la versión 1 no cambia nunca.
// Rojo: sin R-STD en el dominio ni perfil en `entornoDeReglas` (T8, T12): `agregar` no devuelve el hallazgo y `aceptar` con regla R-STD no
// es una regla conocida (400 `solicitud_invalida`); la lista de reglas del motor tampoco la trae.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accionCompraRespuestaSchema, informeMasivaSchema } from "@contapp/shared";
import {
  abrirBancoReglas,
  base,
  cumple,
  RUTA_MOTOR,
  type Actor,
  type BancoReglas,
  type Estudio,
} from "../../../test/soporte-reglas.js";
import { COLUMNAS } from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoReglas;
let E: Estudio;
let G: Estudio; // su propio estudio: apagar R-STD no afecta a las demás pruebas
let contador: Actor;
let admin: Actor;
let contadorG: Actor;

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  G = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  admin = await v.b.c.p.b.miembro(G.tenantId, "admin");
  contadorG = await v.b.c.p.b.miembro(G.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
type Perfil = { zona: "general" | "amazonia"; ventasExoneradas: boolean; ventasMixtas: boolean };
const AMAZONIA: Perfil = { zona: "amazonia", ventasExoneradas: true, ventasMixtas: false };
const doc = (n: number): string => `20700${String(n).padStart(6, "0")}`;
let secuencia = 0;

/** Cliente del estudio con el perfil dado (por omisión, el que cumple U-4). */
async function clienteConPerfil(p: Perfil = AMAZONIA, e: Estudio = E, quien: Actor = contador): Promise<Cliente> {
  const c = await v.cliente(e, { responsable: quien.id });
  await v.b.sql("update cliente set zona = $2, ventas_exoneradas = $3, ventas_mixtas = $4 where id = $1", [c.id, p.zona, p.ventasExoneradas, p.ventasMixtas]);
  return c;
}
const post = (a: Actor, c: Cliente, ruta: string, cuerpo?: unknown) => v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo ?? {});
const get = (a: Actor, c: Cliente, ruta = "") => v.llamar(a, "GET", `${base(c.id)}${ruta}`);

interface OpcionesFila {
  doc?: string;
  montos?: Record<string, string>;
  moneda?: "PEN" | "USD";
  tipoCambio?: string;
}
/** Agrega una compra a mano (la evaluación de reglas corre al agregarla) y devuelve la fila de la respuesta. */
async function agregar(a: Actor, c: Cliente, o: OpcionesFila = {}): Promise<any> {
  secuencia += 1;
  const r = await post(a, c, "", {
    tipo: "01",
    serie: "F077",
    numero: String(secuencia),
    proveedor: { tipo: "6", numero: o.doc ?? doc(secuencia), razonSocial: `PROVEEDOR STD ${secuencia} SAC` },
    fecha: "2026-10-15",
    moneda: o.moneda ?? "PEN",
    ...(o.tipoCambio === undefined ? {} : { tipoCambio: o.tipoCambio }),
    montos: o.montos ?? { biDg: "100.00", igvDg: "18.00" },
  });
  expect(r.status, r.text).toBe(201);
  return r.body.fila;
}
const reglasDe = (fila: any): string[] => (fila.hallazgos as any[]).map((h) => h.regla);
const std = (fila: any): any => (fila.hallazgos as any[]).find((h) => h.regla === "R-STD");

/** Los montos de la versión `n` de una compra, sin ids ni fechas, para comparar dos caminos al mismo resultado. */
async function montosDe(id: string, n: number): Promise<Record<string, unknown>> {
  const x = (await v.versiones(id)).find((f) => f.n === n)!;
  return { ...Object.fromEntries([...COLUMNAS, "total"].map((k) => [k, (x as any)[k]])), excluida: x.excluida, clasificada: x.clasificada };
}

/**
 * Control de los casos negativos: un cliente que cumple U-4 SÍ recibe R-STD con una fila corriente. Sin él, «no aparece» pasaría también
 * cuando la regla aún no existe.
 */
async function conControl(o: OpcionesFila = {}): Promise<void> {
  const ok = await clienteConPerfil();
  expect(reglasDe(await agregar(contador, ok, o)), "control: un cliente que cumple U-4 sí la recibe").toContain("R-STD");
}

// --- CA-9 · cuándo aparece ------------------------------------------------------------------------------------------------------

describe("CA-9 · R-STD aparece solo cuando cumple todo el criterio (D-8, U-4)", () => {
  it("cliente de la selva con ventas exoneradas, sin mixtas: una compra DG de un proveedor sin regla trae R-STD «DNG por perfil del cliente»", async () => {
    const c = await clienteConPerfil();
    const fila = await agregar(contador, c);
    const h = std(fila);
    expect(h, JSON.stringify(fila.hallazgos)).toBeDefined();
    expect(cumple("hallazgoVistaSchema", h), JSON.stringify(h)).toBe(true);
    expect(h).toMatchObject({
      regla: "R-STD",
      destino: "DNG",
      explicacion: "DNG por perfil del cliente",
      requiereConfirmacion: false,
      dato: null,
      masiva: true,
    });
    expect(h.sugerencia).toEqual({ tipo: "clasificar" });
    expect((await v.hallazgosDe(fila.id, 1)).map((x: any) => x.regla)).toContain("R-STD"); // queda guardado, como los demás
  });

  it.each([
    ["zona general con ventas exoneradas", { zona: "general", ventasExoneradas: true, ventasMixtas: false }],
    ["Amazonía sin ventas exoneradas", { zona: "amazonia", ventasExoneradas: false, ventasMixtas: false }],
    ["Amazonía, exoneradas pero con ventas mixtas", { zona: "amazonia", ventasExoneradas: true, ventasMixtas: true }],
    ["perfil por defecto (general, sin exoneradas ni mixtas)", { zona: "general", ventasExoneradas: false, ventasMixtas: false }],
  ] as const)("cliente fuera del criterio (%s): ninguna sugerencia R-STD", async (_n, perfil) => {
    await conControl();
    const c = await clienteConPerfil(perfil);
    const fila = await agregar(contador, c);
    expect(reglasDe(fila)).not.toContain("R-STD");
    expect((await v.hallazgosDe(fila.id, 1)).map((x: any) => x.regla)).not.toContain("R-STD");
  });

  it.each(["DNG", "DG", "DGNG"] as const)("proveedor con regla aprendida activa de destino %s (también DG): sin R-STD", async (destino) => {
    const c = await clienteConPerfil();
    const numero = doc(500 + secuencia++);
    await conControl({ doc: numero }); // el mismo proveedor, sin regla, en otro cliente que cumple U-4, sí la recibe
    await v.sembrarRegla(E.tenantId, c.id, { docNumero: numero, destino, usuarioId: E.titular.id });
    const fila = await agregar(contador, c, { doc: numero });
    expect(reglasDe(fila)).not.toContain("R-STD");
  });

  it("una regla inactiva o eliminada del proveedor no lo saca de R-STD (solo cuenta la regla activa)", async () => {
    const c = await clienteConPerfil();
    const inactiva = doc(600 + secuencia++);
    const eliminada = doc(600 + secuencia++);
    await v.sembrarRegla(E.tenantId, c.id, { docNumero: inactiva, destino: "DG", activa: false, usuarioId: E.titular.id });
    await v.sembrarRegla(E.tenantId, c.id, { docNumero: eliminada, destino: "DG", eliminada: true, usuarioId: E.titular.id });
    expect(reglasDe(await agregar(contador, c, { doc: inactiva }))).toContain("R-STD");
    expect(reglasDe(await agregar(contador, c, { doc: eliminada }))).toContain("R-STD");
  });

  it("la regla del proveedor en OTRO cliente del estudio no cuenta: R-STD sigue en este", async () => {
    const c = await clienteConPerfil();
    const otro = await clienteConPerfil();
    const numero = doc(700 + secuencia++);
    await v.sembrarRegla(E.tenantId, otro.id, { docNumero: numero, destino: "DG", usuarioId: E.titular.id });
    expect(reglasDe(await agregar(contador, c, { doc: numero }))).toContain("R-STD");
  });

  it.each([
    ["ya en DNG", { biDng: "100.00", igvDng: "18.00" }, false],
    ["sin base gravada (solo no gravado)", { noGravado: "50.00" }, false],
    ["solo base de DGNG", { biDgng: "100.00", igvDgng: "18.00" }, true],
    ["base de DG y de DNG a la vez (queda base fuera de DNG)", { biDg: "60.00", igvDg: "10.80", biDng: "40.00", igvDng: "7.20" }, true],
  ] as const)("fila %s: R-STD = %s", async (_n, montos, esperada) => {
    await conControl();
    const c = await clienteConPerfil();
    const fila = await agregar(contador, c, { montos: montos as unknown as Record<string, string> });
    expect(reglasDe(fila).includes("R-STD")).toBe(esperada);
  });

  it("convive con R-NEW en la misma fila (proveedor nuevo del cliente)", async () => {
    const c = await clienteConPerfil();
    const fila = await agregar(contador, c);
    expect(reglasDe(fila)).toEqual(expect.arrayContaining(["R-NEW", "R-STD"]));
  });

  it("el listado y la lupa de la fila muestran el hallazgo guardado (la grilla puede filtrar y aceptar por R-STD)", async () => {
    const c = await clienteConPerfil();
    const fila = await agregar(contador, c);
    const lista = await get(contador, c);
    expect(lista.status, lista.text).toBe(200);
    const enLista = (lista.body.filas as any[]).find((f) => f.id === fila.id);
    expect(enLista.hallazgos.map((h: any) => h.regla)).toContain("R-STD");
    const lupa = await get(contador, c, `/${fila.id}/detalle`);
    if (lupa.status === 200) expect(JSON.stringify(lupa.body)).toContain("R-STD");
  });
});

// --- CA-9 · aceptar --------------------------------------------------------------------------------------------------------------

describe("CA-9 · aceptar R-STD da los mismos montos que clasificar a mano en DNG (RF-113, U-3)", () => {
  const aceptar = (c: Cliente, id: string, o: Record<string, unknown> = {}) =>
    post(contador, c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-STD", ...o });
  const clasificar = (c: Cliente, id: string) => post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });

  it.each([
    ["gravada común en PEN", { montos: { biDg: "100.00", igvDg: "18.00" } }],
    ["con base en DG y en DGNG a la vez, en USD con tipo de cambio", { moneda: "USD" as const, tipoCambio: "3.750", montos: { biDg: "80.00", igvDg: "14.40", biDgng: "20.00", igvDgng: "3.60" } }],
    ["solo DGNG", { montos: { biDgng: "250.00", igvDgng: "45.00" } }],
    ["con ICBPER y no gravado", { montos: { biDg: "100.00", igvDg: "18.00", icbper: "0.50", noGravado: "10.00" } }],
  ] as const)("%s: aceptar sin `confirmar` ni `dato` (200) = clasificar DNG", async (_n, o) => {
    const c = await clienteConPerfil();
    const a = await agregar(contador, c, o as OpcionesFila);
    const b = await agregar(contador, c, o as OpcionesFila);
    const antesV1 = await montosDe(a.id, 1);

    const r = await aceptar(c, a.id);
    expect(r.status, r.text).toBe(200);
    expect(accionCompraRespuestaSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(r.body.fila).toMatchObject({ id: a.id, version: 2, clasificada: true });
    const m = await clasificar(c, b.id);
    expect(m.status, m.text).toBe(200);

    expect(await montosDe(a.id, 2)).toEqual(await montosDe(b.id, 2));
    expect((await v.versiones(a.id))[1]).toMatchObject({ n: 2, accion: "sugerencia", clasificada: true, biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00" });
    expect(r.body.fila.montos).toEqual(m.body.fila.montos);
    expect(r.body.fila.hallazgos.map((h: any) => h.regla)).not.toContain("R-STD"); // no vuelve a sugerirse
    expect(await montosDe(a.id, 1)).toEqual(antesV1); // la versión 1 no cambia (RNF-052)
  });

  it("aceptar con `confirmar: true` también vale (sin confirmación requerida), y una versionBase vieja es 409 version_obsoleta", async () => {
    const c = await clienteConPerfil();
    const a = await agregar(contador, c);
    expect((await aceptar(c, a.id, { confirmar: true })).status).toBe(200);
    const vieja = await aceptar(c, a.id, { versionBase: 1 });
    expect(vieja.status, vieja.text).toBe(409);
    expect(vieja.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
  });

  it("no inserta en regla_confirmacion (D-7/CA-10) aunque el aporte esté encendido y el proveedor sea un RUC 20", async () => {
    const c = await clienteConPerfil();
    await v.fijarAporteBd(E.tenantId, true);
    const a = await agregar(contador, c);
    const antes = (await v.confirmacionesBd(E.tenantId)).length;
    expect((await aceptar(c, a.id)).status).toBe(200);
    expect((await v.confirmacionesBd(E.tenantId)).length).toBe(antes);
  });

  it("tras aceptar se ofrece «Recordar» como en 021: la regla de contador se crea con 200", async () => {
    const c = await clienteConPerfil();
    const a = await agregar(contador, c);
    expect((await aceptar(c, a.id)).status).toBe(200);
    const r = await v.http(contador, "POST", `/clientes/${c.id}/reglas/recordar`, { compraIds: [a.id], destino: "DNG", versionBase: null });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ destino: "DNG", activa: true, version: 1 });
  });

  it("masiva por regla: `masivas/aceptar {regla: \"R-STD\"}` de tres filas = `masivas/clasificar DNG` de tres iguales", async () => {
    const c = await clienteConPerfil();
    const variantes: OpcionesFila[] = [
      { montos: { biDg: "100.00", igvDg: "18.00" } },
      { moneda: "USD", tipoCambio: "3.750", montos: { biDg: "80.00", igvDg: "14.40", biDgng: "20.00", igvDgng: "3.60" } },
      { montos: { biDgng: "250.00", igvDgng: "45.00" } },
    ];
    const a: any[] = [];
    const b: any[] = [];
    for (const o of variantes) a.push(await agregar(contador, c, o));
    for (const o of variantes) b.push(await agregar(contador, c, o));
    const items = (fs: any[]) => fs.map((f) => ({ compraId: f.id, versionBase: 1 }));

    const m = await post(contador, c, "/masivas/aceptar", { items: items(a), regla: "R-STD" });
    expect(m.status, m.text).toBe(200);
    expect(informeMasivaSchema.safeParse(m.body).success, m.text).toBe(true);
    expect(m.body).toMatchObject({ aplicadas: 3, rechazadas: [] });
    expect(m.body.operacionId).toEqual(expect.any(String));
    const k = await post(contador, c, "/masivas/clasificar", { items: items(b), destino: "DNG" });
    expect(k.status, k.text).toBe(200);
    expect(k.body).toMatchObject({ aplicadas: 3, rechazadas: [] });
    for (let i = 0; i < 3; i++) expect(await montosDe(a[i].id, 2), `variante ${i}`).toEqual(await montosDe(b[i].id, 2));
    // Una sola operación para las tres (deshacer las revierte juntas).
    const ops = (await v.operaciones(c.id)).filter((o: any) => o.id === m.body.operacionId);
    expect(ops).toHaveLength(1);
  });

  it("masiva: una fila que ya no tiene R-STD (clasificada a mano en otra pestaña) se rechaza y las demás se aplican", async () => {
    const c = await clienteConPerfil();
    const buena = await agregar(contador, c);
    const mala = await agregar(contador, c);
    expect((await clasificar(c, mala.id)).status).toBe(200);
    const m = await post(contador, c, "/masivas/aceptar", {
      items: [
        { compraId: buena.id, versionBase: 1 },
        { compraId: mala.id, versionBase: 1 },
      ],
      regla: "R-STD",
    });
    expect(m.status, m.text).toBe(200);
    expect(m.body.aplicadas).toBe(1);
    expect(m.body.rechazadas).toEqual([{ compraId: mala.id, codigo: "version_obsoleta" }]);
  });

  it("la masiva con R-STD de filas sin ese hallazgo (ya DNG) las rechaza como revisar_de_nuevo y no escribe", async () => {
    const c = await clienteConPerfil();
    await conControl();
    const buena = await agregar(contador, c); // control: una fila con R-STD del mismo cliente sí se acepta en masa
    expect((await post(contador, c, "/masivas/aceptar", { items: [{ compraId: buena.id, versionBase: 1 }], regla: "R-STD" })).body.aplicadas).toBe(1);
    const dng = await agregar(contador, c, { montos: { biDng: "100.00", igvDng: "18.00" } });
    const antes = await v.foto(c.id);
    const m = await post(contador, c, "/masivas/aceptar", { items: [{ compraId: dng.id, versionBase: 1 }], regla: "R-STD" });
    expect(m.status, m.text).toBe(200);
    expect(m.body.aplicadas).toBe(0);
    expect(m.body.rechazadas).toEqual([{ compraId: dng.id, codigo: "revisar_de_nuevo" }]);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("aceptar R-STD de una fila sin ese hallazgo: 409 revisar_de_nuevo y no escribe (la regla R-STD es conocida: no es 400)", async () => {
    const c = await clienteConPerfil();
    const buena = await agregar(contador, c); // control: una fila con R-STD del mismo cliente sí se acepta
    expect((await aceptar(c, buena.id)).status).toBe(200);
    const dng = await agregar(contador, c, { montos: { biDng: "100.00", igvDng: "18.00" } });
    const antes = await v.foto(c.id);
    const r = await aceptar(c, dng.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

// --- CA-10 · clasificar a mano y apagar -----------------------------------------------------------------------------------------

describe("CA-10 · tras clasificar a mano no vuelve a sugerirse; apagar R-STD en el estudio (RF-089)", () => {
  it("clasificar a mano (a DGNG, para que quede base fuera de DNG) quita R-STD de la fila y no reaparece al editarla; aceptar con la versión nueva es 409 revisar_de_nuevo", async () => {
    const c = await clienteConPerfil();
    const a = await agregar(contador, c);
    expect(reglasDe(a)).toContain("R-STD");
    const k = await post(contador, c, `/${a.id}/clasificar`, { versionBase: 1, destino: "DGNG" });
    expect(k.status, k.text).toBe(200);
    expect(k.body.fila.clasificada).toBe(true);
    expect(k.body.fila.hallazgos.map((h: any) => h.regla)).not.toContain("R-STD");
    expect((await v.hallazgosDe(a.id, 2)).map((h: any) => h.regla)).not.toContain("R-STD");
    // Una edición posterior (versión 3) tampoco la vuelve a sugerir: sigue clasificada por el contador.
    const e = await post(contador, c, `/${a.id}/editar`, { versionBase: 2, cambios: { biDgng: "90.00", igvDgng: "16.20" } });
    expect(e.status, e.text).toBe(200);
    expect(e.body.fila.hallazgos.map((h: any) => h.regla)).not.toContain("R-STD");
    const antes = await v.foto(c.id);
    const r = await post(contador, c, `/${a.id}/sugerencias/aceptar`, { versionBase: 3, regla: "R-STD" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("R-STD aparece en la lista de reglas del motor del estudio (antes de R-HIS), encendida por defecto y con descripción simple", async () => {
    await conControl(); // el catálogo ya la lista (dominio de 025), pero la regla debe además evaluarse con el perfil
    const r = await v.http(admin, "GET", RUTA_MOTOR);
    expect(r.status, r.text).toBe(200);
    const reglas = r.body.reglas as any[];
    const std = reglas.find((x) => x.codigo === "R-STD");
    expect(std, r.text).toBeDefined();
    expect(std.activa).toBe(true);
    expect(std.descripcion).toMatch(/DNG/);
    expect(reglas.map((x) => x.codigo).indexOf("R-STD")).toBeLessThan(reglas.map((x) => x.codigo).indexOf("R-HIS"));
  });

  it("apagada en el estudio: las compras nuevas no la traen; las ya guardadas no se borran y aceptarlas es 409 revisar_de_nuevo; al encenderla vuelve", async () => {
    const c = await clienteConPerfil(AMAZONIA, G, contadorG);
    const antes = await agregar(contadorG, c); // guardada con R-STD encendida
    expect(reglasDe(antes)).toContain("R-STD");
    const apagar = (activa: boolean) => v.http(admin, "PUT", `${RUTA_MOTOR}/R-STD`, { activa });
    const off = await apagar(false);
    expect(off.status, off.text).toBe(200);
    try {
      expect(off.body.reglas.find((x: any) => x.codigo === "R-STD")).toMatchObject({ activa: false });
      const nueva = await agregar(contadorG, c);
      expect(reglasDe(nueva)).not.toContain("R-STD");
      expect((await v.hallazgosDe(antes.id, 1)).map((h: any) => h.regla)).toContain("R-STD"); // lo guardado no se borra
      const fotoAntes = await v.foto(c.id);
      const r = await post(contadorG, c, `/${antes.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-STD" });
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
      const m = await post(contadorG, c, "/masivas/aceptar", { items: [{ compraId: antes.id, versionBase: 1 }], regla: "R-STD" });
      expect(m.status, m.text).toBe(200);
      expect(m.body.aplicadas).toBe(0);
      expect(m.body.rechazadas).toEqual([{ compraId: antes.id, codigo: "revisar_de_nuevo" }]);
      expect(await v.foto(c.id)).toEqual(fotoAntes);
    } finally {
      expect((await apagar(true)).status).toBe(200);
    }
    expect(reglasDe(await agregar(contadorG, c))).toContain("R-STD");
  });
});

// --- CA-11 · el perfil se lee al evaluar ----------------------------------------------------------------------------------------

describe("CA-11 · cambiar el perfil después de cargar no toca lo guardado; rige desde la evaluación siguiente (D-9, RNF-052)", () => {
  it("con la compra ya guardada, pasar el cliente a «general» no cambia versiones ni hallazgos; aceptar R-STD pide revisar de nuevo y, vuelto el perfil, se acepta", async () => {
    const c = await clienteConPerfil();
    const a = await agregar(contador, c);
    const versionesAntes = await v.versiones(a.id);
    const hallazgosAntes = await v.hallazgosDe(a.id, 1);
    expect(hallazgosAntes.map((h: any) => h.regla)).toContain("R-STD");

    await v.b.sql("update cliente set zona = 'general', ventas_exoneradas = false where id = $1", [c.id]);
    expect(await v.versiones(a.id)).toEqual(versionesAntes); // solo inserción: nada cambia
    expect(await v.hallazgosDe(a.id, 1)).toEqual(hallazgosAntes);
    const lista = await get(contador, c);
    expect((lista.body.filas as any[]).find((f) => f.id === a.id).hallazgos.map((h: any) => h.regla)).toContain("R-STD");

    const antes = await v.foto(c.id);
    const r = await post(contador, c, `/${a.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-STD" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
    // Una compra nueva con el perfil actual ya no la trae.
    expect(reglasDe(await agregar(contador, c))).not.toContain("R-STD");

    await v.b.sql("update cliente set zona = 'amazonia', ventas_exoneradas = true where id = $1", [c.id]);
    expect((await post(contador, c, `/${a.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-STD" })).status).toBe(200);
  });

  it("marcar el perfil DESPUÉS de cargar: la compra ya guardada sin R-STD no cambia; la siguiente evaluación (compra nueva) sí la sugiere; la versión 1 de la vieja es idéntica", async () => {
    const c = await clienteConPerfil({ zona: "general", ventasExoneradas: false, ventasMixtas: false });
    const vieja = await agregar(contador, c);
    expect(reglasDe(vieja)).not.toContain("R-STD");
    const v1 = (await v.versiones(vieja.id))[0];
    const hallazgos = await v.hallazgosDe(vieja.id, 1);

    await v.b.sql("update cliente set zona = 'amazonia', ventas_exoneradas = true, ventas_mixtas = false where id = $1", [c.id]);
    expect((await v.versiones(vieja.id))[0]).toEqual(v1);
    expect(await v.hallazgosDe(vieja.id, 1)).toEqual(hallazgos);
    expect(reglasDe(await agregar(contador, c))).toContain("R-STD");
  });
});
