// Dobles de prueba para las unitarias de los servicios de `auth` (T11 de 004). Fuera de `src/` para
// que no cuenten en la cobertura. `withUsuario` imita la RLS: solo devuelve las filas configuradas.
import { schema, type AuthRepo } from "@contapp/db";
import { vi, type Mock } from "vitest";
import type { DbAuth } from "../src/modules/auth/auth.service.js";
import type { Hasher } from "../src/modules/auth/contrasena/hasher.js";

export const U = "0190a000-0000-7000-8000-000000000001";
export const T_A = "0190a000-0000-7000-8000-0000000000aa";
export const T_B = "0190a000-0000-7000-8000-0000000000bb";
export const CORREO = "ana@t004.contapp.test";
export const PWD = "Contrasena-unit-004-ñ";
export const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
export const FICTICIO = "$argon2id$v=19$m=19456,t=2,p=1$ZmljdGljaW8$ZmljdGljaW8";
export const HORA = 3_600_000;

type Mocks<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? Mock<(...a: A) => R> : T[K] };

export interface Entorno {
  repo: Mocks<AuthRepo>;
  db: DbAuth & { withAuth: Mock; withUsuario: Mock };
  hasher: Mocks<Hasher>;
  cola: { encolar: Mock<(m: { para: string; asunto: string; texto: string }) => void> };
  datos: {
    tenants: { id: string; nombre: string }[];
    usuarios: { id: string; nombre: string; correo: string }[];
  };
}

export function crearEntorno(): Entorno {
  const repo: Mocks<AuthRepo> = {
    limiteConsumir: vi.fn(async () => true),
    loginPreparar: vi.fn(async () => ({ permitido: true, usuarioId: U, hash: HASH, alcanzaBloqueo: false })),
    loginExito: vi.fn(async () => ({ sesionId: "s-nueva", expiraAbsoluta: new Date(Date.now() + 12 * HORA) })),
    sesionValidar: vi.fn(async () => null),
    sesionRotar: vi.fn(async () => ({ sesionId: "s-rotada", expiraAbsoluta: new Date(Date.now() + HORA) })),
    sesionRevocar: vi.fn(async () => undefined),
    sesionesCerrarTodas: vi.fn(async () => 2),
    ultimoEstudio: vi.fn(async () => null),
    recuperacionCrear: vi.fn(async () => true),
    recuperacionConsumir: vi.fn(async () => ({ usuarioId: U, correo: CORREO })),
    contrasenaCambiar: vi.fn(async () => CORREO),
  };
  const datos: Entorno["datos"] = {
    tenants: [{ id: T_A, nombre: "Estudio A" }],
    usuarios: [{ id: U, nombre: "Ana", correo: CORREO }],
  };
  const tx = {
    orm: {
      select: () => ({
        from: async (tabla: unknown) => (tabla === schema.tenant ? datos.tenants : datos.usuarios),
      }),
    },
  };
  const db = {
    withAuth: vi.fn(async (fn: (a: AuthRepo) => Promise<unknown>) => fn(repo)),
    withUsuario: vi.fn(async (_ctx: { userId: string }, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as Entorno["db"];
  const hasher: Mocks<Hasher> = {
    hashFicticio: FICTICIO,
    verificar: vi.fn(async (phc: string, plano: string) => phc === HASH && plano === PWD),
    calcular: vi.fn(async () => "$argon2id$v=19$m=19456,t=2,p=1$bnVldmE$bnVldmE"),
    necesitaRehash: vi.fn(() => false),
  };
  return { repo, db, hasher, cola: { encolar: vi.fn() }, datos };
}
