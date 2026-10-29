/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T6 (008) · CA-16 (RNF-004/083): una clave SOL, un `client_secret` y un token SIRE canario no aparecen en las
// respuestas de `/trabajos`, en el stream SSE, en Redis ni en los logs del backend. Los canarios viajan donde un
// descuido los dejaría pasar: los parámetros del trabajo, su `resultado`, el RUC del cliente y el mensaje de Redis.
// Rojo: las rutas aún no existen (T11): hoy `/trabajos` responde 404 (las aserciones sobre la forma de la vista fallan).
//
// Contrato fijado por estas pruebas (T11): ni la lista, ni el 200 de cancelar, ni sus errores (403, 404, 409), ni los
// eventos SSE llevan `ruc`, `tenantId`, `parametros`, `resultado` ni la clave de dedupe; el backend no escribe en los
// logs ni parámetros, ni resultado, ni RUC, ni el mensaje de Redis; y en Redis solo hay IDs (jobId, tenantId).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  emitir,
  emitirCrudo,
  esEventoId,
  esperarSuscripcion,
  leerVista,
  vistaCon,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";
import { capturarLogs } from "../../../test/soporte.js";

const sufijo = randomBytes(6).toString("hex");
const CANARIOS = {
  sol: `CANARIO-SOL-${sufijo}`,
  secret: `CANARIO-SECRET-${sufijo}`,
  token: `CANARIO-TOKEN-${sufijo}`,
};
const TODOS = Object.values(CANARIOS);
const PROHIBIDAS =
  /"(ruc|tenantId|tenant_id|parametros|resultado|claveDedupe|clave_dedupe)"/;

let b: BancoTrabajos;
let E: Estudio;
let asistente: Actor;
let cliente: string;
let ruc: string;
let tEnCola: string;
let tEjecutando: string;
let tTerminado: string;

/** Busca canarios, el RUC y el estudio en cualquier texto. */
function fugas(texto: string): string[] {
  return [...TODOS, ruc, E.tenantId].filter((m) => texto.includes(m));
}

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  [cliente] = (await b.clientes(E.tenantId, 1)) as [string];
  ruc = (await b.sql("select ruc from cliente where id = $1", [cliente]))[0]
    .ruc;
  asistente = await b.miembro(E.tenantId, "asistente");
  await b.asignar(E.tenantId, cliente, asistente.id, "colaborador");
  const canarioResultado = {
    clave_sol: CANARIOS.sol,
    client_secret: CANARIOS.secret,
    token: CANARIOS.token,
  };
  tEnCola = (
    await b.sembrar(E.tenantId, cliente, {
      rango: CANARIOS.sol,
      creadoPor: asistente.id,
    })
  ).id;
  tEjecutando = (
    await b.sembrar(E.tenantId, cliente, {
      rango: CANARIOS.secret,
      estado: "ejecutando",
      resultado: canarioResultado,
      creadoPor: asistente.id,
    })
  ).id;
  tTerminado = (
    await b.sembrar(E.tenantId, cliente, {
      rango: CANARIOS.token,
      estado: "error",
      motivo: "credencial_invalida",
      intentos: 1,
      resultado: canarioResultado,
      creadoPor: asistente.id,
    })
  ).id;
});
afterAll(async () => {
  cerrarSseAbiertos();
  await b?.cerrar();
});

describe("CA-16 · respuestas HTTP", () => {
  it("la lista no trae canarios, RUC, estudio ni claves internas, y los trabajos sembrados sí están (no es vacía)", async () => {
    for (const quien of [E.titular, asistente]) {
      const r = await b.llamar(quien, "GET", "/trabajos");
      expect(r.status).toBe(200);
      expect(r.body.map((x: any) => x.id).sort()).toEqual(
        [tEnCola, tEjecutando, tTerminado].sort(),
      );
      const texto = `${r.text}\n${JSON.stringify(r.headers)}`;
      expect(fugas(texto)).toEqual([]);
      expect(texto).not.toMatch(PROHIBIDAS);
    }
    const filtrada = await b.llamar(
      E.titular,
      "GET",
      `/trabajos?clienteId=${cliente}&estado=error`,
    );
    expect(filtrada.body.map((x: any) => x.id)).toEqual([tTerminado]);
    expect(fugas(filtrada.text)).toEqual([]);
  });

  it("cancelar (200, 403, 404 y 409) no devuelve canarios ni datos internos", async () => {
    const otro = await b.miembro(E.tenantId, "contador");
    await b.asignar(E.tenantId, cliente, otro.id, "colaborador");
    const respuestas = [
      await b.llamar(otro, "POST", `/trabajos/${tEnCola}/cancelar`), // 403: visible pero no es el creador
      await b.llamar(E.titular, "POST", `/trabajos/${tEjecutando}/cancelar`), // 409
      await b.llamar(E.titular, "POST", `/trabajos/${tTerminado}/cancelar`), // 409
      await b.llamar(
        E.titular,
        "POST",
        `/trabajos/${randomBytes(16).toString("hex")}/cancelar`,
      ), // 404
      await b.llamar(asistente, "POST", `/trabajos/${tEnCola}/cancelar`, {
        rango: CANARIOS.sol,
        token: CANARIOS.token,
      }), // 200 (creador)
    ];
    expect(respuestas.map((r) => r.status)).toEqual([403, 409, 409, 404, 200]);
    for (const r of respuestas) {
      const texto = `${r.text}\n${JSON.stringify(r.headers)}`;
      expect(fugas(texto)).toEqual([]);
      expect(texto).not.toMatch(PROHIBIDAS);
    }
    // El cuerpo enviado (con canarios) no se refleja ni se guarda en la fila.
    const fila = await b.fila(tEnCola);
    expect(JSON.stringify(fila.motivo ?? "")).not.toContain("CANARIO");
  });
});

describe("CA-16 · eventos SSE", () => {
  it("un evento válido y un mensaje con canarios y campos internos salen solo con las claves de la vista", async () => {
    const s = await abrirSse(b.h, {
      cookie: E.titular.cookie,
      estudio: E.tenantId,
    });
    expect(s.status).toBe(200);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const vista = vistaCon(await leerVista(b.h, tEjecutando), {
      estado: "completado",
      terminadoEn: new Date().toISOString(),
    });
    await emitir(b.redis, b.prefijo, E.tenantId, vista);
    const sucio = {
      ...vistaCon(vista, { estado: "error", motivo: "credencial_invalida" }),
      ruc,
      tenantId: E.tenantId,
      parametros: { rango: CANARIOS.sol },
      resultado: { token: CANARIOS.token },
      mensaje: `fallo con ${CANARIOS.secret}`,
    };
    await emitirCrudo(b.redis, b.prefijo, E.tenantId, JSON.stringify(sucio));
    const fin = await s.esperar(
      (e) => e.json?.id === vista.id && e.json.estado === "error",
      2000,
    );
    expect(
      fin,
      "no llegó el evento con campos de más (debió salir limpio)",
    ).not.toBeNull();
    expect(s.eventos.length).toBeGreaterThanOrEqual(2);
    expect(fugas(s.texto)).toEqual([]);
    expect(s.texto).not.toMatch(PROHIBIDAS);
    expect(s.texto).not.toContain("mensaje");
    s.cerrar();
  });

  it("el asistente tampoco recibe canarios en sus eventos", async () => {
    const s = await abrirSse(b.h, {
      cookie: asistente.cookie,
      estudio: E.tenantId,
    });
    expect(s.status).toBe(200);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const vista = vistaCon(await leerVista(b.h, tTerminado), {
      estado: "error",
    });
    await emitir(b.redis, b.prefijo, E.tenantId, vista);
    expect(await s.esperar(esEventoId(vista.id), 2000)).not.toBeNull();
    expect(fugas(s.texto)).toEqual([]);
    s.cerrar();
  });
});

describe("CA-16 · Redis y logs", () => {
  it("en Redis solo hay IDs: ninguna clave ni valor del prefijo trae canarios ni el RUC", async () => {
    // Con la API en pie (si no, esta comprobación sería sobre lo que solo dejó la siembra).
    expect((await b.llamar(E.titular, "GET", "/trabajos")).status).toBe(200);
    const claves: string[] = await b.redis.keys(`${b.prefijo}*`);
    expect(
      claves.length,
      "la prueba no es vacía: encolar deja la pista en Redis",
    ).toBeGreaterThan(0);
    const volcado: string[] = [...claves];
    for (const k of claves) {
      const tipo = await b.redis.type(k);
      if (tipo === "zset")
        volcado.push(
          JSON.stringify(await b.redis.zrange(k, "0", "-1", "WITHSCORES")),
        );
      else if (tipo === "set")
        volcado.push(JSON.stringify(await b.redis.smembers(k)));
      else if (tipo === "string") volcado.push(String(await b.redis.get(k)));
    }
    expect(
      [...TODOS, ruc].filter((m) => volcado.join("\n").includes(m)),
    ).toEqual([]);
  });

  it("los logs del backend durante lista, cancelar, errores y stream no traen canarios, RUC ni parámetros", async () => {
    const nuevo = await b.sembrar(E.tenantId, cliente, {
      rango: CANARIOS.sol,
      creadoPor: asistente.id,
    });
    const { logs } = await capturarLogs(async () => {
      await b.llamar(E.titular, "GET", "/trabajos");
      await b.llamar(
        E.titular,
        "GET",
        `/trabajos?clienteId=${cliente}&estado=${CANARIOS.token}`,
      ); // 400
      await b.llamar(
        E.titular,
        "GET",
        `/trabajos?clienteId=${CANARIOS.secret}`,
      ); // 404
      await b.llamar(E.titular, "POST", `/trabajos/${CANARIOS.sol}/cancelar`, {
        token: CANARIOS.token,
      }); // 404
      await b.llamar(E.titular, "POST", `/trabajos/${tEjecutando}/cancelar`); // 409
      const s = await abrirSse(b.h, {
        cookie: E.titular.cookie,
        estudio: E.tenantId,
      });
      await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
      await emitirCrudo(
        b.redis,
        b.prefijo,
        E.tenantId,
        `no json ${CANARIOS.secret} ${ruc}`,
      ); // mensaje inválido
      await emitirCrudo(
        b.redis,
        b.prefijo,
        E.tenantId,
        JSON.stringify({ id: CANARIOS.sol, ruc, token: CANARIOS.token }),
      );
      await new Promise((r) => setTimeout(r, 500));
      s.cerrar();
      await b.llamar(E.titular, "POST", `/trabajos/${nuevo.id}/cancelar`); // 200
    });
    expect(fugas(logs)).toEqual([]);
    expect(logs).not.toContain(E.tenantId);
  });
});
