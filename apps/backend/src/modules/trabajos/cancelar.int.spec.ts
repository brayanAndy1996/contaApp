// T6 (008) · `POST /trabajos/:trabajoId/cancelar`: CA-7 (quién cancela, solo `en_cola`, carrera con el despacho) y D9,
// con CSRF (004) y el mismo 404 de CA-5. PG y Redis reales.
// Rojo: la ruta aún no existe (T11): hoy responde 404.
//
// Contrato fijado por estas pruebas (T11):
//  - `@SoloEstudio` + CSRF. 200 con la `TrabajoVista` ya cancelada (`estado: "cancelado"`, `motivo: "cancelado_usuario"`,
//    `posicion: null`, `terminadoEn` fijado); la fila queda igual. El cuerpo de la petición se ignora (no se puede
//    forzar otro estado, motivo ni estudio).
//  - Cancelan quien encoló, el Dueño y el Administrador (D9). Un usuario que ve el trabajo (alcance de 005) pero no es
//    ninguno de esos: 403 `{codigo:"permiso_denegado"}`. Quien no lo ve (otro estudio, cliente no asignado, o el
//    creador al que ya le quitaron el cliente), id inexistente o mal formado: el mismo 404 `{codigo:"no_encontrado"}`
//    (código, cuerpo y cabeceras salvo Date), también cuando el 403 le correspondería por rol.
//  - Solo se cancela un `en_cola`; `ejecutando` o terminado: 409 `{codigo:"trabajo_iniciado"}` y la fila no cambia.
//  - Cancelar y despachar en carrera (la transición `en_cola → ejecutando` es un UPDATE condicionado, D2): un solo
//    ganador. Si la cancelación responde 200, la fila queda `cancelado` y el despacho no actualizó nada; si responde
//    409, la fila queda `ejecutando` (jamás un 5xx ni los dos resultados a la vez).
//  - Sin `X-CSRF-Token` válido: 403 `csrf_invalido`; sin `Origin`/`Sec-Fetch-Site`: 403 `origen_invalido`; la fila no cambia.
//  - Tras cancelar se publica (después del commit) un evento `trabajo` en `eventos:{tenantId}` con estado `cancelado`.
import { randomUUID } from "node:crypto";
import { trabajoVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  observarEventos,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";
import { forma, type Resp } from "../../../test/soporte.js";

let b: BancoTrabajos;
let E: Estudio;
let ajeno: Estudio;
let admin: Actor;
let contador: Actor; // asignado a c0 y c1
let otroContador: Actor; // asignado a c0 y c1, no encola nada
let asistente: Actor; // asignado a c1
let lectura: Actor; // asignado a c1
let sinCliente: Actor; // asistente sin asignaciones
let c: string[];
let cAjeno: string;

const cancelar = (a: Actor, id: string, cuerpo?: unknown, extra = {}) =>
  b.llamar(a, "POST", `/trabajos/${id}/cancelar`, cuerpo, extra);
const estado = async (id: string) => (await b.fila(id)).estado as string;
/** Trabajo de c1 (visible para todos los miembros asignados) creado por `quien`. */
const nuevo = (
  quien: Actor | null,
  o: Parameters<BancoTrabajos["sembrar"]>[2] = {},
) => b.sembrar(E.tenantId, c[1]!, { creadoPor: quien?.id ?? null, ...o });

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  ajeno = await b.estudio();
  c = await b.clientes(E.tenantId, 3);
  [cAjeno] = (await b.clientes(ajeno.tenantId, 1)) as [string];
  admin = await b.miembro(E.tenantId, "admin");
  contador = await b.miembro(E.tenantId, "contador");
  otroContador = await b.miembro(E.tenantId, "contador");
  asistente = await b.miembro(E.tenantId, "asistente");
  lectura = await b.miembro(E.tenantId, "lectura");
  sinCliente = await b.miembro(E.tenantId, "asistente");
  for (const u of [contador, otroContador, asistente, lectura])
    await b.asignar(E.tenantId, c[1]!, u.id, "colaborador");
  await b.asignar(E.tenantId, c[0]!, contador.id, "responsable");
  await b.asignar(E.tenantId, c[0]!, otroContador.id, "colaborador");
});
afterAll(async () => {
  await b?.cerrar();
});

describe("CA-7 · quién cancela (D9)", () => {
  it("quien encoló cancela su trabajo: 200 con la vista cancelada y la fila queda cancelada", async () => {
    const t = await nuevo(asistente);
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      // El cuerpo se ignora: no se puede forzar otro estado, motivo ni estudio.
      const r = await cancelar(asistente, t.id, {
        estado: "completado",
        motivo: "error_interno",
        tenantId: ajeno.tenantId,
      });
      expect(r.status).toBe(200);
      expect(trabajoVistaSchema.safeParse(r.body).success).toBe(true);
      expect(r.body).toMatchObject({
        id: t.id,
        estado: "cancelado",
        motivo: "cancelado_usuario",
        posicion: null,
        creadoPor: { usuarioId: asistente.id },
      });
      expect(r.body.terminadoEn).toEqual(expect.any(String));
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      const fila = await b.fila(t.id);
      expect(fila).toMatchObject({
        estado: "cancelado",
        motivo: "cancelado_usuario",
        tenant_id: E.tenantId,
      });
      expect(fila.terminado_en).not.toBeNull();
      // Publica el cambio de estado después del commit.
      const ev = await obs.esperar(
        (m) => m.id === t.id && m.estado === "cancelado",
      );
      expect(ev).not.toBeNull();
      expect(trabajoVistaSchema.safeParse(ev).success).toBe(true);
    } finally {
      obs.cerrar();
    }
  });

  it("el Dueño y el Administrador cancelan trabajos de otros; el Dueño cancela uno programado (sin creador)", async () => {
    const porDueno = await cancelar(E.titular, (await nuevo(contador)).id);
    expect(porDueno.status).toBe(200);
    expect(porDueno.body.estado).toBe("cancelado");
    const porAdmin = await cancelar(admin, (await nuevo(asistente)).id);
    expect(porAdmin.status).toBe(200);
    const programado = await nuevo(null, { prioridad: "programado" });
    const r = await cancelar(E.titular, programado.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "cancelado", creadoPor: null });
    expect(await estado(programado.id)).toBe("cancelado");
  });

  it("otro contador que sí lo ve, un asistente y lectura reciben 403 permiso_denegado y el trabajo sigue en_cola", async () => {
    const t = await nuevo(contador);
    for (const quien of [otroContador, asistente, lectura]) {
      const r = await cancelar(quien, t.id);
      expect(r.status, quien.rol).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(await estado(t.id)).toBe("en_cola");
    const programado = await nuevo(null, { prioridad: "programado" });
    expect((await cancelar(contador, programado.id)).status).toBe(403); // sin creador: solo Dueño y Administrador
    expect(await estado(programado.id)).toBe("en_cola");
  });

  it("el creador que ya no ve el cliente recibe 404, no 403 ni 200", async () => {
    const u = await b.miembro(E.tenantId, "contador");
    await b.asignar(E.tenantId, c[2]!, u.id, "colaborador");
    const t = await b.sembrar(E.tenantId, c[2]!, { creadoPor: u.id });
    // Control: mientras ve el cliente, el creador sí cancela (si no, el 404 de abajo sería el de una ruta inexistente).
    const control = await b.sembrar(E.tenantId, c[2]!, { creadoPor: u.id });
    expect((await cancelar(u, control.id)).status).toBe(200);
    await b.sql(
      "delete from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3",
      [E.tenantId, c[2], u.id],
    );
    const r = await cancelar(u, t.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await estado(t.id)).toBe("en_cola");
  });
});

describe("CA-5 / CA-7 · el mismo 404", () => {
  it("inexistente, mal formado, de otro estudio y no asignado dan el mismo 404 (código, cuerpo y cabeceras salvo Date)", async () => {
    const delOtro = await b.sembrar(ajeno.tenantId, cAjeno, {
      creadoPor: ajeno.titular.id,
    });
    const mio = await nuevo(contador);
    const casos = [randomUUID(), "no-es-un-uuid", "0", delOtro.id];
    // Para un asistente sin clientes, un trabajo real de su estudio también es 404 (aunque exista).
    const formas = [forma(await cancelar(sinCliente, mio.id))];
    for (const id of casos) formas.push(forma(await cancelar(sinCliente, id)));
    for (const f of formas) expect(f).toEqual(formas[0]);
    expect(formas[0]!.status).toBe(404);
    expect(formas[0]!.body).toEqual({ codigo: "no_encontrado" });
    // Para el Dueño, el trabajo de otro estudio es inexistente.
    const g = [
      forma(await cancelar(E.titular, delOtro.id)),
      forma(await cancelar(E.titular, randomUUID())),
    ];
    expect(g[0]).toEqual(g[1]);
    expect(g[0]!.status).toBe(404);
    // Nada cambió.
    expect(await estado(delOtro.id)).toBe("en_cola");
    expect(await estado(mio.id)).toBe("en_cola");
    // Control: el mismo tipo de petición sobre un trabajo visible sí responde 200 (no es una ruta inexistente).
    expect((await cancelar(contador, mio.id)).status).toBe(200);
  });
});

describe("CA-7 · solo se cancela un trabajo en_cola", () => {
  it.each([
    ["ejecutando", { estado: "ejecutando" as const }],
    ["completado", { estado: "completado" as const }],
    ["error", { estado: "error" as const, motivo: "datos_invalidos" as const }],
  ])(
    "%s: 409 trabajo_iniciado y la fila no cambia",
    async (nombre, semilla) => {
      const t = await nuevo(contador, semilla);
      const antes = await b.fila(t.id);
      for (const quien of [E.titular, contador]) {
        const r = await cancelar(quien, t.id);
        expect(r.status, `${nombre} por ${quien.rol}`).toBe(409);
        expect(r.body).toEqual({ codigo: "trabajo_iniciado" });
      }
      expect(await b.fila(t.id)).toEqual(antes);
    },
  );

  it("el 403 se decide antes que el 409: quien no puede cancelar recibe 403 aunque el trabajo ya haya empezado", async () => {
    const t = await nuevo(contador, { estado: "ejecutando" });
    const r = await cancelar(asistente, t.id);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
  });
});

describe("CA-7 · cancelar y despachar en carrera deja un solo resultado", () => {
  it("20 rondas: o se cancela (200) y el despacho no actualiza nada, o ya empezó (409) y el despacho ganó", async () => {
    const resultados = { cancelado: 0, ejecutando: 0 };
    for (let i = 0; i < 20; i++) {
      const t = await nuevo(contador);
      // El despacho es la transición condicionada de D2 (la que hace el despachador del worker).
      const despachar = async (): Promise<number> =>
        (
          await b.sql(
            `update job_registro set estado = 'ejecutando', iniciado_en = now(), actualizado_en = now()
              where id = $1 and estado = 'en_cola' returning id`,
            [t.id],
          )
        ).length;
      let r: Resp;
      let gano: number;
      if (i % 2 === 0) {
        [r, gano] = await Promise.all([cancelar(E.titular, t.id), despachar()]);
      } else {
        [gano, r] = await Promise.all([despachar(), cancelar(E.titular, t.id)]);
      }
      const final = await estado(t.id);
      if (r.status === 200) {
        expect(final, `ronda ${i}`).toBe("cancelado");
        expect(
          gano,
          `ronda ${i}: el despacho no debe ganar si se canceló`,
        ).toBe(0);
        resultados.cancelado += 1;
      } else {
        expect(r.status, `ronda ${i}`).toBe(409);
        expect(r.body).toEqual({ codigo: "trabajo_iniciado" });
        expect(final, `ronda ${i}`).toBe("ejecutando");
        expect(
          gano,
          `ronda ${i}: si la cancelación dio 409, el despacho debió ganar`,
        ).toBe(1);
        resultados.ejecutando += 1;
      }
    }
    expect(resultados.cancelado + resultados.ejecutando).toBe(20);
  });

  it("dos cancelaciones simultáneas del mismo trabajo no dejan dos efectos: una gana y la fila queda cancelada", async () => {
    const t = await nuevo(contador);
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      const rs = await Promise.all([
        cancelar(E.titular, t.id),
        cancelar(admin, t.id),
      ]);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        rs.filter((r) => r.status !== 200).every((r) => r.status === 409),
      ).toBe(true);
      expect(await estado(t.id)).toBe("cancelado");
      await obs.esperar((m) => m.id === t.id && m.estado === "cancelado");
      await new Promise((x) => setTimeout(x, 300));
      expect(
        obs.mensajes.filter((m) => m.id === t.id && m.estado === "cancelado"),
      ).toHaveLength(1);
    } finally {
      obs.cerrar();
    }
  });
});

describe("D9 / 004 · CSRF y origen", () => {
  it("sin X-CSRF-Token, con uno inválido o con el de otra sesión: 403 csrf_invalido y la fila no cambia", async () => {
    const t = await nuevo(contador);
    for (const csrf of [null, "x".repeat(10), E.titular.csrf]) {
      const r = await cancelar(contador, t.id, undefined, { csrf });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ codigo: "csrf_invalido" });
    }
    expect(await estado(t.id)).toBe("en_cola");
    // Con el token correcto sí se cancela.
    expect((await cancelar(contador, t.id)).status).toBe(200);
  });

  it("sin Origin ni Sec-Fetch-Site, o con un Origin ajeno: 403 origen_invalido", async () => {
    const t = await nuevo(contador);
    const sin = await cancelar(contador, t.id, undefined, { origen: null });
    expect(sin.status).toBe(403);
    expect(sin.body).toEqual({ codigo: "origen_invalido" });
    const ajenoOrigen = await cancelar(contador, t.id, undefined, {
      origen: "https://evil.example",
    });
    expect(ajenoOrigen.status).toBe(403);
    expect(await estado(t.id)).toBe("en_cola");
  });

  it("sin sesión: 401 sesion_invalida; con X-Estudio de otro estudio: 409 estudio_desfasado", async () => {
    const t = await nuevo(contador);
    const sin = await b.h.pedir({
      metodo: "POST",
      ruta: `/trabajos/${t.id}/cancelar`,
      cuerpo: {},
      estudio: E.tenantId,
    });
    expect(sin.status).toBe(401);
    const desfasado = await cancelar(contador, t.id, undefined, {
      estudio: ajeno.tenantId,
    });
    expect(desfasado.status).toBe(409);
    expect(desfasado.body).toEqual({ codigo: "estudio_desfasado" });
    expect(await estado(t.id)).toBe("en_cola");
  });
});
