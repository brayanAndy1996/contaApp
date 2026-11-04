/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de 007a (T3). Encima de `soporte-planes.ts`: RUC válidos (con dígito
// verificador, a diferencia de los de `b.clientes`, que solo sirven para sembrar por SQL), clientes sembrados por SQL
// con razón social, responsable, credenciales y archivado a gusto, y estudios con un plan de N RUC. Las credenciales son
// sintéticas (bytes aleatorios; nunca un secreto real). Solo usa el contrato público: HTTP y las tablas.
import { randomBytes } from "node:crypto";
import { validarRuc } from "@contapp/shared";
import { abrirBancoPlanes, type Actor, type BancoPlanes, type Estudio } from "./soporte-planes.js";
import type { Resp } from "./soporte.js";

export type { Actor, BancoPlanes, Estudio };

let serieRuc = 0;
/** RUC válido (prefijo 20, dígito verificador módulo 11) y único en el proceso. */
export function rucValido(prefijo: "10" | "15" | "16" | "17" | "20" = "20"): string {
  const cuerpo = `${prefijo}${String(10_000_000 + ++serieRuc * 7 + (process.pid % 1000) * 10_000).padStart(8, "0")}`;
  for (let d = 0; d < 10; d++) if (validarRuc(`${cuerpo}${d}`)) return `${cuerpo}${d}`;
  throw new Error("no se pudo completar el RUC de prueba");
}
/** Mismo cuerpo de 10 cifras con un dígito verificador equivocado. */
export function rucConVerificadorMalo(): string {
  const bueno = rucValido();
  return `${bueno.slice(0, 10)}${(Number(bueno[10]) + 1) % 10}`;
}

export type EstadoCred = "no_configurada" | "configurada" | "verificada" | "invalida";
export interface SemillaCliente {
  ruc?: string;
  razonSocial?: string;
  /** Usuario que queda como responsable (asignación `responsable`). */
  responsable?: string;
  colaboradores?: string[];
  sol?: EstadoCred;
  sireApi?: EstadoCred;
  archivado?: boolean;
}
export interface PerfilJson {
  regimen: "rg" | "rmt" | "rer" | "nrus" | null;
  zona: "general" | "amazonia";
  ventasExoneradas: boolean;
  ventasMixtas: boolean;
  monedaHabitual: "PEN" | "USD";
}
export const PERFIL_POR_DEFECTO: PerfilJson = {
  regimen: null,
  zona: "general",
  ventasExoneradas: false,
  ventasMixtas: false,
  monedaHabitual: "PEN",
};

export interface BancoClientes {
  p: BancoPlanes;
  /** Estudio con un plan propio de `maxRucs` RUC (sin adicionales) y su Dueño con sesión. */
  estudioCon(maxRucs: number): Promise<Estudio>;
  /** Siembra un cliente por SQL (RUC válido salvo que se indique) y devuelve su id y RUC. */
  sembrar(tenantId: string, s?: SemillaCliente): Promise<{ id: string; ruc: string }>;
  /** Inserta una credencial sintética con `estado` (solo `configurada|verificada|invalida`). */
  credencial(tenantId: string, clienteId: string, tipo: "sol" | "sire_api", estado: Exclude<EstadoCred, "no_configurada">): Promise<string>;
  /** Huella de lo cifrado de las credenciales del cliente, para comprobar que no se tocaron. */
  huellaCredenciales(clienteId: string): Promise<string[]>;
  /** Clientes activos (`archivado_at IS NULL`) del estudio, contados por SQL. */
  activos(tenantId: string): Promise<number>;
  total(tenantId: string): Promise<number>;
  fila(clienteId: string): Promise<any | undefined>;
  asignaciones(clienteId: string): Promise<{ usuario_id: string; tipo: string }[]>;
  crear(a: Actor, cuerpo: unknown): Promise<Resp>;
  uso(a: Actor): Promise<Resp>;
  cerrar(): Promise<void>;
}

/** `extra`: opciones adicionales de `crearApp` (007b: `redis`). */
export async function abrirBancoClientes(extra: Record<string, unknown> = {}): Promise<BancoClientes> {
  const p = await abrirBancoPlanes(undefined, extra);
  const tenants = new Set<string>();
  const sql = p.sql;

  const estudioCon: BancoClientes["estudioCon"] = async (maxRucs) => {
    const plan = await p.plan({ maxRucs, maxUsuarios: null });
    const E = await p.estudio(plan);
    tenants.add(E.tenantId);
    return E;
  };

  const credencial: BancoClientes["credencial"] = async (tenantId, clienteId, tipo, estado) => {
    tenants.add(tenantId);
    const r = await sql<{ id: string }>(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version, estado)
       values ($1, $2, $3, $4, $5, $6, $7, 'k1', 1, $8) returning id`,
      [tenantId, clienteId, tipo, randomBytes(64), randomBytes(12), randomBytes(16), randomBytes(512), estado],
    );
    return r[0]!.id;
  };

  const sembrar: BancoClientes["sembrar"] = async (tenantId, s = {}) => {
    tenants.add(tenantId);
    const ruc = s.ruc ?? rucValido();
    const filas = await sql<{ id: string }>(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [tenantId, ruc, s.razonSocial ?? `Cliente ${ruc}`],
    );
    const id = filas[0]!.id;
    if (s.responsable) {
      await sql("insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable')", [tenantId, id, s.responsable]);
    }
    for (const u of s.colaboradores ?? []) {
      await sql("insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')", [tenantId, id, u]);
    }
    if (s.sol && s.sol !== "no_configurada") await credencial(tenantId, id, "sol", s.sol);
    if (s.sireApi && s.sireApi !== "no_configurada") await credencial(tenantId, id, "sire_api", s.sireApi);
    // 007a (T5) agrega `archivado_at`: hasta entonces, sembrar un archivado falla por falta de esquema (rojo esperado).
    if (s.archivado) await sql("update cliente set archivado_at = now() where id = $1", [id]);
    return { id, ruc };
  };

  async function limpiarCredenciales(): Promise<void> {
    // No hay FK credencial → cliente hasta 007b: sin esto quedan huérfanas y estorban al borrar el tenant.
    for (const t of tenants) await sql("delete from credencial where tenant_id = $1", [t]).catch(() => undefined);
  }

  return {
    p,
    estudioCon,
    sembrar,
    credencial,
    huellaCredenciales: async (clienteId) =>
      (
        await sql<{ h: string }>(
          "select tipo || ':' || estado || ':' || md5(ciphertext) || ':' || md5(dek_envuelta) as h from credencial where cliente_id = $1 order by tipo",
          [clienteId],
        )
      ).map((f) => f.h),
    activos: async (t) => Number((await sql("select count(*)::int n from cliente where tenant_id = $1 and archivado_at is null", [t]))[0].n),
    total: async (t) => Number((await sql("select count(*)::int n from cliente where tenant_id = $1", [t]))[0].n),
    fila: async (id) => (await sql("select * from cliente where id = $1", [id]))[0],
    asignaciones: (id) => sql("select usuario_id, tipo from asignacion where cliente_id = $1 order by usuario_id", [id]),
    crear: (a, cuerpo) => p.b.llamar(a, "POST", "/clientes", cuerpo),
    uso: (a) => p.b.llamar(a, "GET", "/plan/uso"),
    cerrar: async () => {
      await limpiarCredenciales();
      await p.cerrar();
    },
  };
}
