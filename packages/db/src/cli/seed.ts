// `pnpm db:seed`: seed mínimo idempotente (ON CONFLICT DO NOTHING) con MIGRATIONS_DATABASE_URL.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../schema";
import { SEED } from "../seed/datos";
import { ejecutarSiDirecta, urlMigraciones } from "./comun";

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
  const client = new Client({ connectionString: urlMigraciones() });
  await client.connect();
  try {
    await sembrar(client);
  } finally {
    await client.end();
  }
}

ejecutarSiDirecta(require.main, module, "seed", main);
