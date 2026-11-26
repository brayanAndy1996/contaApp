// Spec 028 (T4, rojo): token de baja y baja sin sesión (R-7, R-10; CA-8) contra la BD real y con una `tx` falsa para las validaciones
// de forma y la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas:
//   crearTokenBaja(tx, envioId, hash)  (`packages/db/src/correo/baja.ts`, worker): `correo_baja_token_crear(p_envio, p_hash)`. Guarda
//     el hash SHA-256 (Buffer de 32 bytes) del token ligado a (estudio, usuario, tipo) del envío, con `vence_en` a 90 días de ahora
//     (reloj de la BD). 22023 si `hash` no es un Buffer de 32 bytes (sin ir a la BD); P0002 con un envío ajeno, inexistente o con el
//     id mal formado; 42501 si lo llama el backend. No devuelve nada (el token en claro nunca llega a la BD).
//   AuthRepo.aplicarBaja(hashHex)  (`packages/db/src/auth/repositorio.ts`, como `recuperacionConsumir`; se llama con `withAuth`):
//     `auth.correo_baja_aplicar($1::bytea)` con `Buffer.from(hashHex, "hex")`. `hashHex` son 64 caracteres hexadecimales; cualquier
//     otra cosa no hace nada (resuelve sin ir a la BD). Devuelve siempre `undefined`: no distingue un token válido de uno inexistente,
//     vencido o ya usado. Con el token vigente apaga SOLO el tipo de su (estudio, usuario) (el resumen incluido), audita
//     `correo.preferencia_cambiada` con `{tipo, de: true, a: false, origen: "enlace"}` y actor el usuario (R-10), es idempotente
//     (repetir no audita ni cambia nada) y nunca enciende un tipo. Un usuario que nunca guardó preferencias queda con ese tipo
//     apagado y los demás en su valor efectivo. De todo error de `pg` solo queda el SQLSTATE (AuthRepoError).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearAuthRepo } from "../auth/repositorio";
import { AuthRepoError } from "../auth/errores";
import { crearTokenBaja, leerPreferencias, tomarEnvio } from "./index";
import {
  abrirArnes,
  asignarCliente,
  capturarCriticos,
  crearResumenDelDia,
  diaLima,
  envioPendiente,
  falla,
  fijar,
  invalidarCredencial,
  pruebasTraduccion,
  tokenDeBaja,
  type Arnes,
  type Estudio,
  type UsuarioSembrado,
} from "./soporte-prueba";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const NO_EXISTE = "00000000-0000-4000-8000-00000000dead";
const HEX = createHash("sha256").update("token-de-prueba").digest("hex");

/** `aplicarBaja` por `withAuth`; si aún no existe en `AuthRepo`, la prueba falla con «no implementado». */
async function aplicarBaja(hashHex: string): Promise<unknown> {
  return h.backend.withAuth(async (a) => {
    const f = (
      a as unknown as { aplicarBaja?: (x: string) => Promise<unknown> }
    ).aplicarBaja;
    if (typeof f !== "function")
      throw new Error(
        "no implementado: AuthRepo.aplicarBaja (auth/repositorio.ts)",
      );
    return f.call(a, hashHex);
  });
}

const preferencia = async (
  e: Estudio,
  u: UsuarioSembrado,
  tipo: string,
): Promise<boolean | null> => {
  const { rows } = await h.admin.query(
    "select activo from correo_preferencia where tenant_id = $1 and usuario_id = $2 and tipo = $3",
    [e.tenantId, u.id, tipo],
  );
  return rows.length === 0 ? null : (rows[0].activo as boolean);
};

const bajas = async (e: Estudio, u: UsuarioSembrado) =>
  (
    await h.admin.query(
      `select datos, actor_tipo, usuario_id from auditoria
        where tenant_id = $1 and usuario_id = $2 and accion = 'correo.preferencia_cambiada' and datos ->> 'origen' = 'enlace'
        order by ocurrida_en, id`,
      [e.tenantId, u.id],
    )
  ).rows as Array<{ datos: unknown; actor_tipo: string; usuario_id: string }>;

/** Envío real de avisos críticos del contador (responsable del cliente), tomado, con su token de baja guardado. */
async function envioConToken(e: Estudio, u: UsuarioSembrado) {
  const c = await e.nuevoCliente();
  await asignarCliente(h, e, c, u, "responsable");
  await capturarCriticos(h, e, c, 1);
  const envio = await envioPendiente(h, e, u, "buzon_critico");
  await h.comoWorker(e, (tx) => tomarEnvio(tx, envio));
  const t = tokenDeBaja();
  await h.comoWorker(e, (tx) => crearTokenBaja(tx, envio, t.hash));
  return { envio, ...t, cliente: c };
}

describe("crearTokenBaja (R-7)", () => {
  it("guarda el hash ligado a (estudio, usuario, tipo, envío) con vencimiento a 90 días; nunca el token en claro", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { envio, hash, token } = await envioConToken(e, u);
    const { rows } = await h.admin.query(
      `select tenant_id, usuario_id, tipo, envio_id, hash,
              vence_en between now() + interval '89 days 23 hours' and now() + interval '90 days 1 hour' as vence_a_90,
              row_to_json(t)::text as fila
         from correo_baja_token t where hash = $1`,
      [hash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: e.tenantId,
      usuario_id: u.id,
      tipo: "buzon_critico",
      envio_id: envio,
      vence_a_90: true,
    });
    expect(Buffer.from(rows[0].hash as Buffer).equals(hash)).toBe(true);
    expect(rows[0].fila).not.toContain(token);
  });

  it("el token de un resumen lleva el tipo `resumen`; el de un aviso de credencial, `credencial_invalida`", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    const resumen = await crearResumenDelDia(h, e, await diaLima(h, 0), u);
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    await invalidarCredencial(h, e, c);
    const cred = await envioPendiente(h, e, u, "credencial_invalida");
    const t1 = tokenDeBaja();
    const t2 = tokenDeBaja();
    await h.comoWorker(e, async (tx) => {
      await crearTokenBaja(tx, resumen, t1.hash);
      await crearTokenBaja(tx, cred, t2.hash);
    });
    const { rows } = await h.admin.query(
      "select hash, tipo from correo_baja_token where tenant_id = $1 and usuario_id = $2",
      [e.tenantId, u.id],
    );
    const tipos = new Map(
      rows.map((f) => [Buffer.from(f.hash as Buffer).toString("hex"), f.tipo]),
    );
    expect(tipos.get(t1.hex)).toBe("resumen");
    expect(tipos.get(t2.hex)).toBe("credencial_invalida");
  });

  it("un envío ajeno o inexistente es P0002 y no guarda nada; el backend no ejecuta la función (42501)", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { envio } = await envioConToken(e, u);
    const t = tokenDeBaja();
    expect(
      (
        await falla(
          h.comoWorker(h.B, (tx) => crearTokenBaja(tx, envio, t.hash)),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          h.comoWorker(e, (tx) => crearTokenBaja(tx, NO_EXISTE, t.hash)),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          h.comoUsuario(e, e.dueno, (tx) => crearTokenBaja(tx, envio, t.hash)),
        )
      ).codigo,
    ).toBe("42501");
    const { rows } = await h.admin.query(
      "select 1 from correo_baja_token where hash = $1",
      [t.hash],
    );
    expect(rows).toHaveLength(0);
  });

  it.each([
    ["31 bytes", Buffer.alloc(31, 1)],
    ["33 bytes", Buffer.alloc(33, 1)],
    ["vacío", Buffer.alloc(0)],
    ["texto", "a".repeat(64)],
    ["nulo", null],
  ])("un hash de %s: 22023 sin ir a la BD", async (_n, hash) => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      (await falla(crearTokenBaja(tx, NO_EXISTE, hash as never))).codigo,
    ).toBe("22023");
    expect(llamadas).toHaveLength(0);
  });

  it("un id de envío mal formado: P0002 sin ir a la BD", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      (await falla(crearTokenBaja(tx, "no-es-uuid", Buffer.alloc(32)))).codigo,
    ).toBe("P0002");
    expect(llamadas).toHaveLength(0);
  });

  it("llama a correo_baja_token_crear con el envío y el hash", async () => {
    const hash = Buffer.alloc(32, 9);
    const { tx, llamadas } = txFalso({ rows: [] });
    await crearTokenBaja(tx, NO_EXISTE, hash);
    expect(llamadas[0]!.texto).toMatch(/correo_baja_token_crear\(/);
    expect(llamadas[0]!.valores).toEqual([NO_EXISTE, hash]);
  });
});

describe("aplicarBaja (R-7, R-10; CA-8)", () => {
  it("apaga solo el tipo del token, de su usuario y su estudio, y audita con origen enlace", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const otro = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    await fijar(h, e, otro, { resumen: true });
    const { hex } = await envioConToken(e, u);
    expect(await aplicarBaja(hex)).toBeUndefined();
    expect(await preferencia(e, u, "buzon_critico")).toBe(false);
    expect(await preferencia(e, u, "credencial_invalida")).toBe(true);
    expect(await preferencia(e, u, "resumen")).toBe(true);
    // Otro usuario del mismo estudio, intacto.
    expect(await preferencia(e, otro, "buzon_critico")).toBe(true);
    const a = await bajas(e, u);
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({
      actor_tipo: "usuario",
      usuario_id: u.id,
      datos: { tipo: "buzon_critico", de: true, a: false, origen: "enlace" },
    });
    expect(await bajas(e, otro)).toEqual([]);
  });

  it("el mismo usuario en otro estudio no se toca", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("contador");
    await e2.unir(u, "contador");
    await fijar(h, e2, u, { credencialInvalida: true });
    const { hex } = await envioConToken(e1, u);
    await aplicarBaja(hex);
    expect(await preferencia(e1, u, "buzon_critico")).toBe(false);
    expect(await preferencia(e2, u, "buzon_critico")).toBe(true);
    expect(await bajas(e2, u)).toEqual([]);
    const enE2 = await h.comoUsuario(e2, u, (tx) => leerPreferencias(tx));
    expect(enE2.buzonCritico).toBe(true);
  });

  it("repetirla no cambia ni audita nada (idempotente)", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { hex } = await envioConToken(e, u);
    await aplicarBaja(hex);
    const antes = await bajas(e, u);
    expect(await aplicarBaja(hex)).toBeUndefined();
    expect(await aplicarBaja(hex)).toBeUndefined();
    expect(await bajas(e, u)).toEqual(antes);
    expect(await preferencia(e, u, "buzon_critico")).toBe(false);
  });

  it("sin filas previas: queda ese tipo apagado y los demás en su valor efectivo", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { hex } = await envioConToken(e, u);
    await aplicarBaja(hex);
    const p = await h.comoUsuario(e, u, (tx) => leerPreferencias(tx));
    expect(p).toMatchObject({
      buzonCritico: false,
      credencialInvalida: true,
      planLimite: false,
      resumen: false,
    });
  });

  it("la baja del resumen apaga el resumen", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    const resumen = await crearResumenDelDia(h, e, await diaLima(h, 0), u);
    const t = tokenDeBaja();
    await h.comoWorker(e, (tx) => crearTokenBaja(tx, resumen, t.hash));
    await aplicarBaja(t.hex);
    expect(await preferencia(e, u, "resumen")).toBe(false);
    expect((await bajas(e, u))[0]?.datos).toEqual({
      tipo: "resumen",
      de: true,
      a: false,
      origen: "enlace",
    });
  });

  it("nunca activa: con el tipo ya apagado en la app, la baja lo deja apagado y no audita", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { hex } = await envioConToken(e, u);
    await fijar(h, e, u, { buzonCritico: false });
    await aplicarBaja(hex);
    expect(await preferencia(e, u, "buzon_critico")).toBe(false);
    expect(await bajas(e, u)).toEqual([]);
  });

  it("un token inexistente, vencido o inventado responde igual (undefined) y no cambia nada", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const { hex, hash } = await envioConToken(e, u);
    // Vencido: se mueve la marca como superusuario sobre la fila ya creada.
    await h.admin.query(
      "update correo_baja_token set vence_en = clock_timestamp() - interval '1 second' where hash = $1",
      [hash],
    );
    const inexistente = tokenDeBaja().hex;
    const resultados = [
      await aplicarBaja(hex),
      await aplicarBaja(inexistente),
      await aplicarBaja("0".repeat(64)),
      await aplicarBaja(hex.toUpperCase()),
    ];
    expect(resultados).toEqual([undefined, undefined, undefined, undefined]);
    expect(await preferencia(e, u, "buzon_critico")).toBeNull();
    expect(await bajas(e, u)).toEqual([]);
  });

  it.each([
    ["vacío", ""],
    ["63 caracteres", "a".repeat(63)],
    ["65 caracteres", "a".repeat(65)],
    ["no hexadecimal", "z".repeat(64)],
    ["con espacios", ` ${"a".repeat(62)} `],
    ["base64url del token", tokenDeBaja().token],
  ])(
    "un valor %s no hace nada y no distingue (sin ir a la BD)",
    async (_n, malo) => {
      const { tx, llamadas } = txFalso({ rows: [] });
      const f = (
        crearAuthRepo(tx) as unknown as {
          aplicarBaja?: (x: string) => Promise<unknown>;
        }
      ).aplicarBaja;
      if (typeof f !== "function")
        throw new Error(
          "no implementado: AuthRepo.aplicarBaja (auth/repositorio.ts)",
        );
      expect(await f(malo)).toBeUndefined();
      expect(llamadas).toHaveLength(0);
    },
  );

  it("llama a auth.correo_baja_aplicar($1::bytea) con los 32 bytes del hash", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ correo_baja_aplicar: null }] });
    const f = (
      crearAuthRepo(tx) as unknown as {
        aplicarBaja?: (x: string) => Promise<unknown>;
      }
    ).aplicarBaja;
    if (typeof f !== "function")
      throw new Error(
        "no implementado: AuthRepo.aplicarBaja (auth/repositorio.ts)",
      );
    expect(await f(HEX)).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(
      /auth\.correo_baja_aplicar\(\$1::bytea\)/,
    );
    expect(llamadas[0]!.valores).toEqual([Buffer.from(HEX, "hex")]);
  });

  it.each(["42501", "55000", "40P01"])(
    "un error de la BD (%s) sale como AuthRepoError con solo el SQLSTATE",
    async (codigo) => {
      const { tx } = txFalso(errorPg(codigo, "CANARIO-token-ana@ejemplo.test"));
      const f = (
        crearAuthRepo(tx) as unknown as {
          aplicarBaja?: (x: string) => Promise<unknown>;
        }
      ).aplicarBaja;
      if (typeof f !== "function")
        throw new Error(
          "no implementado: AuthRepo.aplicarBaja (auth/repositorio.ts)",
        );
      const e = await f(HEX).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(AuthRepoError);
      expect((e as AuthRepoError).codigo).toBe(codigo);
      expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
    },
  );
});

pruebasTraduccion([
  [
    "crearTokenBaja",
    (tx) =>
      crearTokenBaja(
        tx,
        "0190a000-0000-7000-8000-0000000000e1",
        Buffer.alloc(32, 3),
      ),
  ],
]);
