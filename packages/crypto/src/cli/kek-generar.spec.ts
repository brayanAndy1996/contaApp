import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crearKeyWrapper, cifrarCredencial } from "../index";
import { crearKeyUnwrapper, descifrarSobre } from "../descifrado";
import { generarKek, main, type ResultadoKekGenerar } from "./kek-generar";
import {
  VALOR_SOL,
  borrarDir,
  capturarError,
  crearDirTemporal,
  ctxSol,
} from "../soporte-pruebas";

// CA-11 (llaves locales): `kek:generar` crea el par en --salida, sin sobrescribir y sin imprimir material de llave.
// Contrato asumido (plan.md): generarKek({ salida }, { log? }) -> { rutaPublica, rutaPrivada, huella }.
const ENCABEZADO = "-----" + "BEGIN";

let dir: string;
let salida: string;
let resultado: ResultadoKekGenerar;
const impreso: string[] = [];

function huellaSpki(rutaPublica: string): { hex: string; b64: string } {
  const der = createPublicKey(readFileSync(rutaPublica)).export({
    type: "spki",
    format: "der",
  });
  const digest = createHash("sha256").update(der).digest();
  return { hex: digest.toString("hex"), b64: digest.toString("base64") };
}

beforeAll(async () => {
  dir = await crearDirTemporal();
  salida = join(dir, "secrets");
  resultado = await generarKek({ salida }, { log: (l) => impreso.push(l) });
}, 120_000);

afterAll(async () => {
  if (dir) await borrarDir(dir);
});

describe("CA-11 kek:generar crea el par", () => {
  it("crea kek-public.pem y kek-private.pem en la carpeta de salida (la crea si no existe)", () => {
    expect(existsSync(join(salida, "kek-public.pem"))).toBe(true);
    expect(existsSync(join(salida, "kek-private.pem"))).toBe(true);
    expect(resultado.rutaPublica).toBe(join(salida, "kek-public.pem"));
    expect(resultado.rutaPrivada).toBe(join(salida, "kek-private.pem"));
  });

  it("el par es RSA de 4096 bits y la pública corresponde a la privada", () => {
    const publica = createPublicKey(readFileSync(resultado.rutaPublica));
    const privada = createPrivateKey(readFileSync(resultado.rutaPrivada));
    expect(publica.asymmetricKeyType).toBe("rsa");
    expect(publica.asymmetricKeyDetails?.modulusLength).toBe(4096);
    expect(privada.asymmetricKeyDetails?.modulusLength).toBe(4096);
    const derivada = createPublicKey(privada).export({
      type: "spki",
      format: "der",
    });
    const guardada = publica.export({ type: "spki", format: "der" });
    expect(Buffer.compare(derivada, guardada)).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "permisos: privada 0600 y pública 0644",
    () => {
      expect(statSync(resultado.rutaPrivada).mode & 0o777).toBe(0o600);
      expect(statSync(resultado.rutaPublica).mode & 0o777).toBe(0o644);
    },
  );

  it("el par generado sirve con KEY_PROVIDER=local de punta a punta", async () => {
    const sobre = await cifrarCredencial(
      crearKeyWrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PUBLIC_KEY_PATH: resultado.rutaPublica,
      }),
      ctxSol(),
      VALOR_SOL,
    );
    const secreto = await descifrarSobre(
      crearKeyUnwrapper({
        KEY_PROVIDER: "local",
        KEK_ID: "k1",
        KEK_PRIVATE_KEY_PATH: resultado.rutaPrivada,
      }),
      ctxSol(),
      sobre,
    );
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });
});

describe("CA-11 la salida no contiene material de llave", () => {
  it("imprime rutas y la huella pública (SHA-256 del SPKI, en hex o base64)", () => {
    const texto = impreso.join("\n");
    expect(texto).toContain("kek-public.pem");
    expect(texto).toContain("kek-private.pem");
    const { hex, b64 } = huellaSpki(resultado.rutaPublica);
    expect(texto.includes(hex) || texto.includes(b64)).toBe(true);
    expect(resultado.huella === hex || resultado.huella === b64).toBe(true);
  });

  it("no imprime ni devuelve encabezados PEM ni fragmentos del cuerpo de ninguna llave", () => {
    const texto = impreso.join("\n") + JSON.stringify(resultado);
    expect(texto).not.toContain(ENCABEZADO);
    for (const ruta of [resultado.rutaPrivada, resultado.rutaPublica]) {
      const cuerpo = readFileSync(ruta, "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("-----"));
      for (const linea of cuerpo.slice(0, 4)) {
        expect(texto.includes(linea)).toBe(false);
      }
    }
  });
});

describe("CA-11 no sobrescribe archivos existentes", () => {
  it("una segunda ejecución sobre la misma carpeta falla y deja las llaves intactas", async () => {
    const antesPrivada = readFileSync(resultado.rutaPrivada);
    const antesPublica = readFileSync(resultado.rutaPublica);
    const error = await capturarError(() => generarKek({ salida }));
    expect(error.message).not.toContain(ENCABEZADO);
    expect(readFileSync(resultado.rutaPrivada).equals(antesPrivada)).toBe(true);
    expect(readFileSync(resultado.rutaPublica).equals(antesPublica)).toBe(true);
  });

  it("si solo existe la privada, tampoco la pisa", async () => {
    const parcial = join(dir, "parcial");
    await mkdir(parcial, { recursive: true });
    const marcador = randomBytes(16);
    await writeFile(join(parcial, "kek-private.pem"), marcador);
    await capturarError(() => generarKek({ salida: parcial }));
    expect(
      readFileSync(join(parcial, "kek-private.pem")).equals(marcador),
    ).toBe(true);
  });
});

describe("CA-11 main(argv)", () => {
  it("--salida crea el par y no escribe material de llave en la consola", async () => {
    const otra = join(dir, "via-main");
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        capturado.push(a.map(String).join(" "));
      }),
    );
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((
      c: unknown,
    ) => {
      capturado.push(String(c));
      return true;
    }) as never);
    try {
      await main(["--salida", otra]);
    } finally {
      for (const e of espias) e.mockRestore();
      out.mockRestore();
    }
    expect(existsSync(join(otra, "kek-public.pem"))).toBe(true);
    expect(existsSync(join(otra, "kek-private.pem"))).toBe(true);
    expect(capturado.join("\n")).not.toContain(ENCABEZADO);
  });
});
