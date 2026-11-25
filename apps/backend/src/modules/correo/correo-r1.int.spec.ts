/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 028 · T16 (correcciones de la ronda adversarial 1, rojo; tester · sonnet). Baja pública por HTTP con PG real: token de un solo uso
// que además muere si el usuario cambia esa preferencia en la app (H-028-1-5), tope por IP solo contra abuso masivo de 500 cada 10 min
// (H-028-1-6; los 25 usuarios de una misma IP están en `correo-r1.adv.int.spec.ts` y el límite por token en `baja.int.spec.ts`) y exención de `OrigenGuard` solo para la variante de RFC 8058
// (H-028-1-7; la prueba cross-site con `Origin` ajeno está en `correo-r1.adv.int.spec.ts`). Decisiones del 2026-11-24 (tasks.md, resultado
// de T16). Solo pruebas, sin código de producción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import { auditoriaPreferencia, prefs, sembrarToken, tokenNuevo, type TipoCorreo } from "../../../test/soporte-correo.js";
import { ipUnica, type Peticion, type Resp } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
const ipsUsadas: string[] = [];

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  if (b && ipsUsadas.length > 0)
    await b.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [ipsUsadas]).catch(() => undefined);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const ip = (): string => {
  const x = ipUnica();
  ipsUsadas.push(x);
  return x;
};
/** Botón «Darme de baja» de `/baja`: JSON `{token}` con el origen propio (el arnés lo pone por omisión en los métodos que escriben). */
const baja = (token: unknown, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token }, ip: ip(), ...extra });
/** Cliente de correo (RFC 8058): POST a la URL de `List-Unsubscribe` sin `Origin` ni cookies. */
const unClic = (token: string, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({
    metodo: "POST",
    ruta: `/correo/baja?t=${token}`,
    cuerpo: "List-Unsubscribe=One-Click",
    cabeceras: { "Content-Type": "application/x-www-form-urlencoded" },
    origen: null,
    ip: ip(),
    ...extra,
  });
const efectiva = async (u: Actor, tipo: TipoCorreo = "buzon_critico"): Promise<boolean> =>
  (await sql("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [u.tenantId, u.id, tipo]))[0].v;
const usuario = (rol: RolSistema = "contador", sesion = false): Promise<Actor> => b.miembro(E.tenantId, rol, { sesion });
const token = (u: Actor, tipo: TipoCorreo = "buzon_critico") => sembrarToken(sql, { tenantId: u.tenantId, usuarioId: u.id, tipo });
/** Un token emitido ahora (como el de un correo recién enviado): `sembrarToken` los deja con una antigüedad de 1 min. */
const tokenReciente = async (u: Actor, tipo: TipoCorreo = "buzon_critico") => {
  const t = await token(u, tipo);
  await sql("update correo_baja_token set creado_en = clock_timestamp() where hash = $1", [t.hash]);
  return t;
};
const cambiar = async (u: Actor, rol: RolSistema, cambios: Parameters<typeof prefs>[1]) => {
  const r = await b.llamar(u, "PUT", "/cuenta/correo", prefs(rol, cambios));
  expect(r.status, r.text).toBe(200);
};
const cuantasBajas = async (u: Actor): Promise<number> =>
  (await auditoriaPreferencia(sql, u.tenantId, u.id)).filter((f: any) => f.datos?.origen === "enlace").length;

describe("T16 · H-028-1-5: el token de baja es de un solo uso y muere si el usuario cambia esa preferencia", () => {
  it("al usarse deja de valer: usar el de un tipo no gasta el de otro, y reactivar en la app no deja que el mismo token (ni otro anterior del mismo tipo) lo apague de nuevo", async () => {
    const u = await usuario("contador", true);
    const critico1 = await tokenReciente(u, "buzon_critico"); // dos correos de crítico: dos tokens del mismo tipo
    const critico2 = await tokenReciente(u, "buzon_critico");
    const clave = await tokenReciente(u, "credencial_invalida");
    expect((await unClic(critico1.token)).status).toBe(200);
    expect(await efectiva(u, "buzon_critico")).toBe(false);
    expect(await efectiva(u, "credencial_invalida"), "usar un token no gasta el de otro tipo").toBe(true);
    await cambiar(u, "contador", { buzonCritico: true }); // «Mi cuenta → Correo»: lo reactiva
    expect(await efectiva(u, "buzon_critico")).toBe(true);
    // El mismo correo reabierto por un escáner, o el otro correo de crítico recibido antes: ninguno vuelve a apagarlo.
    expect((await unClic(critico1.token)).status).toBe(200); // misma respuesta de siempre (no revela que se usó)
    expect((await baja(critico2.token)).status).toBe(200);
    expect(await efectiva(u, "buzon_critico"), "un token usado o anterior al cambio no debe apagar lo que el usuario reactivó").toBe(true);
    expect(await cuantasBajas(u)).toBe(1);
    // El token de otro tipo sigue vigente: apaga lo suyo.
    expect((await baja(clave.token)).status).toBe(200);
    expect(await efectiva(u, "credencial_invalida")).toBe(false);
    expect(await efectiva(u, "buzon_critico")).toBe(true);
  });

  it("si el usuario cambia esa preferencia en la app después de recibir el correo, el enlace sin usar deja de valer; cambiar otra o no cambiar nada no lo gasta; uno emitido después vale", async () => {
    const u = await usuario("contador", true);
    const antes = await tokenReciente(u, "buzon_critico");
    const otro = await tokenReciente(u, "credencial_invalida");
    const sinCambio = await usuario("contador", true);
    const tSinCambio = await tokenReciente(sinCambio, "buzon_critico");

    // Cambiar OTRA preferencia (el resumen) no toca los tokens de buzon_critico ni de credencial_invalida; guardar sin cambios tampoco.
    await cambiar(u, "contador", { resumen: true });
    await cambiar(sinCambio, "contador", {});
    expect((await baja(tSinCambio.token)).status).toBe(200);
    expect(await efectiva(sinCambio), "un guardado sin cambios no invalida el enlace").toBe(false);

    // Apaga y vuelve a encender buzon_critico en la app: el enlace recibido antes ya no sirve.
    await cambiar(u, "contador", { resumen: true, buzonCritico: false });
    await cambiar(u, "contador", { resumen: true, buzonCritico: true });
    expect(await efectiva(u)).toBe(true);
    const r = await unClic(antes.token);
    expect(r.status, r.text).toBe(200); // misma respuesta: ni siquiera dice que el enlace caducó
    expect(await efectiva(u), "el enlace emitido antes del cambio en la app no debe volver a apagar la preferencia").toBe(true);
    expect(await cuantasBajas(u)).toBe(0);

    // El token de OTRO tipo no se invalidó: el cambio fue solo de buzon_critico.
    expect((await baja(otro.token)).status).toBe(200);
    expect(await efectiva(u, "credencial_invalida")).toBe(false);
    expect(await efectiva(u)).toBe(true);

    // Un correo nuevo, emitido después del cambio, trae un token que sí vale.
    const despues = await tokenReciente(u, "buzon_critico");
    expect((await unClic(despues.token)).status).toBe(200);
    expect(await efectiva(u)).toBe(false);
    expect(await cuantasBajas(u)).toBe(2); // credencial_invalida y el token nuevo de buzon_critico
  });
});

describe("T16 · H-028-1-6: tope por IP solo contra abuso masivo (500 cada 10 min)", () => {
  it("pasadas 500 peticiones en 10 min la IP recibe 429 demasiados_intentos aun con un token bueno (página o RFC 8058) y no cambia nada; otra IP sí puede", async () => {
    const abusadora = ip();
    const u = await usuario();
    const tBueno = await token(u);
    const estados: number[] = [];
    for (let i = 0; i < 499; i++) estados.push((await unClic(tokenNuevo(), { ip: abusadora })).status);
    expect(new Set(estados), "las primeras 499 peticiones desde una IP no pueden recibir 429 (tokens distintos, ninguno repetido)").toEqual(new Set([200]));
    let bloqueada = 0;
    for (let i = 0; i < 6 && bloqueada !== 429; i++) bloqueada = (await baja(tokenNuevo(), { ip: abusadora })).status;
    expect(bloqueada, "el tope por IP debe cortar al llegar a 500 en 10 min").toBe(429);
    const conBueno = await baja(tBueno.token, { ip: abusadora });
    expect(conBueno.status).toBe(429);
    expect(conBueno.body).toEqual({ codigo: "demasiados_intentos" });
    expect((await unClic(tBueno.token, { ip: abusadora })).status).toBe(429);
    expect(await efectiva(u), "con 429 no se aplica la baja").toBe(true);
    expect((await baja(tBueno.token, { ip: ip() })).status).toBe(200);
    expect(await efectiva(u)).toBe(false);
  }, 180_000);
});

describe("T16 · H-028-1-7: OrigenGuard solo se exime para la variante de un clic de RFC 8058", () => {
  it("el POST JSON del botón sin Origin ni Sec-Fetch-Site (otra herramienta, un script) es 403 origen_invalido y no apaga nada; el mismo token con el origen propio sí", async () => {
    const u = await usuario();
    const t = await token(u);
    const sinOrigen = await baja(t.token, { origen: null });
    expect(sinOrigen.status, sinOrigen.text).toBe(403);
    expect(await efectiva(u), "el JSON sin origen no debe aplicar la baja").toBe(true);
    // Sec-Fetch-Site: none (navegación directa, no del propio sitio) con el JSON: tampoco.
    const directa = await baja(t.token, { origen: null, secFetchSite: "none" });
    expect(directa.status, directa.text).toBe(403);
    expect(await efectiva(u)).toBe(true);
    // Control: la misma petición desde el propio origen aplica (el botón de /baja).
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(u)).toBe(false);
  });

  it("la variante de RFC 8058 (urlencoded List-Unsubscribe=One-Click, sin Origin) sigue sin necesitar origen y aplica", async () => {
    const u = await usuario();
    const t = await token(u);
    const r = await unClic(t.token);
    expect(r.status, r.text).toBe(200);
    expect(await efectiva(u)).toBe(false);
  });
});
