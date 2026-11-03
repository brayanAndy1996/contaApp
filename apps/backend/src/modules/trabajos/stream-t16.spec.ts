// T16 (backend, H-008-2a-6 = H-008-2b-9) · Unitarias: un evento de un cliente que no estaba en la lista del stream
// (creado o asignado con el stream abierto) no se descarta hasta la revalidación de 5 s: se recarga la lista una vez
// por cliente desconocido, en orden. Sin BD ni Redis: dobles. La vía real la fijan `stream-r2a`/`stream-r2b`.
import { EventEmitter } from "node:events";
import type { EventoTrabajo } from "@contapp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { RedisTrabajos } from "./redis.js";
import {
  StreamService,
  TIEMPOS_POR_DEFECTO,
  type RespuestaSse,
} from "./stream.service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const VIEJO = "33333333-3333-4333-8333-333333333333";
const NUEVO = "44444444-4444-4444-8444-444444444444";

const sesion = (): SesionResuelta => ({
  sesionId: "s-1",
  usuarioId: USUARIO,
  tenantActivo: TENANT,
  estudioRevocado: false,
  expiraAbsoluta: new Date(Date.now() + 3_600_000),
  token: "t",
});

const vista = (
  clienteId: string,
  estado: EventoTrabajo["estado"] = "ejecutando",
): EventoTrabajo => ({
  id: "55555555-5555-4555-8555-555555555555",
  tipo: "prueba.eco",
  clienteId,
  estado,
  posicion: null,
  intentos: 0,
  motivo: null,
  creadoEn: new Date(0).toISOString(),
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: null,
});

class SubFalso extends EventEmitter {
  status = "ready";
  subscribe = vi.fn(async () => undefined);
  unsubscribe = vi.fn(async () => undefined);
  quit = vi.fn(async () => undefined);
  disconnect = vi.fn(() => undefined);
}

class RespuestaFalsa extends EventEmitter implements RespuestaSse {
  texto = "";
  writableEnded = false;
  socket = { destroyed: false };
  status() {
    return this;
  }
  setHeader() {
    return this;
  }
  flushHeaders() {}
  write(t: string) {
    this.texto += t;
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

let sub: SubFalso;
let estado: { rol: string | null; clientes: string[]; falla: boolean };
let consultas: number;
let servicio: StreamService;

beforeEach(() => {
  vi.useFakeTimers();
  sub = new SubFalso();
  estado = { rol: "dueno", clientes: [VIEJO], falla: false };
  consultas = 0;
  const db = {
    withTenant: async (_c: unknown, fn: (tx: never) => unknown) => {
      consultas++;
      if (estado.falla) throw new Error("bd");
      return fn({
        query: async (texto: string) => {
          if (/from membresia/i.test(texto)) {
            const rows =
              estado.rol === null
                ? []
                : [{ usuario_id: USUARIO, rol: estado.rol }];
            return { rows, rowCount: rows.length };
          }
          const rows = estado.clientes.map((id) => ({ id }));
          return { rows, rowCount: rows.length };
        },
      } as never);
    },
  };
  servicio = new StreamService(
    db as never,
    { resolverSesion: vi.fn(async () => sesion()) } as never,
    new RedisTrabajos({ url: "redis://x", prefijo: "p:" }, () => sub as never),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const canal = `p:eventos:${TENANT}`;
const marco = (e: EventoTrabajo) =>
  `event: trabajo\ndata: ${JSON.stringify(e)}\n\n`;
const abrir = async () => {
  const r = new RespuestaFalsa();
  await servicio.abrir(sesion(), "c=x", r);
  return r;
};
const emitir = (e: EventoTrabajo) =>
  sub.emit("message", canal, JSON.stringify(e));

describe("StreamService · cliente que no estaba en la lista (H-008-2a-6)", () => {
  it("recarga la lista y entrega en orden los eventos del cliente nuevo, sin esperar la revalidación", async () => {
    const r = await abrir();
    estado.clientes = [VIEJO, NUEVO]; // creado con el stream abierto
    const antes = consultas;
    emitir(vista(NUEVO, "en_cola"));
    emitir(vista(NUEVO, "ejecutando"));
    emitir(vista(VIEJO)); // visible: sale enseguida
    expect(r.texto).toBe(marco(vista(VIEJO)));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.texto).toBe(
      marco(vista(VIEJO)) +
        marco(vista(NUEVO, "en_cola")) +
        marco(vista(NUEVO, "ejecutando")),
    );
    expect(consultas - antes).toBe(1); // una recarga para los dos eventos
    r.end();
  });

  it("error: un cliente que sigue sin verse se descarta y no se vuelve a consultar hasta la revalidación", async () => {
    const r = await abrir();
    const antes = consultas;
    emitir(vista(NUEVO));
    await vi.advanceTimersByTimeAsync(0);
    emitir(vista(NUEVO));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.texto).toBe("");
    expect(consultas - antes).toBe(1);
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.revalidacionMs); // revalidación: vuelve a poder consultar
    const tras = consultas;
    emitir(vista(NUEVO));
    await vi.advanceTimersByTimeAsync(0);
    expect(consultas - tras).toBe(1);
    expect(r.writableEnded).toBe(false);
    r.end();
  });

  it("error: si la recarga dice que ya no es miembro, cierra; si la BD falla, conserva la lista", async () => {
    const a = await abrir();
    estado.falla = true;
    emitir(vista(NUEVO));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.writableEnded).toBe(false);
    estado.falla = false;
    emitir(vista(VIEJO));
    expect(a.texto).toBe(marco(vista(VIEJO)));
    a.end();

    const b = await abrir();
    estado.rol = null;
    emitir(vista(NUEVO));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.writableEnded).toBe(true);
  });
});
