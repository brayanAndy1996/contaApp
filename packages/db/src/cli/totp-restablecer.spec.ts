// Spec 029 (T1, rojo) · U5: argumentos y scripts del CLI `db:totp-restablecer` (sin BD). El efecto en la BD esta en totp-restablecer.int.spec.ts.
// Contrato (lo implementa T8, `./totp-restablecer.ts`): `parsearArgumentos(argv)` -> { correo } (normalizado: trim, minusculas, NFC, ASCII) y
// `main(argv, env, deps?)`; scripts `db:totp-restablecer` en packages/db/package.json y en el package.json de la raiz.
// Rojo por: `./totp-restablecer` no existe y los scripts no estan.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCli } from "./comun";
import { parsearArgumentos } from "./totp-restablecer";

const leerJson = (ruta: string) => JSON.parse(readFileSync(join(__dirname, ruta), "utf8")) as { scripts: Record<string, string> };

describe("parsearArgumentos", () => {
  it("normaliza el correo (espacios, mayusculas)", () => {
    expect(parsearArgumentos(["--correo", "  Titular@Ejemplo.TEST "])).toEqual({ correo: "titular@ejemplo.test" });
  });

  it.each([
    ["falta --correo", []],
    ["falta el valor", ["--correo"]],
    ["argumento desconocido", ["--correo", "a@x.pe", "--nombre", "x"]],
    ["--correo repetido", ["--correo", "a@x.pe", "--correo", "b@x.pe"]],
    ["correo sin arroba", ["--correo", "sin-arroba"]],
    ["correo no ASCII", ["--correo", "ñandú@x.pe"]],
    ["correo con espacio dentro", ["--correo", "a b@x.pe"]],
    ["correo de mas de 254 caracteres", ["--correo", `${"a".repeat(250)}@x.pe`]],
  ])("%s: ErrorCli con mensaje fijo que no repite el correo", (_n, argv) => {
    let e: unknown;
    try {
      parsearArgumentos(argv);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ErrorCli);
    for (const v of argv.filter((a) => a.includes("@") || a.length > 20)) expect((e as Error).message).not.toContain(v);
  });
});

describe("scripts", () => {
  it("packages/db: db:totp-restablecer corre dist/cli/totp-restablecer.js con el .env opcional, como db:plataforma-alta", () => {
    const s = leerJson("../../package.json").scripts;
    expect(s["db:totp-restablecer"]).toBe("node --env-file-if-exists=../../.env dist/cli/totp-restablecer.js");
  });

  it("raiz: pnpm db:totp-restablecer delega en el paquete db", () => {
    const s = leerJson("../../../../package.json").scripts;
    expect(s["db:totp-restablecer"]).toBe("pnpm --filter @contapp/db db:totp-restablecer");
  });
});
