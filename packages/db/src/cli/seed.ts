// `pnpm db:seed`: seed mínimo idempotente (ON CONFLICT DO NOTHING) con MIGRATIONS_DATABASE_URL.
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../schema";
import { SEED } from "../seed/datos";
import { ejecutar, urlMigraciones } from "./comun";

async function main(): Promise<void> {
  const client = new Client({ connectionString: urlMigraciones() });
  await client.connect();
  try {
    const db = drizzle(client, { schema });
    await db.transaction(async (tx) => {
      await tx.insert(schema.tenant).values(SEED.tenants).onConflictDoNothing();
      await tx.insert(schema.usuario).values(SEED.usuarios).onConflictDoNothing();
      await tx.insert(schema.membresia).values(SEED.membresias).onConflictDoNothing();
      const clientes = [
        ...SEED.clientesA.map((c) => ({ ...c, tenantId: SEED.tenantA })),
        ...SEED.clientesB.map((c) => ({ ...c, tenantId: SEED.tenantB })),
      ];
      await tx.insert(schema.cliente).values(clientes).onConflictDoNothing();
    });
  } finally {
    await client.end();
  }
}

if (require.main === module) ejecutar("seed", main);
