// Spec 007b (T1, rojo): funciones de BD nuevas de `packages/db` contra la BD real (D1, D5, D6, D7; CA-5, CA-6, CA-9).
// Se importan de `@contapp/db` por nombre (si faltan, la prueba lo dice); cada archivo crea sus estudios, clientes y
// credenciales (EscenarioTrabajos) y los borra al final. Los sobres son bytes aleatorios sintéticos.
//
// FIRMAS que fija (T7). Todas reciben la `tx` de withTenant como primer argumento.
//   marcarCredencialVerificada(tx, clienteId, tipo, version: string | null) -> boolean      (rol worker)
//        UPDATE condicionado a `xmin::text = version` (la que dio `versionCredencial`): fija estado = 'verificada',
//        estado_motivo = NULL y estado_at = clock_timestamp(). true solo si cambió una fila; false si la versión cambió
//        (un guardado concurrente gana), si no hay credencial o si `version` es null. No toca el sobre.
//   leerEstadoCredenciales(tx, clienteId) -> Array<{ tipo, estado, fecha: Date | string | null, motivo: string | null }>
//        una fila por credencial existente del cliente (los tipos sin fila los completa el servicio como no_configurada);
//        `fecha` = estado_at, `motivo` = estado_motivo; NUNCA columnas ni bytes del sobre. Lo leen backend y worker.
//   completarDatosRuc(tx, clienteId, { razonSocial, estado, condicion })                    (rol worker)
//        escribe estado_contribuyente y condicion_contribuyente; razon_social solo si sigue siendo `'RUC ' || ruc`
//        (comparación en el mismo UPDATE: una edición manual concurrente no se pisa). No toca ninguna otra columna.
//   rucsExistentes(tx, rucs: string[]) -> Array<{ ruc: string, archivado: boolean }>        (rol backend; RLS del estudio)
//   crearCliente(tx, tenantId, { id?, ruc, razonSocial?, perfil? }) -> id                    (id explícito: para cifrar antes
//        de la transacción con el AAD final)
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb } from "./soporte";
import {
  crearDb,
  dormir,
  EscenarioTrabajos,
  UUID,
  type ClientePrueba,
} from "./trabajos-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);
type Tipo = "sol" | "sire_api";

const sobreFalso = () => ({
  ciphertext: randomBytes(64),
  nonce: randomBytes(12),
  tag: randomBytes(16),
  dekEnvuelta: randomBytes(512),
  kekId: "k1",
  version: 1 as const,
});
const COLUMNAS_SOBRE = [
  "ciphertext",
  "nonce",
  "tag",
  "dek_envuelta",
  "dekEnvuelta",
  "kek_id",
  "kekId",
  "version",
];

let admin: Pool;
let et: EscenarioTrabajos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  et = new EscenarioTrabajos(admin);
  X = (await et.estudio()).id;
  Y = (await et.estudio()).id;
  backend = crearDb("contapp_backend", 10);
  worker = crearDb("contapp_worker", 10);
});
afterAll(async () => {
  await et?.limpiar();
  await backend?.close();
  await worker?.close();
  await admin?.end();
});

const version = (
  tenant: string,
  c: string,
  tipo: Tipo,
): Promise<string | null> =>
  worker.withTenant({ tenantId: tenant }, (tx) =>
    f("versionCredencial")(tx, c, tipo),
  );
const verificar = (
  tenant: string,
  c: string,
  tipo: Tipo,
  v: string | null,
): Promise<boolean> =>
  worker.withTenant({ tenantId: tenant }, (tx) =>
    f("marcarCredencialVerificada")(tx, c, tipo, v),
  );
const invalidar = (tenant: string, c: string, tipo: Tipo): Promise<boolean> =>
  worker.withTenant({ tenantId: tenant }, (tx) =>
    f("marcarCredencialInvalida")(tx, c, tipo, "credencial_invalida"),
  );
const guardar = (tenant: string, c: string, tipo: Tipo, sobre = sobreFalso()) =>
  backend.withTenant({ tenantId: tenant }, (tx) =>
    f("guardarSobre")(tx, { clienteId: c, tipo, sobre }),
  );
const fila = async (id: string) =>
  (
    await admin.query(
      "select estado, estado_motivo, estado_at, ciphertext, nonce, tag, dek_envuelta, kek_id, updated_at from credencial where id = $1",
      [id],
    )
  ).rows[0];
const aMs = (v: unknown): number => new Date(v as string | Date).getTime();

// =================================================================================================
describe("marcarCredencialVerificada (D6, CA-5)", () => {
  it("con la versión vigente pasa a 'verificada': estado_at = ahora y motivo nulo", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    const v = await version(X, c.id, "sol");
    expect(v).not.toBeNull();
    const antes = Date.now();
    expect(await verificar(X, c.id, "sol", v)).toBe(true);
    const r = await fila(id);
    expect(r.estado).toBe("verificada");
    expect(r.estado_motivo).toBeNull();
    expect(r.estado_at).toBeInstanceOf(Date);
    expect(aMs(r.estado_at)).toBeGreaterThanOrEqual(antes - 2000);
    expect(aMs(r.estado_at)).toBeLessThanOrEqual(Date.now() + 2000);
    // el backend lee el mismo estado
    const leido = await backend.withTenant({ tenantId: X }, (tx) =>
      f("estadoCredencial")(tx, c.id, "sol"),
    );
    expect(leido).toBe("verificada");
  });

  it("una 'invalida' (con motivo) vuelve a 'verificada' y el motivo queda nulo (CA-6)", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sire_api");
    expect(await invalidar(X, c.id, "sire_api")).toBe(true);
    expect((await fila(id)).estado_motivo).toBe("credencial_invalida");
    const v = await version(X, c.id, "sire_api");
    expect(await verificar(X, c.id, "sire_api", v)).toBe(true);
    const r = await fila(id);
    expect(r.estado).toBe("verificada");
    expect(r.estado_motivo).toBeNull();
  });

  it("false si la versión cambió: un guardado entre la lectura y la marca gana y queda 'configurada'", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    const vieja = await version(X, c.id, "sol");
    const nuevo = sobreFalso();
    await guardar(X, c.id, "sol", nuevo);
    expect(await verificar(X, c.id, "sol", vieja)).toBe(false);
    const r = await fila(id);
    expect(r.estado).toBe("configurada");
    expect(r.estado_motivo).toBeNull();
    expect(Buffer.compare(r.ciphertext, nuevo.ciphertext)).toBe(0);
  });

  it("false con una versión inventada, con version null y sin credencial; nada cambia", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    const sinCred = await et.cliente(X);
    expect(await verificar(X, c.id, "sol", "1")).toBe(false);
    expect(await verificar(X, c.id, "sol", null)).toBe(false);
    expect(
      await verificar(X, sinCred.id, "sol", await version(X, c.id, "sol")),
    ).toBe(false);
    expect(await verificar(X, sinCred.id, "sol", null)).toBe(false);
    expect((await fila(id)).estado).toBe("configurada");
  });

  it("una versión ya usada no vale otra vez (la marca misma cambia el xmin de la fila)", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    const v = await version(X, c.id, "sol");
    expect(await verificar(X, c.id, "sol", v)).toBe(true);
    expect(await verificar(X, c.id, "sol", v)).toBe(false);
  });

  it("un guardado posterior la devuelve a 'configurada' (estado_at nuevo, motivo nulo)", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    expect(await verificar(X, c.id, "sol", await version(X, c.id, "sol"))).toBe(
      true,
    );
    const verificadaAt = (await fila(id)).estado_at as Date;
    await dormir(15);
    await guardar(X, c.id, "sol");
    const r = await fila(id);
    expect(r.estado).toBe("configurada");
    expect(r.estado_motivo).toBeNull();
    expect(aMs(r.estado_at)).toBeGreaterThan(aMs(verificadaAt));
  });

  it("solo toca el tipo y el cliente indicados", async () => {
    const c = await et.cliente(X);
    const otro = await et.cliente(X);
    const sol = await et.credencial(X, c.id, "sol");
    const sire = await et.credencial(X, c.id, "sire_api");
    const ajena = await et.credencial(X, otro.id, "sol");
    expect(await verificar(X, c.id, "sol", await version(X, c.id, "sol"))).toBe(
      true,
    );
    expect((await fila(sol)).estado).toBe("verificada");
    expect((await fila(sire)).estado).toBe("configurada");
    expect((await fila(ajena)).estado).toBe("configurada");
  });

  it("no cruza estudios: con el contexto de X no marca la credencial de un cliente de Y", async () => {
    const cy = await et.cliente(Y);
    const id = await et.credencial(Y, cy.id, "sol");
    const vY = await version(Y, cy.id, "sol");
    expect(await verificar(X, cy.id, "sol", vY)).toBe(false);
    expect((await fila(id)).estado).toBe("configurada");
  });

  it("el worker no toca el sobre: ciphertext, nonce, tag, dek_envuelta, kek_id y updated_at quedan idénticos", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    const antes = await fila(id);
    expect(await verificar(X, c.id, "sol", await version(X, c.id, "sol"))).toBe(
      true,
    );
    const despues = await fila(id);
    for (const k of ["ciphertext", "nonce", "tag", "dek_envuelta"]) {
      expect(Buffer.compare(despues[k], antes[k]), k).toBe(0);
    }
    expect(despues.kek_id).toBe(antes.kek_id);
    expect(aMs(despues.updated_at)).toBe(aMs(antes.updated_at));
  });

  it("el worker no puede escribir el sobre por SQL directo (42501) ni el backend marcar verificada (42501)", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    await expect(
      worker.withTenant({ tenantId: X }, (tx) =>
        tx.query(
          "update credencial set ciphertext = $2 where cliente_id = $1",
          [c.id, randomBytes(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      backend.withTenant({ tenantId: X }, (tx) =>
        f("marcarCredencialVerificada")(tx, c.id, "sol", "1"),
      ),
    ).rejects.toMatchObject({ codigo: "42501" });
  });
});

// =================================================================================================
describe("carrera guardar vs verificar (CA-5: «un guardado durante la verificación no se pisa»)", () => {
  it("30 rondas de guardarSobre (backend) contra marcarCredencialVerificada (worker): sin 40P01 ni error y siempre 'configurada' con el sobre del guardado", async () => {
    const c = await et.cliente(X);
    const id = await et.credencial(X, c.id, "sol");
    const errores: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await version(X, c.id, "sol");
      const nuevo = sobreFalso();
      const [g, m] = await Promise.allSettled([
        guardar(X, c.id, "sol", nuevo),
        verificar(X, c.id, "sol", v),
      ]);
      for (const r of [g, m]) {
        if (r.status === "rejected")
          errores.push(
            String(
              (r.reason as { codigo?: string; code?: string }).codigo ??
                r.reason,
            ),
          );
      }
      const r = await fila(id);
      // el guardado siempre es posterior a la versión leída: o llega después de la marca (el trigger reinicia el
      // estado) o antes (la marca ve otra versión y devuelve false). Jamás queda 'verificada' sobre un sobre nuevo.
      expect(r.estado, `ronda ${i}`).toBe("configurada");
      expect(
        Buffer.compare(r.ciphertext, nuevo.ciphertext),
        `ronda ${i}: sobre`,
      ).toBe(0);
    }
    expect(errores).toEqual([]);
  });

  it("guardar sol y sire_api del mismo cliente mientras el worker verifica ambos y completa los datos del RUC: sin 40P01", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    await et.credencial(X, c.id, "sire_api");
    const errores: string[] = [];
    for (let i = 0; i < 15; i++) {
      const vs = await version(X, c.id, "sol");
      const vi = await version(X, c.id, "sire_api");
      const tareas = [
        guardar(X, c.id, "sol"),
        guardar(X, c.id, "sire_api"),
        verificar(X, c.id, "sol", vs),
        verificar(X, c.id, "sire_api", vi),
        worker.withTenant({ tenantId: X }, (tx) =>
          f("completarDatosRuc")(tx, c.id, {
            razonSocial: "Razón consultada",
            estado: "ACTIVO",
            condicion: "HABIDO",
          }),
        ),
      ];
      for (const r of await Promise.allSettled(tareas)) {
        if (r.status === "rejected")
          errores.push(
            String(
              (r.reason as { codigo?: string; code?: string }).codigo ??
                r.reason,
            ),
          );
      }
    }
    expect(errores).toEqual([]);
    const e = await admin.query(
      "select tipo, estado from credencial where cliente_id = $1 order by tipo",
      [c.id],
    );
    expect(e.rows.map((x) => x.estado)).toEqual(["configurada", "configurada"]);
  });
});

// =================================================================================================
describe("leerEstadoCredenciales (D5)", () => {
  it("devuelve tipo, estado, fecha y motivo de cada credencial del cliente", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    await et.credencial(X, c.id, "sire_api");
    expect(await invalidar(X, c.id, "sire_api")).toBe(true);
    expect(await verificar(X, c.id, "sol", await version(X, c.id, "sol"))).toBe(
      true,
    );
    const filas: Array<{
      tipo: string;
      estado: string;
      fecha: unknown;
      motivo: string | null;
    }> = await backend.withTenant({ tenantId: X }, (tx) =>
      f("leerEstadoCredenciales")(tx, c.id),
    );
    const sol = filas.find((x) => x.tipo === "sol")!;
    const sire = filas.find((x) => x.tipo === "sire_api")!;
    expect(filas).toHaveLength(2);
    expect(sol).toMatchObject({ estado: "verificada", motivo: null });
    expect(Math.abs(aMs(sol.fecha) - Date.now())).toBeLessThan(60_000);
    expect(sire).toMatchObject({
      estado: "invalida",
      motivo: "credencial_invalida",
    });
    expect(Math.abs(aMs(sire.fecha) - Date.now())).toBeLessThan(60_000);
  });

  it("una configurada no trae motivo; un guardado le fija la fecha del guardado", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    await dormir(5);
    const antes = Date.now();
    await guardar(X, c.id, "sol");
    const filas = await backend.withTenant({ tenantId: X }, (tx) =>
      f("leerEstadoCredenciales")(tx, c.id),
    );
    const sol = filas.find((x: { tipo: string }) => x.tipo === "sol");
    expect(sol).toMatchObject({ estado: "configurada", motivo: null });
    expect(aMs(sol.fecha)).toBeGreaterThanOrEqual(antes - 2000);
  });

  it("cliente sin credenciales -> lista vacía (el servicio completa no_configurada)", async () => {
    const c = await et.cliente(X);
    expect(
      await backend.withTenant({ tenantId: X }, (tx) =>
        f("leerEstadoCredenciales")(tx, c.id),
      ),
    ).toEqual([]);
  });

  it("no expone columnas ni bytes del sobre (ni en las claves ni serializado en hex o base64)", async () => {
    const c = await et.cliente(X);
    const sobre = sobreFalso();
    await et.credencial(X, c.id, "sol"); // fila previa para que guardarSobre reemplace el sobre por el conocido
    await guardar(X, c.id, "sol", sobre);
    for (const rol of [backend, worker]) {
      const filas = await rol.withTenant({ tenantId: X }, (tx) =>
        f("leerEstadoCredenciales")(tx, c.id),
      );
      expect(filas).toHaveLength(1);
      expect(
        Object.keys(filas[0]).filter((k) => COLUMNAS_SOBRE.includes(k)),
      ).toEqual([]);
      const texto = JSON.stringify(filas);
      for (const b of [
        sobre.ciphertext,
        sobre.nonce,
        sobre.tag,
        sobre.dekEnvuelta,
      ]) {
        expect(texto).not.toContain(b.toString("hex"));
        expect(texto).not.toContain(b.toString("base64"));
      }
    }
  });

  it("no cruza estudios: con el contexto de Y no ve las credenciales del cliente de X", async () => {
    const c = await et.cliente(X);
    await et.credencial(X, c.id, "sol");
    expect(
      await backend.withTenant({ tenantId: Y }, (tx) =>
        f("leerEstadoCredenciales")(tx, c.id),
      ),
    ).toEqual([]);
  });
});

// =================================================================================================
describe("completarDatosRuc (D1, CA-9)", () => {
  const sembrarCliente = async (
    tenant: string,
    razon: string | null,
  ): Promise<ClientePrueba> => {
    const c = await et.cliente(tenant);
    // `et.cliente` crea con una razón social de prueba: se deja la provisional de 007a («RUC <ruc>») o la indicada.
    await admin.query("update cliente set razon_social = $2 where id = $1", [
      c.id,
      razon ?? `RUC ${c.ruc}`,
    ]);
    return c;
  };
  const leer = async (id: string) =>
    (await admin.query("select * from cliente where id = $1", [id])).rows[0];
  const completar = (
    tenant: string,
    id: string,
    d = {
      razonSocial: "EMPRESA CONSULTADA SAC",
      estado: "ACTIVO",
      condicion: "HABIDO",
    },
  ) =>
    worker.withTenant({ tenantId: tenant }, (tx) =>
      f("completarDatosRuc")(tx, id, d),
    );

  it("con la razón social provisional «RUC <ruc>» llena razón social, estado y condición", async () => {
    const c = await sembrarCliente(X, null);
    await completar(X, c.id);
    const r = await leer(c.id);
    expect(r.razon_social).toBe("EMPRESA CONSULTADA SAC");
    expect(r.estado_contribuyente).toBe("ACTIVO");
    expect(r.condicion_contribuyente).toBe("HABIDO");
  });

  it("no pisa una razón social editada: completa estado y condición y deja la razón intacta", async () => {
    const c = await sembrarCliente(X, "Nombre comercial editado a mano");
    await completar(X, c.id);
    const r = await leer(c.id);
    expect(r.razon_social).toBe("Nombre comercial editado a mano");
    expect(r.estado_contribuyente).toBe("ACTIVO");
    expect(r.condicion_contribuyente).toBe("HABIDO");
  });

  it("«RUC » de otro número, o con otro espaciado, no es la provisional y no se reemplaza", async () => {
    const a = await sembrarCliente(X, "RUC 20999999999");
    const b = await sembrarCliente(X, null);
    await admin.query("update cliente set razon_social = $2 where id = $1", [
      b.id,
      `ruc ${b.ruc}`,
    ]);
    const d = await sembrarCliente(X, null);
    await admin.query("update cliente set razon_social = $2 where id = $1", [
      d.id,
      `RUC  ${d.ruc}`,
    ]);
    await completar(X, a.id);
    await completar(X, b.id);
    await completar(X, d.id);
    expect((await leer(a.id)).razon_social).toBe("RUC 20999999999");
    expect((await leer(b.id)).razon_social).toBe(`ruc ${b.ruc}`);
    expect((await leer(d.id)).razon_social).toBe(`RUC  ${d.ruc}`);
  });

  it("solo escribe razón social, estado y condición: ruc, perfil, archivado y created_at no cambian", async () => {
    const c = await sembrarCliente(X, null);
    await admin.query(
      "update cliente set regimen = 'rmt', zona = 'amazonia', ventas_mixtas = true, moneda_habitual = 'USD' where id = $1",
      [c.id],
    );
    const antes = await leer(c.id);
    await completar(X, c.id);
    const despues = await leer(c.id);
    for (const k of [
      "id",
      "tenant_id",
      "ruc",
      "regimen",
      "zona",
      "ventas_exoneradas",
      "ventas_mixtas",
      "moneda_habitual",
    ]) {
      expect(despues[k], k).toEqual(antes[k]);
    }
    expect(despues.archivado_at).toEqual(antes.archivado_at);
    expect(aMs(despues.created_at)).toBe(aMs(antes.created_at));
  });

  it("no cruza estudios: con el contexto de X no toca al cliente de Y", async () => {
    const cy = await sembrarCliente(Y, null);
    await completar(X, cy.id);
    const r = await leer(cy.id);
    expect(r.razon_social).toBe(`RUC ${cy.ruc}`);
    expect(r.estado_contribuyente).toBeNull();
    expect(r.condicion_contribuyente).toBeNull();
  });

  it("un cliente inexistente no lanza ni crea nada", async () => {
    await expect(
      completar(X, "00000000-0000-4000-8000-000000000000"),
    ).resolves.not.toThrow();
  });

  it("una edición manual que confirma justo antes no se pisa (la comparación va en el mismo UPDATE)", async () => {
    const c = await sembrarCliente(X, null);
    const bloqueador = await admin.connect();
    try {
      await bloqueador.query("BEGIN");
      await bloqueador.query(
        "update cliente set razon_social = 'Editada en paralelo' where id = $1",
        [c.id],
      );
      const espera = completar(X, c.id); // se bloquea en la fila hasta el COMMIT de la edición
      await dormir(400);
      await bloqueador.query("COMMIT");
      await espera;
    } finally {
      await bloqueador.query("ROLLBACK").catch(() => undefined);
      bloqueador.release();
    }
    const r = await leer(c.id);
    expect(r.razon_social).toBe("Editada en paralelo");
    expect(r.estado_contribuyente).toBe("ACTIVO");
    expect(r.condicion_contribuyente).toBe("HABIDO");
  });

  it("repetir la llamada con los mismos datos es inocuo", async () => {
    const c = await sembrarCliente(X, null);
    await completar(X, c.id);
    await completar(X, c.id);
    const r = await leer(c.id);
    expect([
      r.razon_social,
      r.estado_contribuyente,
      r.condicion_contribuyente,
    ]).toEqual(["EMPRESA CONSULTADA SAC", "ACTIVO", "HABIDO"]);
  });
});

// =================================================================================================
describe("rucsExistentes (D8)", () => {
  const consultar = (tenant: string, rucs: string[]) =>
    backend.withTenant({ tenantId: tenant }, (tx) =>
      f("rucsExistentes")(tx, rucs),
    ) as Promise<Array<{ ruc: string; archivado: boolean }>>;
  const ordenar = (xs: Array<{ ruc: string; archivado: boolean }>) =>
    [...xs].sort((a, b) => a.ruc.localeCompare(b.ruc));

  it("informa los RUC existentes del estudio, activos y archivados, y omite los que no existen", async () => {
    const activo = await et.cliente(X);
    const archivado = await et.cliente(X);
    await admin.query("update cliente set archivado_at = now() where id = $1", [
      archivado.id,
    ]);
    const libre = "20123456786";
    const r = await consultar(X, [activo.ruc, archivado.ruc, libre]);
    expect(ordenar(r)).toEqual(
      ordenar([
        { ruc: activo.ruc, archivado: false },
        { ruc: archivado.ruc, archivado: true },
      ]),
    );
  });

  it("no ve los RUC de otro estudio (RLS)", async () => {
    const cy = await et.cliente(Y);
    expect(await consultar(X, [cy.ruc])).toEqual([]);
    expect(await consultar(Y, [cy.ruc])).toEqual([
      { ruc: cy.ruc, archivado: false },
    ]);
  });

  it("lista vacía -> []; repetidos en la entrada no duplican la salida", async () => {
    const c = await et.cliente(X);
    expect(await consultar(X, [])).toEqual([]);
    expect(await consultar(X, [c.ruc, c.ruc, c.ruc])).toEqual([
      { ruc: c.ruc, archivado: false },
    ]);
  });

  it("acepta el tope de la importación (1.000 RUC) en una sola consulta", async () => {
    const c = await et.cliente(X);
    const rucs = Array.from(
      { length: 999 },
      (_, i) => `2${String(i).padStart(10, "0")}`,
    );
    const r = await consultar(X, [...rucs, c.ruc]);
    expect(r.find((x) => x.ruc === c.ruc)).toEqual({
      ruc: c.ruc,
      archivado: false,
    });
  });

  it("tratar el RUC como dato: un valor con comillas o SQL no rompe ni devuelve filas", async () => {
    await expect(
      consultar(X, ["' or 1=1 --", "20123456786'; drop table cliente; --"]),
    ).resolves.toEqual([]);
  });
});

// =================================================================================================
describe("crearCliente con id explícito (D7)", () => {
  const rucNuevo = () =>
    `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

  it("usa el id indicado y devuelve ese mismo id", async () => {
    const id = randomUUID();
    const ruc = rucNuevo();
    const devuelto = await backend.withTenant({ tenantId: X }, (tx) =>
      f("crearCliente")(tx, X, { id, ruc, razonSocial: "Con id" }),
    );
    expect(devuelto).toBe(id);
    const r = (
      await admin.query(
        "select id, tenant_id, ruc, razon_social from cliente where id = $1",
        [id],
      )
    ).rows[0];
    expect(r).toMatchObject({ id, tenant_id: X, ruc, razon_social: "Con id" });
  });

  it("sin razón social guarda «RUC <ruc>» también con id explícito", async () => {
    const id = randomUUID();
    const ruc = rucNuevo();
    await backend.withTenant({ tenantId: X }, (tx) =>
      f("crearCliente")(tx, X, { id, ruc }),
    );
    expect(
      (
        await admin.query("select razon_social from cliente where id = $1", [
          id,
        ])
      ).rows[0].razon_social,
    ).toBe(`RUC ${ruc}`);
  });

  it("sin id sigue generando uno (UUID) distinto en cada alta", async () => {
    const a = await backend.withTenant({ tenantId: X }, (tx) =>
      f("crearCliente")(tx, X, { ruc: rucNuevo() }),
    );
    const b = await backend.withTenant({ tenantId: X }, (tx) =>
      f("crearCliente")(tx, X, { ruc: rucNuevo() }),
    );
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it("cliente y credencial con ese id en una sola transacción: el AAD cifrado antes sirve y la FK se cumple", async () => {
    const id = randomUUID();
    const ruc = rucNuevo();
    await backend.withTenant({ tenantId: X }, async (tx) => {
      await f("crearCliente")(tx, X, { id, ruc });
      await f("guardarSobre")(tx, {
        clienteId: id,
        tipo: "sol",
        sobre: sobreFalso(),
      });
    });
    const r = await admin.query(
      "select tenant_id, cliente_id, tipo from credencial where cliente_id = $1",
      [id],
    );
    expect(r.rows).toEqual([{ tenant_id: X, cliente_id: id, tipo: "sol" }]);
  });

  it("si la transacción falla después de crear el cliente con id, no quedan ni cliente ni credencial", async () => {
    const id = randomUUID();
    await expect(
      backend.withTenant({ tenantId: X }, async (tx) => {
        await f("crearCliente")(tx, X, { id, ruc: rucNuevo() });
        await f("guardarSobre")(tx, {
          clienteId: id,
          tipo: "sol",
          sobre: sobreFalso(),
        });
        throw new Error("fallo posterior");
      }),
    ).rejects.toThrow("fallo posterior");
    expect(
      (await admin.query("select 1 from cliente where id = $1", [id])).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query("select 1 from credencial where cliente_id = $1", [
          id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("un RUC repetido con id explícito sigue siendo RucDuplicadoError", async () => {
    const c = await et.cliente(X);
    await expect(
      backend.withTenant({ tenantId: X }, (tx) =>
        f("crearCliente")(tx, X, { id: randomUUID(), ruc: c.ruc }),
      ),
    ).rejects.toBeInstanceOf(exportado<new () => Error>("RucDuplicadoError"));
  });
});
