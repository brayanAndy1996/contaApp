// Spec 008 · T13b (ronda adversarial 1b): `prueba.eco` registrado fuera de test. El catálogo se evalúa al importar
// `@contapp/queue`; se importa el paquete compilado (dist, lo que corre en producción) en procesos hijos con NODE_ENV
// distinto de "test" exacto y se comprueba que el tipo no existe (definicionDe lanza `tipo_desconocido`).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(__dirname, "../dist/index.js");

const sonda = `
const m = await import(${JSON.stringify(dist)});
let r;
try { m.definicionDe("prueba.eco"); r = "registrado"; } catch (e) { r = e?.codigo ?? "otro"; }
process.stdout.write(r);
`;

function probar(nodeEnv: string | undefined): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return execFileSync(process.execPath, ["--input-type=module", "-e", sonda], { env, encoding: "utf8", timeout: 20_000 });
}

describe.skipIf(!existsSync(dist))("prueba.eco solo existe con NODE_ENV=test exacto", () => {
  it.each([[undefined], ["production"], ["development"], ["TEST"], [" test"], ["test "], ["testing"], [""]])(
    "NODE_ENV=%j -> tipo_desconocido",
    (valor) => {
      expect(probar(valor)).toBe("tipo_desconocido");
    },
  );

  it("control: con NODE_ENV=test sí está registrado", () => {
    expect(probar("test")).toBe("registrado");
  });
});
