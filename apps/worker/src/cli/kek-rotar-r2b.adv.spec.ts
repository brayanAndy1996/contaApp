// Ronda adversarial 2b (spec 003, T16b), sin BD: `kek:rotar` con argumentos hostiles y con la llave
// "anterior" igual a la activa. Cada prueba afirma el comportamiento SEGURO esperado: si falla, es un
// hallazgo (tasks.md, T16b). Llaves `local` temporales; nunca se imprimen.
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { borrarDirectorio, directorioTemporal, envWorker, generarParLocal, type ParLocal } from "../../test/bd.js";
import { canario, dbProhibido, uuid } from "../../test/soporte.js";
import { main } from "./kek-rotar.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENV = { KEY_PROVIDER: "local", KEK_ID: "k2", KEK_PRIVATE_KEY_PATH: "/no/existe/k2-private.pem", NODE_ENV: "test" };

async function correr(argv: string[], env: Record<string, string | undefined> = ENV) {
  const prohibido = dbProhibido();
  const salida: string[] = [];
  const codigo = await main(argv, env, {
    db: prohibido.db as never,
    escribir: (l) => salida.push(l),
    escribirError: (l) => salida.push(l),
  });
  return { codigo, salida: salida.join("\n"), usos: prohibido.usos() };
}

let dir: string;
let k2: ParLocal;

beforeAll(async () => {
  dir = await directorioTemporal();
  k2 = await generarParLocal(dir, "r2b-k2");
});

afterAll(async () => {
  if (dir) await borrarDirectorio(dir);
});

describe("T16b · kek:rotar con argumentos de formato raro", () => {
  const t = uuid();
  const marca = canario("arg");
  const casos: Array<[string, string[], string]> = [
    ["--tenant en mayúsculas", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", t.toUpperCase()], t.toUpperCase()],
    ["--tenant entre llaves", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", `{${t}}`], `{${t}}`],
    ["--tenant urn:uuid", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", `urn:uuid:${t}`], `urn:uuid:${t}`],
    ["--tenant con salto final", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", `${t}\n`], `${t}\n`],
    ["--tenant con espacio de ancho cero", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", `${t}​`], `${t}​`],
    ["--tenant con canario", ["--desde", "k1", "--privada-anterior", "/x", "--tenant", `${t}${marca}`], marca],
    ["--desde repetido", ["--desde", "k1", "--desde", "k3", "--privada-anterior", "/x", "--tenant", t], "k3"],
    ["--privada-anterior repetida", ["--desde", "k1", "--privada-anterior", `/x/${marca}`, "--privada-anterior", "/y", "--tenant", t], marca],
    ["--desde=valor", [`--desde=${marca}`, "--privada-anterior", "/x", "--tenant", t], marca],
    ["--desde con salto", ["--desde", "k1\nk2", "--privada-anterior", "/x", "--tenant", t], "k1\nk2"],
  ];

  it.each(casos)("%s: código 2, sin BD y sin reflejar el valor", async (_n, argv, reflejo) => {
    const r = await correr(argv);
    expect(r.codigo).toBe(2);
    expect(r.usos).toBe(0);
    expect(r.salida.includes(reflejo)).toBe(false);
  });
});

describe("T16b · kek:rotar con la misma llave como anterior y activa", () => {
  it("una 'anterior' con el mismo material que la activa (otra ruta y otro kek_id) se rechaza antes de tocar la BD", async () => {
    // Error de operación realista: KEK_PRIVATE_KEY_PATH sigue apuntando a la llave vieja con KEK_ID nuevo.
    // Una rotación así "termina bien" pero no saca ninguna DEK de la llave que se quiere jubilar.
    const copia = path.join(dir, "anterior-copia.pem");
    await copyFile(k2.privada, copia);
    const r = await correr(["--desde", "r2b-k1", "--privada-anterior", copia, "--tenant", uuid()], envWorker(k2));
    expect(r.usos, "kek:rotar avanzó a la BD con anterior y activa del mismo material").toBe(0);
    expect(r.codigo).not.toBe(0);
    expect(r.salida.includes(copia)).toBe(false);
  });
});
