// `pnpm db:seed`: seed mínimo idempotente (ON CONFLICT DO NOTHING) con MIGRATIONS_DATABASE_URL.
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
