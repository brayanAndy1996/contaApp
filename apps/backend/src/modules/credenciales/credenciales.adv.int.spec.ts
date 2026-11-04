/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b T16 · ronda adversarial (caja negra, luego blanca) de las rutas de credenciales (D3–D6, D11; CA-4, CA-10).
// Solo el contrato público: HTTP, `crearApp` y las tablas. Las claves son CANARIOS sintéticos.
// Una prueba que falla es un hallazgo `H-007b-n` (tasks.md, T16); las que pasan quedan como regresión.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoCola,
  canario,
  filtrados,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import { capturarLogs, forma } from "../../../test/soporte.js";

let b: BancoCola;
let E: Estudio;

beforeAll(async () => {
  b = await abrirBancoCola();
  E = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const llamar = (
  a: Actor,
  m: "GET" | "POST" | "PUT",
  ruta: string,
  cuerpo?: unknown,
  extra: Record<string, unknown> = {},
) => b.c.p.b.llamar(a, m, ruta, cuerpo, extra);
const guardar = (a: Actor, clienteId: string, tipo: string, cuerpo: unknown) =>
  llamar(a, "PUT", `/clientes/${clienteId}/credenciales/${tipo}`, cuerpo);
const verificar = (a: Actor, clienteId: string, tipo: string) =>
  llamar(a, "POST", `/clientes/${clienteId}/credenciales/${tipo}/verificar`);
const estado = (a: Actor, clienteId: string) =>
  llamar(a, "GET", `/clientes/${clienteId}/credenciales`);
const trabajosDe = (clienteId: string) =>
  b.sql(
    "select id from job_registro where cliente_id = $1 and tipo like 'credencial.%'",
    [clienteId],
  );
const SOL = (u: string, k: string) => ({ usuario: u, clave: k });

describe("T16 · alcance en credenciales y verificar (caja negra)", () => {
  it("adv-c1: un contador NO asignado a un cliente archivado recibe el mismo 404 que uno inexistente, no 409 (oráculo de existencia)", async () => {
    const contador = await b.c.p.b.miembro(E.tenantId, "contador");
    const archivado = (
      await b.c.sembrar(E.tenantId, { archivado: true, sol: "configurada" })
    ).id;
    const inexistente = randomUUID();
    const k = canario("clave");
    for (const [ruta, m, cuerpo] of [
      ["credenciales/sol", "PUT", SOL("u", k)],
      ["credenciales/sol/verificar", "POST", undefined],
    ] as const) {
      const r1 = await llamar(
        contador,
        m,
        `/clientes/${archivado}/${ruta}`,
        cuerpo,
      );
      const r2 = await llamar(
        contador,
        m,
        `/clientes/${inexistente}/${ruta}`,
        cuerpo,
      );
      expect(r1.status, `${m} ${ruta}: ${r1.text}`).toBe(404);
      expect(forma(r1).body).toEqual(forma(r2).body);
      expect(filtrados([k], r1.text, r1.headers)).toEqual([]);
    }
    expect(await trabajosDe(archivado)).toHaveLength(0);
  });

  it("adv-c2: desasignado o con la membresía desactivada en mitad de la sesión: no guarda, no verifica ni lee (sin tocar el sobre)", async () => {
    const contador = await b.c.p.b.miembro(E.tenantId, "contador");
    const cl = (await b.c.sembrar(E.tenantId, { responsable: contador.id })).id;
    expect(
      (await guardar(contador, cl, "sol", SOL("u", canario("k1")))).status,
    ).toBe(200);
    const huella = await b.c.huellaCredenciales(cl);

    await b.sql(
      "delete from asignacion where cliente_id = $1 and usuario_id = $2",
      [cl, contador.id],
    );
    expect(
      (await guardar(contador, cl, "sol", SOL("u", canario("k2")))).status,
    ).toBe(404);
    expect((await verificar(contador, cl, "sol")).status).toBe(404);
    expect((await estado(contador, cl)).status).toBe(404);
    expect(await b.c.huellaCredenciales(cl)).toEqual(huella);

    // Reasignado pero con la membresía desactivada: la sesión viva no basta.
    await b.c.p.b.asignar(E.tenantId, cl, contador.id, "responsable");
    await b.sql(
      "update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2",
      [E.tenantId, contador.id],
    );
    const r = await guardar(contador, cl, "sol", SOL("u", canario("k3")));
    expect([401, 403, 404], r.text).toContain(r.status);
    const v = await verificar(contador, cl, "sol");
    expect([401, 403, 404], v.text).toContain(v.status);
    expect(await b.c.huellaCredenciales(cl)).toEqual(huella);
    expect(await trabajosDe(cl)).toHaveLength(0);
  });
});

describe("T16 · «Cancelar» del panel (T15) se muestra sin mirar el permiso (caja blanca)", () => {
  it("adv-c5: quien ve el trabajo de verificar pero no tiene credenciales.editar no lo cancela, tampoco si lo creó y luego bajó a lectura", async () => {
    const lectura = await b.c.p.b.miembro(E.tenantId, "lectura");
    const contador = await b.c.p.b.miembro(E.tenantId, "contador");
    const cl = (
      await b.c.sembrar(E.tenantId, {
        responsable: contador.id,
        colaboradores: [lectura.id],
      })
    ).id;
    expect(
      (await guardar(E.titular, cl, "sol", SOL("u", canario("k")))).status,
    ).toBe(200);

    // (1) Lo encola el Dueño; lectura (colaborador) lo ve en el panel y pulsa «Cancelar».
    const v1 = await verificar(E.titular, cl, "sol");
    expect(v1.status, v1.text).toBe(202);
    const lista = await llamar(lectura, "GET", "/trabajos");
    expect(lista.status).toBe(200);
    expect(lista.body.map((t: any) => t.id)).toContain(v1.body.id);
    const c1 = await llamar(
      lectura,
      "POST",
      `/trabajos/${v1.body.id}/cancelar`,
    );
    expect(c1.status, c1.text).toBe(403);
    expect(
      (
        await b.sql("select estado from job_registro where id = $1", [
          v1.body.id,
        ])
      )[0].estado,
    ).toBe("en_cola");
    await b.sql("update job_registro set estado = 'completado' where id = $1", [
      v1.body.id,
    ]);

    // (2) Lo encola el contador y luego su rol baja a lectura (pierde credenciales.editar) con la sesión viva.
    const v2 = await verificar(contador, cl, "sol");
    expect(v2.status, v2.text).toBe(202);
    await b.sql(
      "update membresia set rol = 'lectura' where tenant_id = $1 and usuario_id = $2",
      [E.tenantId, contador.id],
    );
    const c2 = await llamar(
      contador,
      "POST",
      `/trabajos/${v2.body.id}/cancelar`,
    );
    expect(
      c2.status,
      `el creador degradado a lectura cancela: ${c2.status}`,
    ).toBe(403);
  });
});

describe("T16 · el secreto no se refleja con entradas hostiles (caja negra)", () => {
  it("adv-c3: JSON roto, sustituto suelto y bordes de 256 B UTF-8: 400 sin el canario en respuesta ni logs; 256 B exactos se aceptan", async () => {
    const cl = (await b.c.sembrar(E.tenantId)).id;
    const k = canario("roto");
    const crudos = [
      `{"usuario":"u","clave":${k}}`, // sin comillas: V8 cita un fragmento del texto en el SyntaxError
      `{"usuario":"u","clave":"${k}"`, // sin cierre
      `{"usuario":"u","clave":"${k}\\ud800"}`, // sustituto suelto
      `{"usuario":"u","clave":"${k}","clave":"${k}\u0000"}`, // clave repetida con NUL
    ];
    for (const crudo of crudos) {
      const { resultado: r, logs } = await capturarLogs(() =>
        llamar(
          E.titular,
          "PUT",
          `/clientes/${cl}/credenciales/sol`,
          undefined,
          { crudo },
        ),
      );
      expect(r.status, crudo).not.toBe(500);
      expect(filtrados([k], r.text, r.headers, logs), crudo).toEqual([]);
    }
    // Cuerpo por encima del límite JSON (16 kB) con el canario: 413/400 sin eco.
    const { resultado: grande, logs: logsGrande } = await capturarLogs(() =>
      guardar(E.titular, cl, "sol", SOL("u", `${k}${"x".repeat(20_000)}`)),
    );
    expect([400, 413], grande.text).toContain(grande.status);
    expect(filtrados([k], grande.text, grande.headers, logsGrande)).toEqual([]);
    // El sustituto suelto no puede guardarse (no es UTF-8): 400.
    const sust = await llamar(
      E.titular,
      "PUT",
      `/clientes/${cl}/credenciales/sol`,
      undefined,
      {
        crudo: `{"usuario":"u","clave":"a\\ud800b"}`,
      },
    );
    expect(sust.status, sust.text).toBe(400);
    // 64 emojis de 4 B = 256 B: válido; 65 = 260 B: 400.
    expect(
      (await guardar(E.titular, cl, "sol", SOL("u", "😀".repeat(64)))).status,
    ).toBe(200);
    expect(
      (await guardar(E.titular, cl, "sol", SOL("u", "😀".repeat(65)))).status,
    ).toBe(400);
  });

  it("adv-c4: tipos y claves de objeto hostiles (__proto__, constructor, mayúsculas) nunca dan 500 ni escriben", async () => {
    const cl = (await b.c.sembrar(E.tenantId)).id;
    const k = canario("proto");
    for (const tipo of [
      "__proto__",
      "constructor",
      "toString",
      "SOL",
      "sol%20",
      "sire_api%00",
      "hasOwnProperty",
    ]) {
      const r = await guardar(E.titular, cl, tipo, SOL("u", k));
      expect([400, 404], `${tipo}: ${r.status} ${r.text}`).toContain(r.status);
      expect(filtrados([k], r.text), tipo).toEqual([]);
      const v = await verificar(E.titular, cl, tipo);
      expect([400, 404], `verificar ${tipo}: ${v.status}`).toContain(v.status);
    }
    const crudo = `{"__proto__":{"clave":"${k}"},"constructor":{"prototype":{"x":1}},"usuario":"u"}`;
    const r = await llamar(
      E.titular,
      "PUT",
      `/clientes/${cl}/credenciales/sol`,
      undefined,
      { crudo },
    );
    expect(r.status, r.text).toBe(400);
    expect(await b.credenciales(cl)).toHaveLength(0);
    expect(await trabajosDe(cl)).toHaveLength(0);
  });
});
