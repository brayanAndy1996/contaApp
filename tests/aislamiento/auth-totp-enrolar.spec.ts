// Spec 029 (T1, rojo hasta 0078) · CA-1, CA-3 (parcial), CA-6, CA-7: leer, iniciar el enrolamiento y confirmarlo.
// Contrato en `auth-totp-soporte.ts`. Rojo por: auth.totp_* aun no existe (SQLSTATE 42883) o falta la columna auth.sesion.factor.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioTotp, PASO, SQL, abrirAdmin, abrirApp, diez, exito, hash32, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(10);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");

describe("auth.totp_leer", () => {
  it("sin fila: cero filas (el usuario nunca inicio el enrolamiento)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    expect(await exito(llamar(app, SQL.leer, [u.id]))).toHaveLength(0);
  });

  it("con TOTP activo: una fila con las columnas del contrato; el cifrado es el guardado, tal cual (la BD no lo interpreta)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const cifrado = await esc.totpActivo(u.id, { ultimoPaso: 77n, version: 3 });
    const r = await exito(llamar(app, SQL.leer, [u.id]));
    expect(r).toHaveLength(1);
    expect(Object.keys(r[0])).toEqual([
      "activo_cifrado",
      "activo_version",
      "pendiente_cifrado",
      "pendiente_version",
      "pendiente_expira",
      "ultimo_paso",
      "activado_en",
    ]);
    expect(Buffer.compare(r[0].activo_cifrado, cifrado)).toBe(0);
    expect(r[0]).toMatchObject({ activo_version: 3, pendiente_cifrado: null, pendiente_expira: null });
    expect(String(r[0].ultimo_paso)).toBe("77");
    expect(r[0].activado_en).toBeInstanceOf(Date);
  });

  it("solo ve al usuario pedido: otro usuario con TOTP no aparece", async () => {
    const a = await esc.usuario({ estudios: [A()] });
    const b = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(b.id);
    expect(await exito(llamar(app, SQL.leer, [a.id]))).toHaveLength(0);
  });
});

describe("auth.totp_enrolar_iniciar (CA-1)", () => {
  it("crea la fila con el pendiente y vence en 10 min; no hay secreto activo todavia", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const cifrado = hash32();
    const r = await exito(llamar(app, SQL.enrolarIniciar, [u.id, cifrado, 2]));
    const exp = (r[0].pendiente_expira as Date).getTime();
    expect(exp - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const f = await esc.filaTotp(u.id);
    expect(f).toMatchObject({ activo_cifrado: null, activo_version: null, activado_en: null, pendiente_version: 2 });
    expect(Buffer.compare(f!.pendiente_cifrado, cifrado)).toBe(0);
    expect(String(f!.ultimo_paso)).toBe("0");
  });

  it("reemplaza el pendiente anterior (el viejo ya no se puede confirmar) y NO toca el secreto activo (re-enrolar)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const activo = await esc.totpActivo(u.id, { ultimoPaso: 5n });
    const p1 = hash32();
    const p2 = hash32();
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, p1, 1]));
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, p2, 1]));
    const f = await esc.filaTotp(u.id);
    expect(Buffer.compare(f!.pendiente_cifrado, p2)).toBe(0);
    expect(Buffer.compare(f!.activo_cifrado, activo)).toBe(0);
    expect(String(f!.ultimo_paso)).toBe("5");
  });
});

/** Sesion verificada o sin factor del usuario con un pendiente vigente, lista para confirmar. */
async function paraConfirmar(opts: { factor?: "verificado" | "sin_factor" | "pendiente"; venceHace?: string; conActivo?: boolean; ultimoPaso?: bigint } = {}) {
  const u = await esc.usuario({ estudios: [A()] });
  if (opts.conActivo) await esc.totpActivo(u.id, { ultimoPaso: opts.ultimoPaso ?? 0n });
  await esc.totpPendiente(u.id, { venceHace: opts.venceHace, conActivo: opts.conActivo });
  const s = await esc.sesionF(u.id, { factor: opts.factor ?? "sin_factor", tenant: A() });
  return { u, s };
}
const confirmar = (token: Buffer, paso: bigint, hashes: Buffer[], nuevo: Buffer) =>
  llamar(app, SQL.confirmar, [token, String(paso), hashes, nuevo]);

describe("auth.totp_confirmar (CA-1, U3, U4)", () => {
  it("activa: el pendiente pasa a activo, guarda el paso y los 10 hashes, deja el evento y rota la sesion a `verificado`", async () => {
    const { u, s } = await paraConfirmar();
    const antes = await esc.filaTotp(u.id);
    const hashes = diez();
    const nuevo = nuevoToken();
    const [fila] = await exito(confirmar(s.token, PASO, hashes, nuevo));
    expect(fila.sesion_id).toBeTruthy();
    const f = await esc.filaTotp(u.id);
    expect(Buffer.compare(f!.activo_cifrado, antes!.pendiente_cifrado)).toBe(0);
    expect(f).toMatchObject({ pendiente_cifrado: null, pendiente_expira: null, pendiente_version: null, activo_version: 1 });
    expect(String(f!.ultimo_paso)).toBe(String(PASO));
    expect(f!.activado_en).toBeInstanceOf(Date);
    const codigos = await esc.filasCodigos(u.id);
    expect(codigos).toHaveLength(10);
    expect(codigos.every((c) => c.usado_en === null)).toBe(true);
    expect(await esc.eventos(u.id)).toEqual(["totp_activado"]);
    const vieja = await esc.filaSesion(s.token);
    expect(vieja).toMatchObject({ motivo: "rotacion" });
    expect(vieja!.revocada_en).toBeInstanceOf(Date);
    const nueva = await esc.filaSesion(nuevo);
    expect(nueva).toMatchObject({ factor: "verificado", tenant_activo: A(), usuario_id: u.id, revocada_en: null });
    expect(nueva!.expira_absoluta.getTime()).toBe(vieja!.expira_absoluta.getTime());
    expect(nueva!.creada_en.getTime()).toBe(vieja!.creada_en.getTime());
  });

  it("revoca las OTRAS sesiones del usuario (motivo totp) y no toca las de otros usuarios", async () => {
    const { u, s } = await paraConfirmar();
    const otra = await esc.sesionF(u.id, { factor: "sin_factor" });
    const ajena = await esc.sesionF((await esc.usuario({ estudios: [A()] })).id);
    await exito(confirmar(s.token, PASO, diez(), nuevoToken()));
    expect(await esc.filaSesion(otra.token)).toMatchObject({ motivo: "totp" });
    expect((await esc.filaSesion(otra.token))!.revocada_en).toBeInstanceOf(Date);
    expect((await esc.filaSesion(ajena.token))!.revocada_en).toBeNull();
  });

  it("pendiente vencido: cero filas y nada cambia (CA-1: un pendiente vencido no se confirma)", async () => {
    const { u, s } = await paraConfirmar({ venceHace: "1 second" });
    expect(await exito(confirmar(s.token, PASO, diez(), nuevoToken()))).toHaveLength(0);
    expect(await esc.filaTotp(u.id)).toMatchObject({ activo_cifrado: null });
    expect(await esc.filasCodigos(u.id)).toHaveLength(0);
    expect(await esc.eventos(u.id)).toEqual([]);
    expect((await esc.filaSesion(s.token))!.revocada_en).toBeNull();
  });

  it("sin pendiente: cero filas", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const s = await esc.sesionF(u.id);
    expect(await exito(confirmar(s.token, PASO, diez(), nuevoToken()))).toHaveLength(0);
    await esc.totpActivo(u.id);
    expect(await exito(confirmar(s.token, PASO, diez(), nuevoToken()))).toHaveLength(0); // activo pero sin pendiente
  });

  it("sesion `pendiente` (login a medias) no puede confirmar: cero filas y sin efectos", async () => {
    const { u, s } = await paraConfirmar({ factor: "pendiente" });
    expect(await exito(confirmar(s.token, PASO, diez(), nuevoToken()))).toHaveLength(0);
    expect(await esc.filaTotp(u.id)).toMatchObject({ activo_cifrado: null });
  });

  it("sesion inexistente o revocada: cero filas", async () => {
    const { u } = await paraConfirmar();
    expect(await exito(confirmar(nuevoToken(), PASO, diez(), nuevoToken()))).toHaveLength(0);
    const rev = await esc.sesionF(u.id);
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [rev.id]);
    expect(await exito(confirmar(rev.token, PASO, diez(), nuevoToken()))).toHaveLength(0);
  });

  // Ajuste de 029 (T14, 0080, hallazgo r1b de T13): con TOTP activo, totp_confirmar ya no reemplaza el secreto (CA-1: re-enrolar exige un
  // codigo del vigente; el backend responde 409 `totp_activo` al enrolar). Antes esta prueba esperaba el reemplazo con un paso nuevo.
  it("re-enrolar con TOTP activo: totp_confirmar no reemplaza el secreto ni los codigos, con un paso viejo ni con uno nuevo", async () => {
    const { u, s } = await paraConfirmar({ conActivo: true, ultimoPaso: 100n, factor: "verificado" });
    await esc.codigos(u.id, 10);
    const viejos = (await esc.filasCodigos(u.id)).map((c) => c.hash.toString("hex"));
    const activo = (await esc.filaTotp(u.id))!.activo_cifrado as Buffer;
    // un paso <= ultimo_paso es un replay: no confirma
    expect(await exito(confirmar(s.token, 100n, diez(), nuevoToken()))).toHaveLength(0);
    expect((await esc.filaTotp(u.id))!.pendiente_cifrado).not.toBeNull();
    // un paso nuevo tampoco: hay TOTP activo
    expect(await exito(confirmar(s.token, 101n, diez(), nuevoToken()))).toHaveLength(0);
    expect(((await esc.filaTotp(u.id))!.activo_cifrado as Buffer).equals(activo)).toBe(true);
    expect(BigInt((await esc.filaTotp(u.id))!.ultimo_paso)).toBe(100n);
    const nuevos = (await esc.filasCodigos(u.id)).map((c) => c.hash.toString("hex"));
    expect(nuevos).toHaveLength(10);
    expect(nuevos.filter((h) => !viejos.includes(h))).toEqual([]);
  });

  it.each([
    ["9 hashes", () => diez().slice(0, 9)],
    ["11 hashes", () => [...diez(), hash32()]],
    ["vacio", () => []],
  ])("U4: con %s se rechaza (22023) y no cambia nada", async (_n, hashes) => {
    const { u, s } = await paraConfirmar();
    const r = await confirmar(s.token, PASO, hashes(), nuevoToken());
    expect(r.ok ? "ok" : r.code).toBe("22023");
    expect(await esc.filaTotp(u.id)).toMatchObject({ activo_cifrado: null });
    expect(await esc.filasCodigos(u.id)).toHaveLength(0);
  });

  it("hashes repetidos entre si: se rechaza (22023 o 23505) y no queda ninguno", async () => {
    const { u, s } = await paraConfirmar();
    const h = hash32();
    const r = await confirmar(s.token, PASO, [h, h, ...diez().slice(0, 8)], nuevoToken());
    expect(r.ok ? "ok" : r.code).toMatch(/^(22023|23505)$/);
    expect(await esc.filasCodigos(u.id)).toHaveLength(0);
    expect((await esc.filaTotp(u.id))!.activo_cifrado).toBeNull();
  });

  it("D3: dos confirmaciones concurrentes del mismo pendiente (misma sesion) activan una sola vez y dejan 10 codigos", async () => {
    const { u, s } = await paraConfirmar();
    const r = await Promise.all([
      llamar(app, SQL.confirmar, [s.token, String(PASO), diez(), nuevoToken()]),
      llamar(app, SQL.confirmar, [s.token, String(PASO), diez(), nuevoToken()]),
    ]);
    const filas = r.map((x) => (x.ok ? x.rows.length : 0));
    expect(filas.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await esc.filasCodigos(u.id)).toHaveLength(10);
    expect(await esc.eventos(u.id)).toEqual(["totp_activado"]);
  });
});
