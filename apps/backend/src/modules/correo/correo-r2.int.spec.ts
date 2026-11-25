/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos y filas de BD dinámicos en pruebas */
// Spec 028 · T19 (correcciones de la ronda adversarial 2, rojo; tester · sonnet). Baja pública por HTTP con PG real. H-028-2-8: la baja
// de un clic de RFC 8058 acepta también `multipart/form-data` con el campo `List-Unsubscribe=One-Click` (RFC 8058 §3.1: el cliente de
// correo SHOULD mandarlo así; el urlencoded es MAY), con el mismo comportamiento que el urlencoded: sin `Origin`, 200 `{}` siempre, token
// de un solo uso, una sola baja auditada, y cualquier otro cuerpo sin efecto. La prueba principal (multipart exacto) la fija T18
// (`correo-r2.adv.int.spec.ts`); aquí van las variantes y el control de que lo demás no cambia. Decisiones del 2026-11-24 (tasks.md, T19).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import { auditoriaPreferencia, sembrarToken, type TipoCorreo } from "../../../test/soporte-correo.js";
import { ipUnica, type Resp } from "../../../test/soporte.js";

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
const efectiva = async (u: Actor, tipo: TipoCorreo = "buzon_critico"): Promise<boolean> =>
  (await sql("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [u.tenantId, u.id, tipo]))[0].v;
const usuario = (rol: RolSistema = "contador"): Promise<Actor> => b.miembro(E.tenantId, rol, { sesion: false });
const token = (u: Actor, tipo: TipoCorreo = "buzon_critico") => sembrarToken(sql, { tenantId: u.tenantId, usuarioId: u.id, tipo });
const bajasPorEnlace = async (u: Actor): Promise<number> =>
  (await auditoriaPreferencia(sql, u.tenantId, u.id)).filter((f: any) => f.datos?.origen === "enlace").length;

/** Cuerpo `multipart/form-data` con los campos dados, como lo arma un cliente de correo (CRLF, sin `Origin`). */
function multipart(campos: [string, string][], limite = `----contapp${randomBytes(8).toString("hex")}`): { limite: string; cuerpo: string } {
  const partes = campos.map(([n, v]) => `--${limite}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`).join("");
  return { limite, cuerpo: `${partes}--${limite}--\r\n` };
}
const pedirMultipart = (ruta: string, campos: [string, string][], tipo = "multipart/form-data", entreComillas = false): Promise<Resp> => {
  const { limite, cuerpo } = multipart(campos);
  return b.h.pedir({
    metodo: "POST",
    ruta,
    cuerpo,
    cabeceras: { "Content-Type": `${tipo}; boundary=${entreComillas ? `"${limite}"` : limite}` },
    origen: null,
    ip: ip(),
  });
};

describe("T19 · H-028-2-8: baja de un clic en multipart/form-data (RFC 8058 §3.1)", () => {
  it("apaga solo el tipo del token, audita una sola baja `enlace`, responde 200 `{}` y no necesita `Origin`", async () => {
    const u = await usuario();
    const t = await token(u, "buzon_critico");
    const r = await pedirMultipart(`/correo/baja?t=${t.token}`, [["List-Unsubscribe", "One-Click"]]);
    expect({ status: r.status, cuerpo: r.body }).toEqual({ status: 200, cuerpo: {} });
    expect(await efectiva(u, "buzon_critico"), "el tipo del token queda apagado").toBe(false);
    expect(await efectiva(u, "credencial_invalida"), "los demás tipos no se tocan").toBe(true);
    const bajas = (await auditoriaPreferencia(sql, u.tenantId, u.id)).filter((f: any) => f.datos?.origen === "enlace");
    expect(bajas.map((f: any) => f.datos)).toEqual([{ tipo: "buzon_critico", de: true, a: false, origen: "enlace" }]);
  });

  it("el `Content-Type` en mayúsculas y el `boundary` entre comillas también valen", async () => {
    const u = await usuario();
    const t = await token(u);
    const r = await pedirMultipart(`/correo/baja?t=${t.token}`, [["List-Unsubscribe", "One-Click"]], "MULTIPART/FORM-DATA", true);
    expect(r.status).toBe(200);
    expect(await efectiva(u)).toBe(false);
    expect(await bajasPorEnlace(u)).toBe(1);
  });

  it("token de un solo uso: tres POST multipart a la vez con el mismo token dan 200 y una sola baja auditada", async () => {
    const u = await usuario();
    const t = await token(u);
    const rs = await Promise.all([1, 2, 3].map(() => pedirMultipart(`/correo/baja?t=${t.token}`, [["List-Unsubscribe", "One-Click"]])));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await efectiva(u)).toBe(false);
    expect(await bajasPorEnlace(u)).toBe(1);
    expect((await sql("select anulado_en from correo_baja_token where hash = $1", [t.hash]))[0].anulado_en).not.toBeNull();
  });

  it.each([
    ["otro valor del campo", [["List-Unsubscribe", "Otro"]] as [string, string][]],
    ["otro nombre de campo", [["unsubscribe", "One-Click"]] as [string, string][]],
    ["sin campos", [] as [string, string][]],
  ])("multipart con %s: 200 `{}` sin efectos (como un urlencoded que no es el exacto)", async (_n, campos) => {
    const u = await usuario();
    const t = await token(u);
    const r = await pedirMultipart(`/correo/baja?t=${t.token}`, campos);
    expect({ status: r.status, cuerpo: r.body }).toEqual({ status: 200, cuerpo: {} });
    expect(await efectiva(u), "no debía apagar nada").toBe(true);
    expect(await bajasPorEnlace(u)).toBe(0);
    expect((await sql("select anulado_en from correo_baja_token where hash = $1", [t.hash]))[0].anulado_en, "el token no se gasta").toBeNull();
  });

  it("token inexistente, sin `?t=` o alterado: misma respuesta 200 `{}` que con uno válido (sin diferencia observable)", async () => {
    const u = await usuario();
    const t = await token(u);
    const valido = await pedirMultipart(`/correo/baja?t=${t.token}`, [["List-Unsubscribe", "One-Click"]]);
    const alterado = await pedirMultipart(`/correo/baja?t=${t.token.slice(0, -1)}${t.token.endsWith("A") ? "B" : "A"}`, [["List-Unsubscribe", "One-Click"]]);
    const inexistente = await pedirMultipart(`/correo/baja?t=${randomBytes(32).toString("base64url")}`, [["List-Unsubscribe", "One-Click"]]);
    const sinToken = await pedirMultipart("/correo/baja", [["List-Unsubscribe", "One-Click"]]);
    for (const r of [valido, alterado, inexistente, sinToken]) expect({ status: r.status, cuerpo: r.body }).toEqual({ status: 200, cuerpo: {} });
  });

  it("controles: el JSON sin `Origin` sigue siendo 403 y no apaga nada (la exención es solo para los cuerpos de RFC 8058)", async () => {
    const u = await usuario();
    const t = await token(u);
    const r = await b.h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token: t.token }, origen: null, ip: ip() });
    expect(r.status).toBe(403);
    expect(await efectiva(u)).toBe(true);
    expect(await bajasPorEnlace(u)).toBe(0);
  });
});
