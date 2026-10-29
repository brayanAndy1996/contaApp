// T11 (008) · Unitarias de lo que las pruebas HTTP de T6 no cubren: cierre del stream a los 5 min, cierre ordenado
// del suscriptor, 429 al 4.º stream, revalidación que cierra y reconexión del suscriptor. Sin BD ni Redis: dobles.
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
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const OTRO_CLIENTE = "44444444-4444-4444-8444-444444444444";

const sesion = (o: Partial<SesionResuelta> = {}): SesionResuelta => ({
  sesionId: "s-1",
  usuarioId: USUARIO,
  tenantActivo: TENANT,
  estudioRevocado: false,
  expiraAbsoluta: new Date(Date.now() + 3_600_000),
  token: "t",
  ...o,
});

const vista = (clienteId = CLIENTE): EventoTrabajo => ({
  id: "55555555-5555-4555-8555-555555555555",
  tipo: "prueba.eco",
  clienteId,
  estado: "ejecutando",
  posicion: null,
  intentos: 1,
  motivo: null,
  creadoEn: new Date(0).toISOString(),
  iniciadoEn: new Date(0).toISOString(),
  terminadoEn: null,
  creadoPor: null,
});

class RedisFalso extends EventEmitter {
  status = "ready";
  canales = new Set<string>();
  falla = false;
  subscribe = vi.fn(async (c: string) => {
    if (this.falla) throw new Error("caído");
    this.canales.add(c);
  });
  unsubscribe = vi.fn(async (c: string) => {
    this.canales.delete(c);
  });
  quit = vi.fn(async () => {
    this.status = "end";
  });
  disconnect = vi.fn(() => {
    this.status = "end";
  });
}

class RespuestaFalsa extends EventEmitter implements RespuestaSse {
  estado = 0;
  cabeceras: Record<string, string> = {};
  texto = "";
  writableEnded = false;
  socket: { destroyed: boolean } | null = { destroyed: false };
  status(n: number) {
    this.estado = n;
    return this;
  }
  setHeader(n: string, v: string) {
    this.cabeceras[n.toLowerCase()] = v;
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

/** BD falsa: `withTenant` ejecuta el callback con una tx cuyas consultas devuelven el rol y las asignaciones. */
function dbFalsa(estado: { rol: string | null; clientes: string[] }) {
  return {
    withTenant: vi.fn(async (_ctx: unknown, fn: (tx: never) => unknown) =>
      fn({
        query: async (texto: string) => {
          if (/from membresia/i.test(texto)) {
            return {
              rows:
                estado.rol === null
                  ? []
                  : [{ usuario_id: USUARIO, rol: estado.rol }],
              rowCount: estado.rol === null ? 0 : 1,
            };
          }
          const rows = estado.clientes.map((id) => ({ id }));
          return { rows, rowCount: rows.length };
        },
      } as never),
    ),
  };
}

let sub: RedisFalso;
let redis: RedisTrabajos;
let estado: { rol: string | null; clientes: string[] };
let resolver: ReturnType<typeof vi.fn>;
let servicio: StreamService;

beforeEach(() => {
  vi.useFakeTimers();
  sub = new RedisFalso();
  redis = new RedisTrabajos(
    { url: "redis://x", prefijo: "p:" },
    () => sub as never,
  );
  estado = { rol: "dueno", clientes: [] };
  resolver = vi.fn(async () => sesion());
  servicio = new StreamService(
    dbFalsa(estado) as never,
    { resolverSesion: resolver } as never,
    redis,
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const canal = `p:eventos:${TENANT}`;
const abrir = async (s = sesion()) => {
  const r = new RespuestaFalsa();
  await servicio.abrir(s, "contapp_sesion=x", r);
  return r;
};

describe("StreamService · apertura y límites", () => {
  it("abre con 200 text/event-stream sin evento inicial y se suscribe una vez por estudio", async () => {
    const a = await abrir();
    const b = await abrir();
    expect(a.estado).toBe(200);
    expect(a.cabeceras["content-type"]).toMatch(/^text\/event-stream/);
    expect(a.cabeceras["cache-control"]).toBe("no-store");
    expect(a.texto).toBe("");
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.canales.has(canal)).toBe(true);
    expect(servicio.abiertos).toBe(2);
    b.end();
    a.end();
  });

  it("el 4.º stream de la sesión es 429 streams_excedidos; otra sesión cuenta aparte; cerrar libera el cupo", async () => {
    const r = [await abrir(), await abrir(), await abrir()];
    await expect(abrir()).rejects.toMatchObject({
      codigo: "streams_excedidos",
    });
    await expect(abrir(sesion({ sesionId: "s-2" }))).resolves.toBeDefined();
    r[0]!.end();
    await expect(abrir()).resolves.toBeDefined();
  });

  it("sin membresía activa responde estudio_requerido y no reserva cupo ni se suscribe", async () => {
    estado.rol = null;
    for (let i = 0; i < 4; i++) {
      await expect(abrir()).rejects.toMatchObject({
        codigo: "estudio_requerido",
      });
    }
    expect(sub.subscribe).not.toHaveBeenCalled();
    estado.rol = "dueno";
    await expect(abrir()).resolves.toBeDefined();
  });

  it("si la BD falla al cargar el alcance, propaga el error y libera el cupo", async () => {
    const roto = new StreamService(
      {
        withTenant: vi.fn(async () => {
          throw new Error("bd");
        }),
      } as never,
      { resolverSesion: resolver } as never,
      redis,
    );
    for (let i = 0; i < 4; i++) {
      await expect(
        roto.abrir(sesion(), undefined, new RespuestaFalsa()),
      ).rejects.toThrow("bd");
    }
    expect(roto.abiertos).toBe(0);
  });

  it("si el cliente se fue mientras se cargaba el alcance, no queda registrado", async () => {
    const r = new RespuestaFalsa();
    r.socket = { destroyed: true };
    await servicio.abrir(sesion(), undefined, r);
    expect(servicio.abiertos).toBe(0);
    expect(r.writableEnded).toBe(true);
    expect(r.estado).toBe(0);
  });
});

describe("StreamService · eventos", () => {
  it("reenvía solo lo válido, con las claves de la vista y a quien ve el cliente", async () => {
    estado.rol = "asistente";
    estado.clientes = [CLIENTE];
    const r = await abrir();
    sub.emit("message", canal, "no json");
    sub.emit("message", canal, JSON.stringify({ id: "x" }));
    sub.emit("message", "p:eventos:otro", JSON.stringify(vista()));
    sub.emit("message", canal, JSON.stringify(vista(OTRO_CLIENTE)));
    sub.emit(
      "message",
      canal,
      JSON.stringify({ ...vista(), ruc: "20100000001" }),
    );
    expect(r.texto).toBe(
      `event: trabajo\ndata: ${JSON.stringify(vista())}\n\n`,
    );
    r.end();
  });

  it("manda un latido cada 15 s", async () => {
    const r = await abrir();
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.latidoMs * 2);
    expect(r.texto).toBe(": latido\n\n: latido\n\n");
    r.end();
  });
});

describe("StreamService · cierre", () => {
  it("cierra el stream a los 5 min (el cliente reconecta) y deja el canal", async () => {
    const r = await abrir();
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.duracionMs - 1000);
    expect(r.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.writableEnded).toBe(true);
    expect(servicio.abiertos).toBe(0);
    expect(sub.unsubscribe).toHaveBeenCalledWith(canal);
  });

  it("cierre ordenado: al destruir el módulo termina los streams, deja los canales y luego QUIT del suscriptor", async () => {
    const a = await abrir();
    const b = await abrir(sesion({ sesionId: "s-2" }));
    servicio.onModuleDestroy();
    expect([a.writableEnded, b.writableEnded]).toEqual([true, true]);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(abrir()).rejects.toMatchObject({
      codigo: "streams_excedidos",
    });
    await redis.onApplicationShutdown();
    expect(sub.quit).toHaveBeenCalledTimes(1);
    expect(redis.suscriptor()).toBeNull();
    // Tras el cierre no se escribe nada más.
    sub.emit("message", canal, JSON.stringify(vista()));
    expect(a.texto).toBe("");
  });

  it("revalida cada 5 s: sesión rotada, otro estudio, miembro desactivado o error de BD cierran el stream", async () => {
    const casos: (() => void)[] = [
      () => resolver.mockResolvedValueOnce(null),
      () => resolver.mockResolvedValueOnce(sesion({ tenantActivo: "otro" })),
      () => resolver.mockResolvedValueOnce(sesion({ estudioRevocado: true })),
      () => {
        estado.rol = null;
      },
      () => resolver.mockRejectedValueOnce(new Error("bd")),
    ];
    for (const preparar of casos) {
      estado.rol = "dueno";
      const r = await abrir();
      preparar();
      await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.revalidacionMs);
      expect(r.writableEnded).toBe(true);
    }
  });

  it("revalidar con la sesión vigente actualiza el alcance (bajado a contador: solo sus asignados)", async () => {
    const r = await abrir();
    sub.emit("message", canal, JSON.stringify(vista(OTRO_CLIENTE)));
    estado.rol = "contador";
    estado.clientes = [CLIENTE];
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.revalidacionMs);
    expect(r.writableEnded).toBe(false);
    r.texto = "";
    sub.emit("message", canal, JSON.stringify(vista(OTRO_CLIENTE)));
    sub.emit("message", canal, JSON.stringify(vista(CLIENTE)));
    expect(r.texto).toBe(
      `event: trabajo\ndata: ${JSON.stringify(vista())}\n\n`,
    );
    r.end();
  });

  it("una revalidación lenta no se solapa con la siguiente", async () => {
    let soltar: (s: SesionResuelta) => void = () => undefined;
    resolver.mockImplementationOnce(
      () => new Promise<SesionResuelta>((ok) => (soltar = ok)),
    );
    const r = await abrir();
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.revalidacionMs * 3);
    expect(resolver).toHaveBeenCalledTimes(1);
    soltar(sesion());
    await vi.advanceTimersByTimeAsync(TIEMPOS_POR_DEFECTO.revalidacionMs);
    expect(resolver).toHaveBeenCalledTimes(2);
    r.end();
  });
});

describe("StreamService · suscriptor", () => {
  it("si SUBSCRIBE falla con Redis caído, el stream sigue abierto y al volver Redis se vuelve a suscribir", async () => {
    sub.falla = true;
    const r = await abrir();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.writableEnded).toBe(false);
    expect(sub.canales.size).toBe(0);
    sub.falla = false;
    sub.emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(sub.canales.has(canal)).toBe(true);
    r.end();
  });
});
