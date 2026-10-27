// `pnpm db:seed`: seed mínimo idempotente (ON CONFLICT DO NOTHING) con MIGRATIONS_DATABASE_URL.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../schema";
import { SEED } from "../seed/datos";
import { ErrorCli, ejecutarSiDirecta, urlMigraciones } from "./comun";

/**
 * H-r2b-3: el seed trae cuentas de desarrollo con una contraseña versionada en el repo. Con
 * NODE_ENV=production se niega antes de abrir la conexión (no toca la base; código de salida 1). Como D11,
 * sin distinguir mayúsculas ni espacios (`Production`, ` production `).
 */
export function exigirEntornoNoProduccion(env: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = env.NODE_ENV;
  if (typeof nodeEnv === "string" && nodeEnv.trim().toLowerCase() === "production") {
    throw new ErrorCli("el seed de desarrollo no se ejecuta con NODE_ENV=production");
  }
}

/** Inserta el seed (idempotente) en una transacción sobre la conexión recibida. */
export async function sembrar(client: Pick<Client, "query">): Promise<void> {
  const db = drizzle(client as Client, { schema });
  await db.transaction(async (tx) => {
    await tx.insert(schema.tenant).values(SEED.tenants).onConflictDoNothing();
    await tx.insert(schema.usuario).values(SEED.usuarios).onConflictDoNothing();
    await tx
      .insert(schema.membresia)
      .values(SEED.membresias)
      .onConflictDoNothing();
    const clientes = [
      ...SEED.clientesA.map((c) => ({ ...c, tenantId: SEED.tenantA })),
      ...SEED.clientesB.map((c) => ({ ...c, tenantId: SEED.tenantB })),
    ];
    await tx.insert(schema.cliente).values(clientes).onConflictDoNothing();
    await tx.insert(schema.asignacion).values(SEED.asignaciones).onConflictDoNothing();
    // Spec 004: credenciales de desarrollo (PHC precalculado; la tabla no está en el esquema de drizzle).
    for (const c of SEED.credenciales) {
      await tx.execute(
        sql`insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en)
            values (${c.usuarioId}, ${c.hash}, now()) on conflict (usuario_id) do nothing`,
      );
    }
  });
}

export async function main(): Promise<void> {
  exigirEntornoNoProduccion();
  const client = new Client({ connectionString: urlMigraciones() });
  await client.connect();
  try {
    await sembrar(client);
  } finally {
    await client.end();
  }
}

ejecutarSiDirecta(require.main, module, "seed", main);
