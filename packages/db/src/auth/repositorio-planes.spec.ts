// Spec 006 (T11, cobertura): las 11 funciones de registro, cupo de aceptación y plataforma de AuthRepo, y los errores
// de plataforma, sin BD (tx falsa). El comportamiento de las funciones SQL está en tests/aislamiento/planes-funciones.spec.ts.
import { describe, expect, it } from "vitest";
import { AuthRepoError, PlataformaReglaError } from "./errores";
import { crearAuthRepo, type DatosPlan, type TxConsulta } from "./repositorio";

const T = "01920000-0000-7000-8000-0000000000a1";
const P = "01920000-0000-7000-8000-0000000000b1";
const TOKEN = Buffer.alloc(32, 5);
const SESION = Buffer.alloc(32, 6);
const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearAuthRepo(tx), llamadas };
}
function txQueFalla(error: unknown) {
  return crearAuthRepo({
    query: async () => {
      throw error;
    },
  } as unknown as TxConsulta);
}

const DATOS: DatosPlan = {
  codigo: "estudio",
  nombre: "Estudio",
  precioMensual: "249.00",
  precioAnual: "2490.00",
  maxRucs: 100,
  maxUsuarios: 5,
  precioRucExtra: "4.00",
  maxRucsExtra: 20,
  frecuenciaBuzonMin: 720,
  features: { a: 1 },
  activo: true,
};
const FILA_PLAN = {
  id: P,
  codigo: "estudio",
  nombre: "Estudio",
  precio_mensual: "249.00",
  precio_anual: "2490.00",
  max_rucs: "100",
  max_usuarios: "5",
  precio_ruc_extra: "4.00",
  max_rucs_extra: "20",
  frecuencia_buzon_min: "720",
  features: { a: 1 },
  activo: true,
};
const PLAN: ReturnType<typeof esperadoPlan> = esperadoPlan();
function esperadoPlan() {
  return {
    id: P,
    codigo: "estudio",
    nombre: "Estudio",
    precioMensual: "249.00",
    precioAnual: "2490.00",
    maxRucs: 100,
    maxUsuarios: 5,
    precioRucExtra: "4.00",
    maxRucsExtra: 20,
    frecuenciaBuzonMin: 720,
    features: { a: 1 },
    activo: true,
  };
}

describe("AuthRepo de 006: registro", () => {
  it("registroCrear pasa los 5 parámetros posicionales y no devuelve nada", async () => {
    const { repo, llamadas } = txFalso([{}]);
    const tokenHash = Buffer.alloc(32, 9);
    await expect(
      repo.registroCrear({ correo: "a@b.test", estudio: "E", ruc: null, nombre: "N", tokenHash }),
    ).resolves.toBeUndefined();
    expect(llamadas[0]!.texto).toContain("auth.registro_crear(");
    expect(llamadas[0]!.valores).toEqual(["a@b.test", "E", null, "N", tokenHash]);
  });

  it("registroVigente mapea la fila y devuelve null con cero filas", async () => {
    const vivo = txFalso([{ nombre_estudio: "E", correo: "a@b.test", cuenta_existe: true }]);
    expect(await vivo.repo.registroVigente(TOKEN)).toEqual({
      nombreEstudio: "E",
      correo: "a@b.test",
      cuentaExiste: true,
    });
    const sinCuenta = txFalso([{ nombre_estudio: "E", correo: "a@b.test", cuenta_existe: false }]);
    expect((await sinCuenta.repo.registroVigente(TOKEN))?.cuentaExiste).toBe(false);
    expect(await txFalso([]).repo.registroVigente(TOKEN)).toBeNull();
  });

  it.each(["creado", "cuenta_existe", "invalida", "sin_plan"] as const)(
    "registroConfirmarNueva devuelve '%s' tal cual",
    async (v) => {
      const { repo, llamadas } = txFalso([{ registro_confirmar_nueva: v }]);
      expect(await repo.registroConfirmarNueva(TOKEN, PHC)).toBe(v);
      expect(llamadas[0]!.valores).toEqual([TOKEN, PHC]);
    },
  );

  // Ajuste de 006 (T13a, D14): la función devuelve también `con_prueba` (la cuenta originó su prueba con este estudio) y el repo
  // lo expone como `conPrueba` (el servicio lo traduce a `sinPlan = !conPrueba`).
  it("registroConfirmarExistente mapea tenantId, estudioNombre y conPrueba; cero filas -> null", async () => {
    const { repo, llamadas } = txFalso([{ tenant_id: T, estudio_nombre: "E", con_prueba: true }]);
    expect(await repo.registroConfirmarExistente(TOKEN, SESION)).toEqual({ tenantId: T, estudioNombre: "E", conPrueba: true });
    expect(
      await txFalso([{ tenant_id: T, estudio_nombre: "E", con_prueba: false }]).repo.registroConfirmarExistente(TOKEN, SESION),
    ).toEqual({ tenantId: T, estudioNombre: "E", conPrueba: false });
    expect(llamadas[0]!.valores).toEqual([TOKEN, SESION]);
    expect(await txFalso([]).repo.registroConfirmarExistente(TOKEN, SESION)).toBeNull();
  });

  it("cupoUsuariosAceptar: true solo si la función devuelve true", async () => {
    expect(await txFalso([{ cupo_usuarios_aceptar: true }]).repo.cupoUsuariosAceptar(T)).toBe(true);
    expect(await txFalso([{ cupo_usuarios_aceptar: false }]).repo.cupoUsuariosAceptar(T)).toBe(false);
  });
});

describe("AuthRepo de 006: plataforma", () => {
  it("plataformaYo devuelve el usuario o null", async () => {
    expect(await txFalso([{ usuario_id: T }]).repo.plataformaYo(SESION)).toBe(T);
    expect(await txFalso([]).repo.plataformaYo(SESION)).toBeNull();
  });

  it("planListar convierte enteros a number, conserva los precios como cadena y lee cada fila", async () => {
    const { repo, llamadas } = txFalso([FILA_PLAN]);
    expect(await repo.planListar(SESION)).toEqual([PLAN]);
    expect(llamadas[0]!.valores).toEqual([SESION]);
    expect(await txFalso([]).repo.planListar(SESION)).toEqual([]);
  });

  it("planListar: precio anual ausente -> null, sin límite de usuarios -> null y activo distinto de true -> false", async () => {
    const fila = { ...FILA_PLAN, precio_anual: undefined, max_usuarios: null, activo: "f" };
    const [p] = await txFalso([fila]).repo.planListar(SESION);
    expect(p).toMatchObject({ precioAnual: null, maxUsuarios: null, activo: false });
    const [q] = await txFalso([{ ...FILA_PLAN, precio_anual: null }]).repo.planListar(SESION);
    expect(q!.precioAnual).toBeNull();
  });

  it("planCrear y planEditar pasan los 11 campos en orden, con features serializadas como JSON", async () => {
    const crear = txFalso([FILA_PLAN]);
    expect(await crear.repo.planCrear(SESION, DATOS)).toEqual(PLAN);
    expect(crear.llamadas[0]!.texto).toContain("auth.plan_crear(");
    const campos = [
      "estudio", "Estudio", "249.00", "2490.00", 100, 5, "4.00", 20, 720, JSON.stringify({ a: 1 }), true,
    ];
    expect(crear.llamadas[0]!.valores).toEqual([SESION, ...campos]);

    const editar = txFalso([FILA_PLAN]);
    expect(await editar.repo.planEditar(SESION, P, DATOS)).toEqual(PLAN);
    expect(editar.llamadas[0]!.texto).toContain("auth.plan_editar(");
    expect(editar.llamadas[0]!.valores).toEqual([SESION, P, ...campos]);
  });

  it("estudiosListar mapea el plan (o null si no hay suscripción) y el estado", async () => {
    const { repo } = txFalso([
      { id: T, nombre: "Con plan", plan_codigo: "estudio", plan_nombre: "Estudio", estado: "activa" },
      { id: P, nombre: "Sin plan", plan_codigo: null, plan_nombre: null, estado: null },
      { id: P, nombre: "Sin estado", plan_codigo: undefined, plan_nombre: undefined },
    ]);
    expect(await repo.estudiosListar(SESION)).toEqual([
      { id: T, nombre: "Con plan", plan: { codigo: "estudio", nombre: "Estudio" }, estado: "activa" },
      { id: P, nombre: "Sin plan", plan: null, estado: null },
      { id: P, nombre: "Sin estado", plan: null, estado: null },
    ]);
  });

  it("suscripcionAsignar mapea la fila y convierte los RUCs extra a number", async () => {
    const { repo, llamadas } = txFalso([
      {
        tenant_id: T,
        plan_id: P,
        plan_codigo: "estudio",
        plan_nombre: "Estudio",
        estado: "prueba",
        rucs_extra_contratados: "3",
      },
    ]);
    expect(await repo.suscripcionAsignar(SESION, T, P, 3)).toEqual({
      tenantId: T,
      planId: P,
      planCodigo: "estudio",
      planNombre: "Estudio",
      estado: "prueba",
      rucsExtraContratados: 3,
    });
    expect(llamadas[0]!.valores).toEqual([SESION, T, P, 3]);
  });
});

describe("errores de las funciones de plataforma", () => {
  const llamadasPlataforma: Array<[string, (r: ReturnType<typeof crearAuthRepo>) => Promise<unknown>]> = [
    ["plataformaYo", (r) => r.plataformaYo(SESION)],
    ["planListar", (r) => r.planListar(SESION)],
    ["planCrear", (r) => r.planCrear(SESION, DATOS)],
    ["planEditar", (r) => r.planEditar(SESION, P, DATOS)],
    ["estudiosListar", (r) => r.estudiosListar(SESION)],
    ["suscripcionAsignar", (r) => r.suscripcionAsignar(SESION, T, P, 0)],
  ];

  it.each(["plan_inactivo", "extra_sobre_tope", "no_encontrado"] as const)(
    "P0001 con mensaje estable '%s' sale como PlataformaReglaError con ese motivo",
    async (motivo) => {
      for (const [, llamar] of llamadasPlataforma) {
        const e = await llamar(txQueFalla({ code: "P0001", message: motivo })).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(PlataformaReglaError);
        expect((e as PlataformaReglaError).motivo).toBe(motivo);
        expect((e as PlataformaReglaError).codigo).toBe("P0001");
        expect(e).toBeInstanceOf(AuthRepoError);
      }
    },
  );

  it("42501 y 23514 conservan solo el SQLSTATE (AuthRepoError, no de regla)", async () => {
    for (const code of ["42501", "23514", "23505"]) {
      const e = await txQueFalla({ code, message: "datos de la fila", detail: "secreto" })
        .planCrear(SESION, DATOS)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e).not.toBeInstanceOf(PlataformaReglaError);
      expect((e as AuthRepoError).codigo).toBe(code);
      expect(JSON.stringify(Object.getOwnPropertyNames(e))).not.toContain("detail");
    }
  });

  it("un P0001 con mensaje ajeno o sin texto NO es de regla (no se filtra el mensaje)", async () => {
    for (const error of [
      { code: "P0001", message: "texto libre con datos" },
      { code: "P0001" },
      { code: "P0001", message: 42 },
      { code: "XX000", message: "plan_inactivo" },
      "texto",
      null,
      undefined,
    ]) {
      const e = await txQueFalla(error).planListar(SESION).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e).not.toBeInstanceOf(PlataformaReglaError);
    }
  });

  it("las funciones que no son de plataforma no traducen P0001: salen como AuthRepoError", async () => {
    const e = await txQueFalla({ code: "P0001", message: "no_encontrado" })
      .cupoUsuariosAceptar(T)
      .catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(PlataformaReglaError);
    expect((e as AuthRepoError).codigo).toBe("P0001");
  });

  it("PlataformaReglaError y AuthRepoError se nombran por su clase sin propiedad propia 'name'", () => {
    const e = new PlataformaReglaError("no_encontrado");
    expect(e.name).toBe("PlataformaReglaError");
    expect(Object.keys(e).sort()).toEqual(["codigo", "motivo"]);
    expect(PlataformaReglaError.desde({ code: "P0001", message: "plan_inactivo" })).toBeInstanceOf(PlataformaReglaError);
  });
});
