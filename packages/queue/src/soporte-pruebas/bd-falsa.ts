// Soporte de pruebas unitarias de `queue` (no se publica: excluido de tsconfig.build.json).
// Doble en memoria de `@contapp/db` para el encolado y el despachador. Las pruebas lo instalan con
//   vi.mock("@contapp/db", async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso);
// Contrato de los repositorios de `packages/db` que `queue` usa (plan 008, "packages/db"). ALINEADO
// (T4b) con el encabezado de `tests/aislamiento/trabajos-repos.spec.ts`, que es la version definitiva;
// la implementacion real (T7) respeta estas firmas y formas (camelCase en TS):
//   leerConfig(tx)                              -> Map<NombreCola, ConfigCola>          (withSistema)
//   siguienteDisponible(tx, cola, ahora: Date)  -> TrabajoFila | null   (fila COMPLETA; interactivo antes que
//        programado, luego creadoEn, luego id; solo `en_cola` con disponibleDesde <= ahora, del tenant de `tx`)
//   siguientesDisponibles(tx, cola, ahora: Date, limite: number) -> TrabajoFila[]   (T9c, D21: los primeros `limite`
//        (entero 1..50) en_cola con disponibleDesde <= ahora, en el MISMO orden que siguienteDisponible; este equivale
//        a limite = 1 y se conserva)
//   transicionar(tx, id, desde, hacia, campos?: { motivo?, intentos?, resultado?, disponibleDesde?: Date })
//        -> boolean  (UPDATE ... WHERE estado = desde; ella fija `iniciadoEn` al pasar a `ejecutando` y
//        `terminadoEn` en estados terminales; quien llama NO pasa fechas de inicio/fin: se ignoran)
//   revalidarEncolado(tx, { clienteId, creadoPor, rolesPermitidos: readonly string[] | null, ...resto })
//        -> "ok" | "acceso_retirado"   (D17; rolesPermitidos null = sin permiso requerido)
//   estadoCredencial(tx, clienteId, tipo)       -> "configurada" | "verificada" | "invalida" | null
//   insertarTrabajo(tx, datos)                  -> TrabajoVista (posicion null)
//   trabajoVivoPorClave(tx, claveDedupe)        -> TrabajoVista | null (solo en_cola / ejecutando)
//   contarPendientes(tx, cola)                  -> number (en_cola del tenant de `tx` en esa cola)
//   leerTrabajo(tx, id)                         -> TrabajoFila | null (T16: relectura tras una transición perdida)
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
  maxIntentos?: number;
  resultado?: unknown;
  actualizadoEn?: Date;
}

const INICIO_BD = Date.parse("2026-10-27T15:00:00.000Z");
const TERMINALES = new Set(["completado", "error", "cancelado"]);

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
  /** Rol de cada usuario creador (lo que la BD real leeria de `membresia`); por defecto "dueno". */
  roles: new Map<string, string>(),
  /** Reloj de la BD falsa (el `now()` de transicionar); las pruebas pueden cambiarlo. */
  ahora: (): Date => new Date(INICIO_BD),
  /** Cada llamada a `transicionar`, tal como llego (para comprobar que no se pasan fechas). */
  transiciones: [] as {
    id: string;
    desde: string;
    hacia: string;
    campos: Record<string, unknown> | undefined;
  }[],
  /** Cada llamada a `revalidarEncolado`, tal como llego. */
  revalidaciones: [] as {
    tenantId: string | null;
    args: Record<string, unknown>;
  }[],
  /** Cada llamada a `siguientesDisponibles` (D21): estudio, cola y `limite` pedidos. */
  ventanas: [] as { tenantId: string | null; cola: string; limite: number }[],
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
    this.roles.clear();
    this.ahora = (): Date => new Date(INICIO_BD);
    this.transiciones = [];
    this.revalidaciones = [];
    this.ventanas = [];
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

/** TrabajoFila completa (superconjunto de TrabajoDespacho), como la devuelve el repo real. */
const completa = (f: FilaTrabajo) => ({
  ...despacho(f),
  estado: f.estado,
  parametros: f.parametros,
  claveDedupe: /^(?:[0-9a-f]{2})+$/.test(f.claveDedupe)
    ? Buffer.from(f.claveDedupe, "hex")
    : Buffer.from(f.claveDedupe),
  maxIntentos: f.maxIntentos ?? 3,
  motivo: f.motivo,
  resultado: f.resultado ?? null,
  disponibleDesde: f.disponibleDesde,
  iniciadoEn: f.iniciadoEn,
  terminadoEn: f.terminadoEn,
  actualizadoEn: f.actualizadoEn ?? f.creadoEn,
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
    return filas[0] === undefined ? null : completa(filas[0]);
  },

  /** D21: la ventana de candidatos (mismo orden que `siguienteDisponible`, hasta `limite` filas). */
  async siguientesDisponibles(
    tx: TxFalsa,
    cola: string,
    ahora: Date,
    limite: number,
  ) {
    bd.ventanas.push({ tenantId: tx.tenantId, cola, limite });
    return [...bd.trabajos.values()]
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
      )
      .slice(0, limite)
      .map(completa);
  },

  async transicionar(
    tx: TxFalsa,
    id: string,
    desde: string,
    hacia: string,
    campos?: {
      motivo?: string | null;
      intentos?: number;
      resultado?: unknown;
      disponibleDesde?: Date;
    },
  ): Promise<boolean> {
    bd.transiciones.push({ id, desde, hacia, campos });
    const f = bd.trabajos.get(id);
    if (f === undefined || f.tenantId !== tx.tenantId) return false;
    if (bd.perdedores.has(id) && desde === "en_cola") {
      f.estado = "cancelado"; // otro actor ya lo cancelo
      f.motivo = "cancelado_usuario";
      return false;
    }
    if (f.estado !== desde) return false;
    // Como el repo real: solo estas 4 columnas vienen de quien llama; las fechas las fija la BD.
    if (campos?.motivo !== undefined) f.motivo = campos.motivo;
    if (campos?.intentos !== undefined) f.intentos = campos.intentos;
    if (campos?.resultado !== undefined) f.resultado = campos.resultado;
    if (campos?.disponibleDesde !== undefined)
      f.disponibleDesde = campos.disponibleDesde;
    f.estado = hacia;
    const ahora = bd.ahora();
    if (hacia === "ejecutando") f.iniciadoEn = ahora;
    if (TERMINALES.has(hacia)) f.terminadoEn = ahora;
    f.actualizadoEn = ahora;
    return true;
  },

  async revalidarEncolado(
    tx: TxFalsa,
    t: {
      id?: string;
      clienteId: string;
      creadoPor: string | null;
      rolesPermitidos: readonly string[] | null;
    },
  ): Promise<"ok" | "acceso_retirado"> {
    bd.revalidaciones.push({ tenantId: tx.tenantId, args: { ...t } });
    if (t.id !== undefined && bd.retirados.has(t.id)) return "acceso_retirado";
    // creadoPor null (programado) solo exige que exista el cliente; sin permiso requerido (null)
    // basta la membresia activa. El rol del creador lo asigna la prueba en `bd.roles`.
    if (t.creadoPor === null || t.rolesPermitidos === null) return "ok";
    const rol = bd.roles.get(t.creadoPor) ?? "dueno";
    return t.rolesPermitidos.includes(rol) ? "ok" : "acceso_retirado";
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

  /**
   * T9: `encolar` lee el RUC del cliente con `leerCliente` (repo de 005, bajo RLS) porque
   * `insertarTrabajo` lo exige (encabezado de trabajos-repos.spec.ts). Aqui todo cliente existe.
   */
  async leerCliente(_tx: TxFalsa, clienteId: string) {
    return {
      id: clienteId,
      ruc: "20100000001",
      razonSocial: "Cliente de prueba",
    };
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

  /** T16 (H-008-2a-1): el despachador relee el trabajo tras perder la transición. Fila completa o null (RLS). */
  async leerTrabajo(tx: TxFalsa, id: string) {
    const f = bd.trabajos.get(id);
    return f === undefined || f.tenantId !== tx.tenantId ? null : completa(f);
  },
};
