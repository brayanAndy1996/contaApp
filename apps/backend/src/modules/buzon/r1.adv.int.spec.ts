/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T16 · ronda adversarial 1 (backend, HTTP). Caja negra: rutas de D-8 y «Revisar ahora» (D-6) con ids en otra
// grafía y un cliente desasignado con la sesión viva. Caja blanca: la clave de dedupe sale del `clienteId` crudo de la ruta
// (`claveDedupe(tipo, clienteId, …)` en `encolar` de @contapp/queue) mientras la guarda de alcance acepta el UUID sin
// distinguir mayúsculas; el programador calcula la clave en SQL con el UUID en minúsculas.
// Hallazgos marcados con `it.fails` (H-023-1-n); sin la marca, quedan en rojo.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";
import { capturarLogs } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let b: BancoBuzon;
let E: Estudio;
let contador: Actor;
let asistente: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await b?.cerrar();
});

const nuevo = () =>
  b.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const vivos = async (clienteId: string, tipo: string) =>
  (await b.trabajos(clienteId, tipo)).filter((t: any) =>
    ["en_cola", "ejecutando"].includes(t.estado),
  );

describe("H-023-1-1 · el UUID del cliente en mayúsculas parte la clave de dedupe (CA-2, CA-4, D-6)", () => {
  it.fails(
    "«Revisar ahora» con el id en mayúsculas y una captura programada en cola: devuelve la viva elevada (200), no crea otra",
    async () => {
      const c = await nuevo();
      const programada = await b.sembrarRevisarVivo(E.tenantId, c.id, {
        prioridad: "programado",
      });
      const r = await b.llamar(
        contador,
        "POST",
        `/clientes/${c.id.toUpperCase()}/buzon/revisar`,
      );
      // La misma petición con el id en minúsculas da 200 con `programada` (revisar.int.spec.ts).
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.trabajo.id).toBe(programada);
      const v = await vivos(c.id, "sol.buzon.revisar");
      expect(v).toHaveLength(1);
      expect(v[0].prioridad).toBe("interactivo");
    },
  );

  it.fails(
    "«Abrir» el mismo mensaje con el id del cliente en minúsculas y luego en mayúsculas: un solo trabajo (202 y 200)",
    async () => {
      const c = await nuevo();
      const m = await b.sembrarMensaje(E.tenantId, c.id, { critico: true });
      const r1 = await b.llamar(
        contador,
        "POST",
        `/clientes/${c.id}/buzon/mensajes/${m.id}/abrir`,
      );
      expect(r1.status).toBe(202);
      const r2 = await b.llamar(
        contador,
        "POST",
        `/clientes/${c.id.toUpperCase()}/buzon/mensajes/${m.id}/abrir`,
      );
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(r2.body.trabajo.id).toBe(r1.body.trabajo.id);
      expect(await vivos(c.id, "sol.buzon.abrir")).toHaveLength(1);
    },
  );
});

describe("CA-10 · canarios de usuario y clave SOL en respuestas, cabeceras y logs del buzón", () => {
  it("ni las cinco rutas, ni sus errores, ni el panel de trabajos, ni los logs contienen el usuario o la clave SOL", async () => {
    const c = await nuevo();
    const usuarioSol = `USRSOL${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const claveSol = `clave-${randomUUID()}`;
    const g = await b.v.b.c.p.b.llamar(
      E.titular,
      "PUT",
      `/clientes/${c.id}/credenciales/sol`,
      {
        usuario: usuarioSol,
        clave: claveSol,
      },
    );
    expect(g.status, JSON.stringify(g.body)).toBeLessThan(300);
    const m = await b.sembrarMensaje(E.tenantId, c.id, { contenido: "Texto." });
    const a = await b.sembrarAdjunto(E.tenantId, c.id, m.id);
    const m2 = await b.sembrarMensaje(E.tenantId, c.id, {});
    const base = `/clientes/${c.id}/buzon`;
    const { resultado, logs } = await capturarLogs(async () => [
      await b.llamar(contador, "POST", `${base}/revisar`),
      await b.llamar(contador, "POST", `${base}/revisar`), // 200 con la viva
      await b.llamar(contador, "GET", `${base}/mensajes`),
      await b.llamar(contador, "GET", `${base}/mensajes/${m.id}`),
      await b.llamar(contador, "POST", `${base}/mensajes/${m2.id}/abrir`),
      await b.llamar(contador, "POST", `${base}/mensajes/${m.id}/abrir`), // ya obtenido
      await b.llamar(contador, "GET", `${base}/mensajes/${randomUUID()}`), // 404
      await b.bin(contador, "GET", `${base}/mensajes/${m.id}/adjuntos/${a.id}`),
      await b.llamar(contador, "GET", "/trabajos"),
      await b.llamar(contador, "GET", `/clientes/${c.id}/credenciales`),
    ]);
    expect(resultado.map((r) => r.status)).toEqual([
      202, 200, 200, 200, 202, 200, 404, 200, 200, 200,
    ]);
    const todo = [
      logs,
      ...resultado.map((r: any) =>
        [
          JSON.stringify(r.body ?? null),
          r.texto ?? r.text ?? "",
          JSON.stringify(r.headers),
        ].join("\n"),
      ),
    ].join("\n");
    for (const s of [usuarioSol, claveSol, usuarioSol.toLowerCase()])
      expect(todo.includes(s), "canario SOL filtrado").toBe(false);
  });
});

describe("Permisos y alcance: cliente desasignado con la sesión viva (CA-9)", () => {
  it("tras retirar la asignación, la misma sesión recibe 404 en las cinco rutas y no encola nada", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      contenido: "Texto del mensaje.",
      declarados: 1,
    });
    const a = await b.sembrarAdjunto(E.tenantId, c.id, m.id);
    const m2 = await b.sembrarMensaje(E.tenantId, c.id, {});
    const base = `/clientes/${c.id}/buzon`;
    // Con la asignación: lee.
    expect((await b.llamar(asistente, "GET", `${base}/mensajes`)).status).toBe(
      200,
    );

    const q = await b.llamar(
      E.titular,
      "DELETE",
      `/clientes/${c.id}/asignaciones/${asistente.id}`,
    );
    expect(q.status, JSON.stringify(q.body)).toBe(204);

    const respuestas = [
      await b.llamar(asistente, "GET", `${base}/mensajes`),
      await b.llamar(asistente, "GET", `${base}/mensajes/${m.id}`),
      await b.bin(
        asistente,
        "GET",
        `${base}/mensajes/${m.id}/adjuntos/${a.id}`,
      ),
      await b.llamar(asistente, "POST", `${base}/revisar`),
      await b.llamar(asistente, "POST", `${base}/mensajes/${m2.id}/abrir`),
    ];
    expect(respuestas.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(await b.trabajos(c.id, "sol.buzon.revisar")).toHaveLength(0);
    expect(await b.trabajos(c.id, "sol.buzon.abrir")).toHaveLength(0);
  });
});
