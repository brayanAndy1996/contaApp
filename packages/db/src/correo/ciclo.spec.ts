// Spec 028 (T4, rojo): repositorio del ciclo programado de correo (R-5, R-12, R-14; CA-4, CA-11). Las funciones de 0074 se llaman con
// una `tx` falsa (nombre, parámetros, forma de la respuesta y errores: el comportamiento del candado y del reloj lo prueban las
// suites de BD de T3, `tests/aislamiento/correo-ciclo.spec.ts`) y `estudiosCorreo` además contra la BD real, porque su resultado no
// depende del reloj. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL para esa parte: si faltan, FALLA.
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/correo/ciclo.ts`; plan.md, «BD» y «Repositorio»):
//   estudiosCorreo(tx)            -> {tenantId, avisos, resumen}[]  de `sistema.estudios_correo()` (suscripción activa o prueba
//                                    vigente; `avisos` y `resumen` salen de `plan.features.correo_avisos` y `correo_resumen`:
//                                    ausente = true, `false` = false). Con `withSistema`.
//   tomarCicloCorreo(tx, dueno)   -> {resumenDia: "AAAA-MM-DD" | null} | null   de `sistema.correo_ciclo_tomar(dueno)` (jsonb);
//                                    null si otro dueño tiene el candado (la función devuelve null o ninguna fila).
//   renovarCicloCorreo(tx, dueno) -> boolean   de `sistema.correo_ciclo_renovar(dueno)`.
//   soltarCicloCorreo(tx, dueno)  -> void      de `sistema.correo_ciclo_soltar(dueno)`.
//   cerrarResumenCorreo(tx, dueno, dia) -> void  de `sistema.correo_resumen_cerrar(dueno, dia)`; `dia` AAAA-MM-DD válido.
//   encolarAvisosCorreo(tx, limite)     -> number  de `encolar_correo_avisos(p_limite)` (con `withTenant` del estudio); `limite`
//                                    entero de 1 a 100000.
//   crearResumenesCorreo(tx, dia)       -> number  de `crear_correo_resumenes(p_dia)` (con `withTenant` del estudio).
//   purgarCorreo(tx, dias)              -> number  de `correo_purgar(p_dias)`; `dias` entero >= 1.
//   Un argumento inválido es CorreoRepoError 22023 sin ir a la BD; de todo error de `pg` solo queda el SQLSTATE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerrarResumenCorreo,
  crearResumenesCorreo,
  encolarAvisosCorreo,
  estudiosCorreo,
  purgarCorreo,
  renovarCicloCorreo,
  soltarCicloCorreo,
  tomarCicloCorreo,
} from "./index";
import {
  abrirArnes,
  falla,
  pruebasTraduccion,
  type Arnes,
} from "./soporte-prueba";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const DUENO = "worker-1:pid-4242";

describe("estudiosCorreo contra la BD (R-12, CA-11)", () => {
  it("lista los estudios con suscripción activa o prueba vigente y con qué funciones de correo; los demás no", async () => {
    const activa = await h.nuevoEstudio();
    const prueba = await h.nuevoEstudio({ suscripcion: "prueba" });
    const sinResumen = await h.nuevoEstudio({
      features: { correo_resumen: false },
    });
    const sinAvisos = await h.nuevoEstudio({
      features: { correo_avisos: false },
    });
    const sinNada = await h.nuevoEstudio({
      features: { correo_avisos: false, correo_resumen: false },
    });
    const vencida = await h.nuevoEstudio({ suscripcion: "prueba_vencida" });
    const sinSuscripcion = await h.nuevoEstudio({ suscripcion: null });
    const lista = await h.sistema((tx) => estudiosCorreo(tx));
    const por = new Map(lista.map((f) => [f.tenantId, f]));
    expect(por.get(activa.tenantId)).toEqual({
      tenantId: activa.tenantId,
      avisos: true,
      resumen: true,
    });
    expect(por.get(prueba.tenantId)).toEqual({
      tenantId: prueba.tenantId,
      avisos: true,
      resumen: true,
    });
    expect(por.get(sinResumen.tenantId)).toEqual({
      tenantId: sinResumen.tenantId,
      avisos: true,
      resumen: false,
    });
    expect(por.get(sinAvisos.tenantId)).toEqual({
      tenantId: sinAvisos.tenantId,
      avisos: false,
      resumen: true,
    });
    expect(por.get(sinNada.tenantId)).toEqual({
      tenantId: sinNada.tenantId,
      avisos: false,
      resumen: false,
    });
    expect(por.has(vencida.tenantId)).toBe(false);
    expect(por.has(sinSuscripcion.tenantId)).toBe(false);
    // Una lista de tenant sin repeticiones y sin otras columnas.
    expect(new Set(lista.map((f) => f.tenantId)).size).toBe(lista.length);
    for (const f of lista)
      expect(Object.keys(f).sort()).toEqual(["avisos", "resumen", "tenantId"]);
  });
});

describe("estudiosCorreo (sin BD)", () => {
  it("llama a sistema.estudios_correo() sin parámetros y mapea tenantId, avisos y resumen", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        { tenant_id: "t1", avisos: true, resumen: false },
        { tenant_id: "t2", avisos: false, resumen: true },
      ],
    });
    expect(await estudiosCorreo(tx)).toEqual([
      { tenantId: "t1", avisos: true, resumen: false },
      { tenantId: "t2", avisos: false, resumen: true },
    ]);
    expect(llamadas[0]!.texto).toMatch(/sistema\.estudios_correo\(\)/);
    expect(llamadas[0]!.valores).toEqual([]);
  });

  it("sin estudios devuelve []", async () => {
    expect(await estudiosCorreo(txFalso({ rows: [] }).tx)).toEqual([]);
  });
});

describe("tomarCicloCorreo (sin BD)", () => {
  it("pasa el dueño como $1::text y devuelve el día del resumen (texto AAAA-MM-DD)", async () => {
    const { tx, llamadas } = txFalso({
      rows: [{ correo_ciclo_tomar: { resumenDia: "2026-11-24" } }],
    });
    expect(await tomarCicloCorreo(tx, DUENO)).toEqual({
      resumenDia: "2026-11-24",
    });
    expect(llamadas[0]!.texto).toMatch(
      /sistema\.correo_ciclo_tomar\(\$1::text\)/,
    );
    expect(llamadas[0]!.valores).toEqual([DUENO]);
  });

  it("con el candado pero sin resumen que crear devuelve resumenDia null", async () => {
    const { tx } = txFalso({
      rows: [{ correo_ciclo_tomar: { resumenDia: null } }],
    });
    expect(await tomarCicloCorreo(tx, DUENO)).toEqual({ resumenDia: null });
  });

  it("sin candado (valor nulo o sin fila) devuelve null", async () => {
    expect(
      await tomarCicloCorreo(
        txFalso({ rows: [{ correo_ciclo_tomar: null }] }).tx,
        DUENO,
      ),
    ).toBeNull();
    expect(await tomarCicloCorreo(txFalso({ rows: [] }).tx, DUENO)).toBeNull();
  });

  it("un dueño que no es texto de 1 a 200 caracteres es 22023 sin ir a la BD", async () => {
    for (const malo of ["", "x".repeat(201), 7, null]) {
      const { tx, llamadas } = txFalso({ rows: [] });
      expect((await falla(tomarCicloCorreo(tx, malo as never))).codigo).toBe(
        "22023",
      );
      expect(llamadas).toHaveLength(0);
    }
  });
});

describe("renovarCicloCorreo y soltarCicloCorreo (sin BD)", () => {
  it("renovar: true solo si la función devuelve true (sea cual sea el nombre de la columna)", async () => {
    const si = txFalso({ rows: [{ correo_ciclo_renovar: true }] });
    expect(await renovarCicloCorreo(si.tx, DUENO)).toBe(true);
    expect(si.llamadas[0]!.texto).toMatch(
      /sistema\.correo_ciclo_renovar\(\$1::text\)/,
    );
    expect(si.llamadas[0]!.valores).toEqual([DUENO]);
    expect(
      await renovarCicloCorreo(txFalso({ rows: [{ x: false }] }).tx, DUENO),
    ).toBe(false);
    expect(await renovarCicloCorreo(txFalso({ rows: [] }).tx, DUENO)).toBe(
      false,
    );
  });

  it("soltar: llama a sistema.correo_ciclo_soltar con el dueño y no devuelve nada", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ correo_ciclo_soltar: null }] });
    expect(await soltarCicloCorreo(tx, DUENO)).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(
      /sistema\.correo_ciclo_soltar\(\$1::text\)/,
    );
    expect(llamadas[0]!.valores).toEqual([DUENO]);
  });
});

describe("cerrarResumenCorreo (sin BD)", () => {
  it("llama a sistema.correo_resumen_cerrar con el dueño y el día y no devuelve nada", async () => {
    const { tx, llamadas } = txFalso({
      rows: [{ correo_resumen_cerrar: null }],
    });
    expect(await cerrarResumenCorreo(tx, DUENO, "2026-11-24")).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(/sistema\.correo_resumen_cerrar\(/);
    expect(llamadas[0]!.valores).toEqual([DUENO, "2026-11-24"]);
  });

  it.each([
    "2026-02-30",
    "2026-13-01",
    "24/11/2026",
    "2026-11-24T00:00:00Z",
    "",
    "20261124",
  ])(
    "el día %j no es una fecha AAAA-MM-DD válida: 22023 sin ir a la BD",
    async (dia) => {
      const { tx, llamadas } = txFalso({ rows: [] });
      expect((await falla(cerrarResumenCorreo(tx, DUENO, dia))).codigo).toBe(
        "22023",
      );
      expect(llamadas).toHaveLength(0);
    },
  );
});

describe("encolarAvisosCorreo, crearResumenesCorreo y purgarCorreo (sin BD)", () => {
  it("encolarAvisosCorreo pasa el límite y devuelve la cantidad como número", async () => {
    const { tx, llamadas } = txFalso({
      rows: [{ encolar_correo_avisos: "7" }],
    });
    expect(await encolarAvisosCorreo(tx, 1000)).toBe(7);
    expect(llamadas[0]!.texto).toMatch(/encolar_correo_avisos\(/);
    expect(llamadas[0]!.valores).toEqual([1000]);
  });

  it.each([0, -1, 1.5, Number.NaN, 100_001, "10"])(
    "encolarAvisosCorreo con límite %j: 22023 sin ir a la BD",
    async (limite) => {
      const { tx, llamadas } = txFalso({ rows: [] });
      expect(
        (await falla(encolarAvisosCorreo(tx, limite as never))).codigo,
      ).toBe("22023");
      expect(llamadas).toHaveLength(0);
    },
  );

  it("crearResumenesCorreo pasa el día y devuelve la cantidad como número", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ crear_correo_resumenes: 3 }] });
    expect(await crearResumenesCorreo(tx, "2026-11-24")).toBe(3);
    expect(llamadas[0]!.texto).toMatch(/crear_correo_resumenes\(/);
    expect(llamadas[0]!.valores).toEqual(["2026-11-24"]);
  });

  it("crearResumenesCorreo con un día inválido: 22023 sin ir a la BD", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(crearResumenesCorreo(tx, "2026-02-30"))).codigo).toBe(
      "22023",
    );
    expect(llamadas).toHaveLength(0);
  });

  it("purgarCorreo pasa los días y devuelve la cantidad como número", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ correo_purgar: "12" }] });
    expect(await purgarCorreo(tx, 90)).toBe(12);
    expect(llamadas[0]!.texto).toMatch(/correo_purgar\(/);
    expect(llamadas[0]!.valores).toEqual([90]);
  });

  it.each([0, -5, 2.5, Number.NaN, "90"])(
    "purgarCorreo con %j días: 22023 sin ir a la BD",
    async (dias) => {
      const { tx, llamadas } = txFalso({ rows: [] });
      expect((await falla(purgarCorreo(tx, dias as never))).codigo).toBe(
        "22023",
      );
      expect(llamadas).toHaveLength(0);
    },
  );

  it("un fallo de la BD sale como CorreoRepoError con solo el SQLSTATE", async () => {
    for (const code of ["55000", "42501", "22023"]) {
      const e = await falla(encolarAvisosCorreo(txFalso(errorPg(code)).tx, 10));
      expect(e.codigo).toBe(code);
    }
  });
});

pruebasTraduccion([
  ["estudiosCorreo", (tx) => estudiosCorreo(tx)],
  ["tomarCicloCorreo", (tx) => tomarCicloCorreo(tx, DUENO)],
  ["renovarCicloCorreo", (tx) => renovarCicloCorreo(tx, DUENO)],
  ["soltarCicloCorreo", (tx) => soltarCicloCorreo(tx, DUENO)],
  ["cerrarResumenCorreo", (tx) => cerrarResumenCorreo(tx, DUENO, "2026-11-24")],
  ["encolarAvisosCorreo", (tx) => encolarAvisosCorreo(tx, 1000)],
  ["crearResumenesCorreo", (tx) => crearResumenesCorreo(tx, "2026-11-24")],
  ["purgarCorreo", (tx) => purgarCorreo(tx, 90)],
]);
