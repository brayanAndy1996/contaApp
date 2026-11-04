// Soporte de las pruebas de integración de los procesadores de 007b (T5): `cliente.consultar_ruc`,
// `credencial.verificar_sol` y `credencial.verificar_sire`. No es código de producción ni una prueba.
//
// CONTRATO que fijan estas pruebas para T9 (además del de `iniciarTrabajos` en src/trabajos/iniciar.ts):
// - `DepsTrabajos` gana `consultaRuc?: ConsultaRuc` y `solAuth?: SolAuth` (por defecto, los mocks). `sireAuth` (ya existente)
//   es el puerto que usa `credencial.verificar_sire`, directo y sin la caché de token.
// - Los tres procesadores se registran solos en `iniciarTrabajos`; descifran con `deps.kek` (servicio auditado de 003).
// - Los puertos reciben `{ ruc, usuarioSol, claveSol }` (SolAuth) y `{ clientId, clientSecret, usuarioSol, claveSol, ruc }` (SireAuth).
// Los secretos de las pruebas son canarios generados al vuelo (nunca claves reales).
import { cifrarCredencial, crearKeyWrapper } from "@contapp/crypto";
import type { TipoCredencial } from "@contapp/crypto";
import { crearKeyUnwrapper } from "@contapp/crypto/descifrado";
import type { ContappDb } from "@contapp/db";
import { registrarTipo } from "@contapp/queue";
import type {
  ConsultaRuc,
  CredencialSire,
  CredencialSol,
  DatosRuc,
  SireAuth,
  SolAuth,
  TokenSire,
} from "@contapp/sunat";
import { z } from "zod";
import { guardar } from "./bd.js";
import { ENV_MOCK } from "./soporte.js";
import {
  arrancar,
  compuerta,
  esperarHasta,
  type Escenario,
  type OpcionesArranque,
  type ProcesoWorker,
} from "./trabajos.js";

const wrapper = crearKeyWrapper(ENV_MOCK);
const unwrapper = crearKeyUnwrapper(ENV_MOCK);

export type ValorCredencial =
  | { usuario: string; clave: string }
  | { clientId: string; clientSecret: string };

/** Cifra con el KeyWrapper `mock` (AAD con tenant, cliente y tipo) y guarda con `contapp_backend`. Devuelve el id. */
export async function guardarCredencial(
  backend: ContappDb,
  tenantId: string,
  clienteId: string,
  tipo: TipoCredencial,
  valor: ValorCredencial,
): Promise<string> {
  const sobre = await cifrarCredencial(
    wrapper,
    { tenantId, clienteId, tipo },
    valor as never,
  );
  return guardar(backend, tenantId, clienteId, tipo, sobre);
}

/** Tipo de prueba que usa `sire_api` (los trabajos SIRE reales llegan con 009); cola `sire`, canal `sire`. */
export function registrarTipoSirePrueba(): void {
  registrarTipo({
    tipo: "prueba.sire_api",
    cola: "sire",
    canal: "sire",
    credencial: "sire_api",
    permiso: "sire.descargar",
    idempotente: true,
    parametros: z.object({}).strict() as never,
  });
}

export type OpcionesWorker007b = OpcionesArranque & {
  consultaRuc?: ConsultaRuc;
  solAuth?: SolAuth;
};

/** Arranca el worker con la KEK `mock` (para descifrar) y los puertos pedidos. */
export function arrancar007b(o: OpcionesWorker007b): Promise<ProcesoWorker> {
  return arrancar({
    kek: { activa: unwrapper as never, anterior: () => unwrapper },
    ...o,
  } as OpcionesArranque);
}

export interface FilaTrabajo {
  estado: string;
  motivo: string | null;
  intentos: number;
  [columna: string]: unknown;
}

const TERMINALES = ["completado", "error", "cancelado"];

/** Espera a que el trabajo termine (completado, error o cancelado) y devuelve su fila de `job_registro`. */
export async function esperarTerminal(
  e: Escenario,
  id: string,
  timeoutMs = 20_000,
): Promise<FilaTrabajo> {
  await esperarHasta(
    async () => TERMINALES.includes((await e.fila(id))?.estado),
    `el trabajo ${id} termina`,
    { timeoutMs },
  );
  return (await e.fila(id)) as FilaTrabajo;
}

interface Pausa {
  /** Cierra la compuerta: las llamadas siguientes esperan hasta `abrir()`. */
  pausar(): void;
  abrir(): void;
}

class Compuerta implements Pausa {
  private actual: ReturnType<typeof compuerta> | null = null;
  pausar(): void {
    this.actual = compuerta();
  }
  abrir(): void {
    this.actual?.abrir();
    this.actual = null;
  }
  async pasar(): Promise<void> {
    await this.actual?.esperar();
  }
}

/** ConsultaRuc que anota las llamadas y puede pausarse dentro de la llamada. */
export class ConsultaRucControlada implements ConsultaRuc, Pausa {
  readonly rucs: string[] = [];
  private readonly puerta = new Compuerta();
  constructor(private readonly interno: ConsultaRuc) {}
  pausar = () => this.puerta.pausar();
  abrir = () => this.puerta.abrir();
  async consultar(ruc: string): Promise<DatosRuc> {
    this.rucs.push(ruc);
    await this.puerta.pasar();
    return this.interno.consultar(ruc);
  }
}

/** SolAuth que anota lo recibido (en memoria de la prueba) y puede pausarse dentro de la llamada. */
export class SolAuthControlado implements SolAuth, Pausa {
  readonly recibidas: CredencialSol[] = [];
  private readonly puerta = new Compuerta();
  constructor(private readonly interno: SolAuth) {}
  pausar = () => this.puerta.pausar();
  abrir = () => this.puerta.abrir();
  async verificar(c: CredencialSol): Promise<void> {
    this.recibidas.push({ ...c });
    await this.puerta.pasar();
    return this.interno.verificar(c);
  }
}

/** SireAuth que anota lo recibido y puede pausarse dentro de la llamada. */
export class SireAuthControlado implements SireAuth, Pausa {
  readonly recibidas: CredencialSire[] = [];
  private readonly puerta = new Compuerta();
  constructor(private readonly interno: SireAuth) {}
  pausar = () => this.puerta.pausar();
  abrir = () => this.puerta.abrir();
  async obtenerToken(c: CredencialSire): Promise<TokenSire> {
    this.recibidas.push({ ...c });
    await this.puerta.pasar();
    return this.interno.obtenerToken(c);
  }
}
