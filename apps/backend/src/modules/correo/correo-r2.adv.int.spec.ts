/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 028 · T18 (ronda adversarial 2, adversario · opus). Baja pública por HTTP con PG real, sobre lo que cambió en T17: token de un
// solo uso consumido con el candado del usuario (carrera de clics), exención de `OrigenGuard` solo si el cuerpo no es JSON (`Content-Type`
// engañosos) y la variante de un clic de RFC 8058 tal como la mandan los clientes de correo. Solo pruebas: cada fallo es un hallazgo
// H-028-2-n (tasks.md, T18).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import { auditoriaPreferencia, sembrarToken, type TipoCorreo } from "../../../test/soporte-correo.js";
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
/** Botón «Darme de baja» de `/baja`: JSON `{token}` desde el origen propio. */
const baja = (token: unknown, extra: Partial<Peticion> = {}): Promise<Resp> =>
  b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token }, ip: ip(), ...extra });
/** Cliente de correo (RFC 8058) con el cuerpo urlencoded: POST a la URL de `List-Unsubscribe` sin `Origin` ni cookies. */
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
/** Cuerpo y cabecera crudos, sin `Origin` (otra herramienta, un script o un servidor de correo). */
const crudo = (ruta: string, tipo: string | null, cuerpo: string): Promise<Resp> =>
  b.h.pedir({
    metodo: "POST",
    ruta,
    cuerpo,
    cabeceras: tipo === null ? {} : { "Content-Type": tipo },
    origen: null,
    ip: ip(),
  });
const efectiva = async (u: Actor, tipo: TipoCorreo = "buzon_critico"): Promise<boolean> =>
  (await sql("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [u.tenantId, u.id, tipo]))[0].v;
const usuario = (rol: RolSistema = "contador"): Promise<Actor> => b.miembro(E.tenantId, rol, { sesion: false });
const token = (u: Actor, tipo: TipoCorreo = "buzon_critico") => sembrarToken(sql, { tenantId: u.tenantId, usuarioId: u.id, tipo });
const bajasPorEnlace = async (u: Actor): Promise<number> =>
  (await auditoriaPreferencia(sql, u.tenantId, u.id)).filter((f: any) => f.datos?.origen === "enlace").length;

describe("T18 · token de un solo uso: clics simultáneos", () => {
  it("cuatro POST a la vez con el mismo token (botón ×2 y RFC 8058 ×2): todos 200, la preferencia queda apagada y hay UNA sola baja auditada", async () => {
    const u = await usuario();
    const t = await token(u);
    const rs = await Promise.all([baja(t.token), unClic(t.token), baja(t.token), unClic(t.token)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => JSON.stringify(r.body)))).toEqual(new Set(["{}"]));
    expect(await efectiva(u)).toBe(false);
    expect(await bajasPorEnlace(u)).toBe(1);
    const fila = await sql("select anulado_en from correo_baja_token where hash = $1", [t.hash]);
    expect(fila[0].anulado_en).not.toBeNull();
  });
});

describe("T18 · OrigenGuard: la exención depende del Content-Type", () => {
  it("todo Content-Type que el analizador lee como JSON exige origen (403) y todo lo demás sin el cuerpo exacto de RFC 8058 no hace nada (200); nada apaga sin origen", async () => {
    const u = await usuario();
    const t = await token(u);
    const json = JSON.stringify({ token: t.token });
    const comoJson = [
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "APPLICATION/JSON",
      "Application/Json; charset=utf-8",
    ];
    const noJson = ["text/plain", "text/json", "application/vnd.api+json", "application/x-www-form-urlencoded", "application/csp-report"];
    const estados: Record<string, number> = {};
    for (const ct of comoJson) estados[ct] = (await crudo("/correo/baja", ct, json)).status;
    for (const ct of noJson) estados[ct] = (await crudo(`/correo/baja?t=${t.token}`, ct, json)).status;
    estados["json vacío"] = (await crudo("/correo/baja", "application/json", "")).status;
    estados["sin Content-Type"] = (await crudo(`/correo/baja?t=${t.token}`, null, "")).status;
    expect(estados).toEqual({
      ...Object.fromEntries(comoJson.map((ct) => [ct, 403])),
      ...Object.fromEntries(noJson.map((ct) => [ct, 200])),
      "json vacío": 403,
      "sin Content-Type": 200,
    });
    expect(await efectiva(u), "una petición sin origen apagó la preferencia").toBe(true);
    expect(await bajasPorEnlace(u)).toBe(0);
    // Control: el botón desde el origen propio sí la apaga con el mismo token (no se gastó).
    expect((await baja(t.token)).status).toBe(200);
    expect(await efectiva(u)).toBe(false);
  });
});

describe("T18 · RFC 8058 tal como lo envían los clientes de correo", () => {
  it("el POST de un clic en multipart/form-data (lo que RFC 8058 §3.1 recomienda: SHOULD) apaga el tipo como el urlencoded", async () => {
    const u = await usuario();
    const t = await token(u);
    const limite = `----contapp${randomBytes(8).toString("hex")}`;
    const cuerpo = `--${limite}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${limite}--\r\n`;
    const r = await crudo(`/correo/baja?t=${t.token}`, `multipart/form-data; boundary=${limite}`, cuerpo);
    expect(r.status, r.text).toBe(200);
    expect(
      await efectiva(u),
      "la baja de un clic de un cliente que sigue RFC 8058 (multipart/form-data) responde 200 y no apaga nada: el usuario sigue recibiendo",
    ).toBe(false);
    expect(await bajasPorEnlace(u)).toBe(1);
  });
});
