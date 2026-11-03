// Token SIRE por cliente (spec 008, RF-045, D14, CA-11). El token se pide con el puerto `SireAuth` y se guarda en Redis
// cifrado con AES-256-GCM: llave de 32 B aleatoria que solo vive en la memoria de este proceso, valor `nonce‖ct‖tag` y
// AAD = nombre de la clave (un valor copiado a otra clave no abre). TTL = vencimiento − margen − ahora. Single-flight
// por (tenantId, clienteId): N peticiones simultáneas comparten una sola obtención y su resultado o su error (que
// nunca se guarda). Las credenciales descifradas solo se piden para obtener un token nuevo y no salen de memoria.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { crearClaves, type ClavesCola, type Reloj } from "@contapp/queue";
import {
  ErrorCredencial,
  type CredencialSire,
  type SireAuth,
} from "@contapp/sunat";
import type { Redis } from "ioredis";

/** El servicio respondió 401 con el token entregado: `conToken` lo renueva una sola vez. */
export class TokenRechazadoError extends Error {
  readonly codigo = "token_rechazado";
  constructor() {
    super("El servicio SIRE rechazó el token");
    this.name = "TokenRechazadoError";
  }
}

export interface ContextoToken {
  tenantId: string;
  clienteId: string;
  ruc: string;
}

export type CredencialesSire = (c: ContextoToken) => Promise<CredencialSire>;

export interface OpcionesCacheToken {
  redis: Pick<Redis, "getBuffer" | "set" | "del">;
  sireAuth: SireAuth;
  credenciales: CredencialesSire;
  reloj?: Reloj;
  prefijo?: string;
  /** Identifica al proceso en la clave (los procesos no comparten tokens). Por defecto, aleatorio. */
  proceso?: string;
  /** Margen antes del vencimiento (por defecto 60 s). */
  margenMs?: number;
}

const NONCE = 12;
const ETIQUETA = 16;
const MARGEN_MS = 60_000;

export class CacheTokenSire {
  private readonly redis: OpcionesCacheToken["redis"];
  private readonly sireAuth: SireAuth;
  private readonly credenciales: CredencialesSire;
  private readonly reloj: Reloj;
  private readonly k: ClavesCola;
  private readonly proceso: string;
  private readonly margenMs: number;
  /** Llave efímera: nunca sale de este objeto. */
  private readonly llave = randomBytes(32);
  private readonly enVuelo = new Map<string, Promise<string>>();

  constructor(o: OpcionesCacheToken) {
    this.redis = o.redis;
    this.sireAuth = o.sireAuth;
    this.credenciales = o.credenciales;
    this.reloj = o.reloj ?? { ahora: () => new Date() };
    this.k = crearClaves(o.prefijo);
    this.proceso = o.proceso ?? randomUUID();
    this.margenMs = o.margenMs ?? MARGEN_MS;
  }

  /** Token vigente del cliente (de la caché o uno nuevo). */
  obtener(ctx: ContextoToken): Promise<string> {
    const id = `${ctx.tenantId}:${ctx.clienteId}`;
    const previo = this.enVuelo.get(id);
    if (previo !== undefined) return previo;
    // Mientras está en vuelo nadie más lo reemplaza (obtener devuelve el previo): al terminar se borra sin más.
    const p = this.resolver(ctx).finally(() => this.enVuelo.delete(id));
    this.enVuelo.set(id, p);
    return p;
  }

  /** Ejecuta `usar(token)`; ante `TokenRechazadoError` invalida, renueva y lo intenta una sola vez más. */
  async conToken<T>(
    ctx: ContextoToken,
    usar: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await usar(await this.obtener(ctx));
    } catch (e) {
      if (!(e instanceof TokenRechazadoError)) throw e;
    }
    await this.redis.del(this.clave(ctx));
    try {
      return await usar(await this.obtener(ctx));
    } catch (e) {
      if (e instanceof TokenRechazadoError) throw new ErrorCredencial();
      throw e;
    }
  }

  private clave(ctx: ContextoToken): string {
    return this.k.tokenSire(this.proceso, ctx.tenantId, ctx.clienteId);
  }

  private async resolver(ctx: ContextoToken): Promise<string> {
    const clave = this.clave(ctx);
    const cacheado = this.abrir(clave, await this.redis.getBuffer(clave));
    if (cacheado !== null) return cacheado;
    const { token, expiraEn } = await this.sireAuth.obtenerToken(
      await this.credenciales(ctx),
    );
    const ttl =
      expiraEn.getTime() - this.margenMs - this.reloj.ahora().getTime();
    if (ttl > 0)
      await this.redis.set(
        clave,
        this.sellar(clave, token),
        "PX",
        Math.floor(ttl),
      );
    return token;
  }

  private sellar(clave: string, token: string): Buffer {
    const nonce = randomBytes(NONCE);
    const c = createCipheriv("aes-256-gcm", this.llave, nonce);
    c.setAAD(Buffer.from(clave, "utf8"));
    const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]);
  }

  /** Token del valor guardado, o null si falta, está alterado o es de otra clave (AAD distinta). */
  private abrir(clave: string, valor: Buffer | null): string | null {
    if (valor === null || valor.length <= NONCE + ETIQUETA) return null;
    try {
      const d = createDecipheriv(
        "aes-256-gcm",
        this.llave,
        valor.subarray(0, NONCE),
      );
      d.setAAD(Buffer.from(clave, "utf8"));
      d.setAuthTag(valor.subarray(valor.length - ETIQUETA));
      return Buffer.concat([
        d.update(valor.subarray(NONCE, valor.length - ETIQUETA)),
        d.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }
}
