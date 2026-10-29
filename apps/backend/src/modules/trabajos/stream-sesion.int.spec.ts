// T11b (008) · D22: el stream de estado no cuenta como actividad. PG y Redis reales. Las marcas de tiempo de la sesión
// se mueven en la BD desde el soporte (`fijarUsoDeSesion`), sin esperas de horas.
// Rojo: hoy la apertura y la revalidación pasan por `auth.sesion_validar` (vía `resolverSesion`), que renueva
// `ultimo_uso` si tiene > 5 min; el stream mantiene viva la sesión.
//
// Contrato fijado por estas pruebas (T11c):
//  - `GET /trabajos/stream` (apertura) y la revalidación periódica de `StreamService` validan con
//    `auth.sesion_consultar` (`resolverSesion(cookie, { renovar: false })`): no escriben `ultimo_uso` ni `tenant_activo`.
//  - Las demás rutas (p. ej. `GET /trabajos`) siguen renovando como en 004 D3.
//  - Con solo el stream abierto la sesión vence a las 2 h de inactividad: el stream se cierra en ≤ 10,5 s desde ese
//    vencimiento (revalidación cada 5 s) y la reconexión recibe 401 `sesion_invalida`. Una sesión ya vencida por
//    inactividad no se abre (401) ni se renueva.
//  - Cualquier otra petición del usuario en ese lapso renueva la sesión y el stream sigue abierto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  fijarUsoDeSesion,
  usoDeSesion,
  type BancoTrabajos,
  type ClienteSse,
} from "../../../test/soporte-trabajos.js";

let b: BancoTrabajos;
let E: Estudio;

const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const abrir = (a: Pick<Actor, "cookie" | "tenantId">): Promise<ClienteSse> =>
  abrirSse(b.h, { cookie: a.cookie, estudio: a.tenantId });
const abrirOk = async (a: Pick<Actor, "cookie" | "tenantId">): Promise<ClienteSse> => {
  const s = await abrir(a);
  expect(s.status, JSON.stringify(s.cuerpo)).toBe(200);
  return s;
};
const usuario = () => b.miembro(E.tenantId, "contador");

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  E = await b.estudio();
}, 60_000);
afterAll(async () => {
  cerrarSseAbiertos();
  await b?.cerrar();
});

describe("D22 · el stream no renueva la sesión", () => {
  it("abrir el stream y pasar ≥ 2 revalidaciones no cambia ultimo_uso; un GET /trabajos sí lo renueva", async () => {
    const u = await usuario();
    await fijarUsoDeSesion(b, u, "-10 minutes");
    const antes = await usoDeSesion(b, u);
    expect(antes.edadSeg).toBeGreaterThan(9 * 60);

    const s = await abrirOk(u);
    const t0 = Date.now();
    await pausa(11_500); // ≥ 2 revalidaciones de 5 s
    expect(s.cerrado, "el stream se cerró sin motivo").toBe(false);
    const durante = await usoDeSesion(b, u);
    expect(durante.marca, `ultimo_uso renovado por el stream tras ${Date.now() - t0} ms`).toBe(antes.marca);
    expect(durante.tenantActivo).toBe(antes.tenantActivo);
    s.cerrar();

    // Control: cualquier otra petición sigue renovando (004 D3), para que la igualdad de arriba no sea vacía.
    const r = await b.llamar(u, "GET", "/trabajos");
    expect(r.status).toBe(200);
    const despues = await usoDeSesion(b, u);
    expect(despues.marca).not.toBe(antes.marca);
    expect(despues.edadSeg).toBeLessThan(60);
  }, 40_000);

  it("con solo el stream abierto la sesión vence por inactividad: el stream se cierra en ≤ 10,5 s y la reconexión recibe 401", async () => {
    const u = await usuario();
    // A 4 s de cumplir las 2 h de inactividad: la apertura aún es válida; si el stream renovara, nunca vencería.
    await fijarUsoDeSesion(b, u, "-2 hours 4 seconds");
    const s = await abrirOk(u);
    const cerrado = await s.esperarCierre(10_500);
    expect(cerrado, "el stream siguió abierto: renovó la sesión y nunca venció por inactividad").toBe(true);

    const de = await abrir(u);
    expect(de.status).toBe(401);
    expect(de.cuerpo).toEqual({ codigo: "sesion_invalida" });
  }, 30_000);

  it("ultimo_uso llevado a hace 2 h 1 min con el stream abierto y sin otras peticiones: cierre en ≤ 10,5 s y la reconexión es 401", async () => {
    const u = await usuario();
    const s = await abrirOk(u);
    await fijarUsoDeSesion(b, u, "-121 minutes");
    expect(await s.esperarCierre(10_500), "el stream siguió abierto con la sesión vencida").toBe(true);
    const de = await abrir(u);
    expect(de.status).toBe(401);
    expect(de.cuerpo).toEqual({ codigo: "sesion_invalida" });
  }, 30_000);

  it("con otra petición del usuario en ese lapso la sesión se renueva y el stream sigue abierto", async () => {
    const u = await usuario();
    await fijarUsoDeSesion(b, u, "-2 hours 4 seconds");
    const s = await abrirOk(u);
    const r = await b.llamar(u, "GET", "/trabajos"); // actividad real del usuario: renueva
    expect(r.status).toBe(200);
    expect((await usoDeSesion(b, u)).edadSeg).toBeLessThan(60);
    expect(await s.esperarCierre(10_500), "el stream se cerró aunque el usuario tuvo actividad").toBe(false);
    s.cerrar();
    expect((await usoDeSesion(b, u)).edadSeg).toBeLessThan(70);
  }, 30_000);

  it("la apertura con la sesión ya vencida por inactividad es 401 y no la renueva", async () => {
    const u = await usuario();
    await fijarUsoDeSesion(b, u, "-121 minutes");
    const antes = await usoDeSesion(b, u);
    const s = await abrir(u);
    expect(s.status).toBe(401);
    expect(s.cuerpo).toEqual({ codigo: "sesion_invalida" });
    expect((await usoDeSesion(b, u)).marca).toBe(antes.marca);
  });

  it("la apertura de una sesión vigente con ultimo_uso de hace 10 min responde 200 sin tocar ultimo_uso", async () => {
    const u = await usuario();
    await fijarUsoDeSesion(b, u, "-10 minutes");
    const antes = await usoDeSesion(b, u);
    const s = await abrirOk(u);
    expect((await usoDeSesion(b, u)).marca).toBe(antes.marca);
    s.cerrar();
  });
});
