// Soporte de pruebas unitarias de `queue` (no se publica: excluido de tsconfig.build.json).
// Doble en memoria de `@contapp/db` para el encolado y el despachador. Las pruebas lo instalan con
//   vi.mock("@contapp/db", async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso);
// Contrato de los repositorios de `packages/db` que `queue` usa (plan 008, "packages/db"); la
// implementacion real (T7) debe respetar estas firmas y formas (camelCase en TS):
//   leerConfig(tx)                              -> Map<NombreCola, ConfigCola>
//   siguienteDisponible(tx, cola, ahora: Date)  -> TrabajoDespacho | null   (interactivo antes que
//        programado, luego creadoEn; solo `en_cola` con disponibleDesde <= ahora, del tenant de `tx`)
//   transicionar(tx, id, desde, hacia, campos)  -> boolean  (UPDATE ... WHERE estado = desde)
//   revalidarEncolado(tx, trabajo)              -> "ok" | "acceso_retirado"            (D17)
//   estadoCredencial(tx, clienteId, tipo)       -> "configurada" | "verificada" | "invalida" | null
//   insertarTrabajo(tx, datos)                  -> TrabajoVista (posicion null)
//   trabajoVivoPorClave(tx, claveDedupe)        -> TrabajoVista | null (solo en_cola / ejecutando)
//   contarPendientes(tx, cola)                  -> number (en_cola del tenant de `tx` en esa cola)
// `db.withTenant` / `db.withSistema` abren una "transaccion" que NO se puede anidar (como la real).
export const uuidDe = (n: number): string =>
  `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export type PrioridadFalsa = "interactivo" | "programado";

export interface ConfigColaFalsa {
  concurrenciaGlobal: number;
  concurrenciaTenant: number;
  esperaRucMs: number;
  reintentos: number;
  backoffBaseMs: number;
  maxPendientesTenant: number;
}

export interface FilaTrabajo {
  id: string;
  tenantId: string;
  clienteId: string;
  ruc: string;
  tipo: string;
  cola: string;
  canal: string;
  prioridad: PrioridadFalsa;
  estado: string;
  intentos: number;
  motivo: string | null;
  creadoPor: string | null;
  creadoEn: Date;
  disponibleDesde: Date;
  iniciadoEn: Date | null;
  terminadoEn: Date | null;
  claveDedupe: string;
  parametros: unknown;
}

export class WithTenantAnidadoError extends Error {
  constructor() {
    super("withTenant anidado");
    this.name = "WithTenantAnidadoError";
  }
}

export function configPorDefecto(): Map<string, ConfigColaFalsa> {
  const base = {
    esperaRucMs: 2000,
    reintentos: 3,
    backoffBaseMs: 5000,
    maxPendientesTenant: 2000,
  };
  return new Map<string, ConfigColaFalsa>([
    ["sire", { ...base, concurrenciaGlobal: 4, concurrenciaTenant: 2 }],
    ["sol", { ...base, concurrenciaGlobal: 2, concurrenciaTenant: 1 }],
    ["xml", { ...base, concurrenciaGlobal: 8, concurrenciaTenant: 4 }],
  ]);
}

export const bd = {
  trabajos: new Map<string, FilaTrabajo>(),
  config: configPorDefecto(),
  /** ids que `revalidarEncolado` reporta como `acceso_retirado`. */
  retirados: new Set<string>(),
  /** clientes cuya credencial esta `invalida`. */
  credencialInvalida: new Set<string>(),
  /** ids que pierden la carrera `en_cola -> *` (alguien los cancelo antes): transicionar -> false. */
  perdedores: new Set<string>(),
  fallaConfig: false,
  /** true mientras corre el callback de withTenant/withSistema. */
  dentro: false,
  /** tenantId de cada withTenant abierto, en orden. */
  ctxs: [] as string[],
  insertados: [] as Record<string, unknown>[],
  secuencia: 0,
  reiniciar(): void {
    this.trabajos.clear();
    this.config = configPorDefecto();
    this.retirados.clear();
    this.credencialInvalida.clear();
    this.perdedores.clear();
    this.fallaConfig = false;
    this.dentro = false;
    this.ctxs = [];
    this.insertados = [];
    this.secuencia = 0;
  },
  siguienteId(): string {
    this.secuencia++;
    return uuidDe(0x1000 + this.secuencia);
  },
};

export interface TxFalsa {
  tenantId: string | null;
}

export const dbFalsa = {
  async withTenant<T>(
    ctx: { tenantId: string },
    fn: (tx: TxFalsa) => Promise<T>,
  ): Promise<T> {
    if (bd.dentro) throw new WithTenantAnidadoError();
    bd.dentro = true;
    bd.ctxs.push(ctx.tenantId);
    try {
      return await fn({ tenantId: ctx.tenantId });
    } finally {
      bd.dentro = false;
    }
  },
  async withSistema<T>(fn: (tx: TxFalsa) => Promise<T>): Promise<T> {
    if (bd.dentro) throw new WithTenantAnidadoError();
    bd.dentro = true;
    try {
      return await fn({ tenantId: null });
    } finally {
      bd.dentro = false;
    }
  },
  async close(): Promise<void> {},
};

const POR_PRIORIDAD: Record<PrioridadFalsa, number> = {
  interactivo: 0,
  programado: 1,
};

const despacho = (f: FilaTrabajo) => ({
  id: f.id,
  tenantId: f.tenantId,
  clienteId: f.clienteId,
  ruc: f.ruc,
  tipo: f.tipo,
  cola: f.cola,
  canal: f.canal,
  prioridad: f.prioridad,
  creadoPor: f.creadoPor,
  creadoEn: f.creadoEn,
  intentos: f.intentos,
});

const vista = (f: FilaTrabajo) => ({
  id: f.id,
  tipo: f.tipo,
  clienteId: f.clienteId,
  estado: f.estado,
  posicion: null,
  intentos: f.intentos,
  motivo: f.motivo,
  creadoEn: f.creadoEn.toISOString(),
  iniciadoEn: f.iniciadoEn?.toISOString() ?? null,
  terminadoEn: f.terminadoEn?.toISOString() ?? null,
  creadoPor: f.creadoPor === null ? null : { usuarioId: f.creadoPor },
});

export const moduloDbFalso = {
  WithTenantAnidadoError,

  async leerConfig(): Promise<Map<string, ConfigColaFalsa>> {
    if (bd.fallaConfig) throw new Error("config_sistema no disponible");
    return new Map([...bd.config].map(([k, v]) => [k, { ...v }]));
  },

  async siguienteDisponible(tx: TxFalsa, cola: string, ahora: Date) {
    const filas = [...bd.trabajos.values()]
      .filter(
        (f) =>
          f.tenantId === tx.tenantId &&
          f.cola === cola &&
          f.estado === "en_cola" &&
          f.disponibleDesde.getTime() <= ahora.getTime(),
      )
      .sort(
        (a, b) =>
          POR_PRIORIDAD[a.prioridad] - POR_PRIORIDAD[b.prioridad] ||
          a.creadoEn.getTime() - b.creadoEn.getTime() ||
          (a.id < b.id ? -1 : 1),
      );
    return filas[0] === undefined ? null : despacho(filas[0]);
  },

  async transicionar(
    tx: TxFalsa,
    id: string,
    desde: string,
    hacia: string,
    campos: Partial<FilaTrabajo> = {},
  ): Promise<boolean> {
    const f = bd.trabajos.get(id);
    if (f === undefined || f.tenantId !== tx.tenantId) return false;
    if (bd.perdedores.has(id) && desde === "en_cola") {
      f.estado = "cancelado"; // otro actor ya lo cancelo
      f.motivo = "cancelado_usuario";
      return false;
    }
    if (f.estado !== desde) return false;
    Object.assign(f, campos, { estado: hacia });
    return true;
  },

  async revalidarEncolado(
    _tx: TxFalsa,
    trabajo: { id: string },
  ): Promise<"ok" | "acceso_retirado"> {
    return bd.retirados.has(trabajo.id) ? "acceso_retirado" : "ok";
  },

  async estadoCredencial(
    _tx: TxFalsa,
    clienteId: string,
  ): Promise<string | null> {
    return bd.credencialInvalida.has(clienteId) ? "invalida" : "configurada";
  },

  async insertarTrabajo(tx: TxFalsa, d: Record<string, unknown>) {
    bd.insertados.push(d);
    const id = bd.siguienteId();
    const ahora = new Date(
      Date.parse("2026-10-27T15:00:00.000Z") + bd.secuencia * 1000,
    );
    const f: FilaTrabajo = {
      id,
      tenantId: tx.tenantId!,
      clienteId: String(d.clienteId),
      ruc: "20100000001",
      tipo: String(d.tipo),
      cola: String(d.cola),
      canal: String(d.canal),
      prioridad: d.prioridad as PrioridadFalsa,
      estado: "en_cola",
      intentos: 0,
      motivo: null,
      creadoPor: (d.creadoPor as string | null) ?? null,
      creadoEn: ahora,
      disponibleDesde: ahora,
      iniciadoEn: null,
      terminadoEn: null,
      claveDedupe: Buffer.from(d.claveDedupe as Uint8Array).toString("hex"),
      parametros: d.parametros,
    };
    bd.trabajos.set(id, f);
    return vista(f);
  },

  async trabajoVivoPorClave(tx: TxFalsa, clave: Uint8Array) {
    const hex = Buffer.from(clave).toString("hex");
    const f = [...bd.trabajos.values()].find(
      (x) =>
        x.tenantId === tx.tenantId &&
        x.claveDedupe === hex &&
        (x.estado === "en_cola" || x.estado === "ejecutando"),
    );
    return f === undefined ? null : vista(f);
  },

  async contarPendientes(tx: TxFalsa, cola: string): Promise<number> {
    return [...bd.trabajos.values()].filter(
      (f) =>
        f.tenantId === tx.tenantId && f.cola === cola && f.estado === "en_cola",
    ).length;
  },

  async posicion(): Promise<number> {
    return 1;
  },
};
