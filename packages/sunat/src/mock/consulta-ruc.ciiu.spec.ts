import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorDatos, ErrorTransitorio } from "../errores.js";
import { MockConsultaRuc } from "./consulta-ruc.mock.js";
import type { DatosRuc } from "../puertos.js";

// Spec 027 (R-14, U-7; plan 027, Contratos: sunat; T2). La clase CIIU de la actividad principal en `ConsultaRuc` y su mock. Contrato fijado:
//  - `DatosRuc` suma `ciiu: string | null` (4 dígitos, o null si el padrón no la informa). `consultar` conserva razonSocial, estado y condicion.
//  - `crear({ dirFixtures? })`: `{dirFixtures}/ciiu.json` = objeto `{ "<ruc de 11 dígitos>": "<clase de 4 dígitos>" | null }`. Por defecto
//    `fixtures/ruc` del repositorio, resuelta desde este archivo (igual en `src` y `dist`), no desde el `cwd`. El constructor sin argumentos sigue valiendo.
//  - RUC en el fixture -> su clase (o null). RUC que no está -> una clase de 4 dígitos DETERMINISTA por RUC, de una lista fija: sin reloj ni azar,
//    igual entre instancias y llamadas, y no siempre la misma para RUC distintos. Carpeta sin `ciiu.json` -> igual que «no está».
//  - Un fixture defectuoso (JSON inválido, no es objeto, RUC que no son 11 dígitos, clase que no son 4 dígitos ni null, más de 1 MiB) hace que
//    `consultar` rechace con `ErrorDatos` de mensaje fijo, que nunca lleva el RUC ni la ruta.
//  - Los centinelas de 007b no cambian: último dígito 7 -> ErrorTransitorio; 8 -> ErrorDatos; `fallar()` sigue funcionando.
//  - El fixture del repositorio (`fixtures/ruc/ciiu.json`, lo crea T9) trae: 20700000002 -> 4752 (ferretería), 20700000070 -> 4771 (proveedor de F001-5070),
//    al menos un restaurante 5610 y al menos un RUC con null.
// Tipado local del contrato nuevo (`ciiu` en el resultado y `dirFixtures` en el constructor): la prueba compila antes y después de T9.
type DatosRucCiiu = DatosRuc & { ciiu: string | null };
interface MockConCiiu {
  consultar(ruc: string): Promise<DatosRucCiiu>;
  fallar: MockConsultaRuc["fallar"];
  readonly llamadas: number;
  llamadasDe(ruc: string): number;
}
const crear = (opciones?: { dirFixtures?: string }): MockConCiiu =>
  new (MockConsultaRuc as unknown as new (o?: { dirFixtures?: string }) => MockConCiiu)(opciones);

const RUC_FERRETERIA = "20700000002";
const RUC_ZAPATILLAS = "20700000070";
const RUC_RESTAURANTE = "20700000123";
const RUC_SIN_CLASE = "20700000105";
const RUC_AUSENTE = "20100070970";

let raiz: string;
let dirOk: string;
const carpeta = (nombre: string, contenido: string | null): string => {
  const d = join(raiz, nombre);
  mkdirSync(d);
  if (contenido !== null) writeFileSync(join(d, "ciiu.json"), contenido);
  return d;
};

beforeAll(() => {
  raiz = mkdtempSync(join(tmpdir(), "ruc-ciiu-"));
  dirOk = carpeta("ok", JSON.stringify({ [RUC_FERRETERIA]: "4752", [RUC_ZAPATILLAS]: "4771", [RUC_RESTAURANTE]: "5610", [RUC_SIN_CLASE]: null }));
});
afterAll(() => rmSync(raiz, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

const esErrorDatosFijo = async (p: Promise<unknown>, ...prohibidos: string[]) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorDatos);
    for (const x of prohibidos) expect(String((e as Error).message)).not.toContain(x);
    return;
  }
  throw new Error("se esperaba ErrorDatos");
};

describe("MockConsultaRuc: ciiu del fixture", () => {
  it("devuelve la clase del fixture junto a los datos de siempre", async () => {
    const puerto = crear({ dirFixtures: dirOk });
    const r: DatosRucCiiu = await puerto.consultar(RUC_FERRETERIA);
    expect(r.ciiu).toBe("4752");
    for (const campo of ["razonSocial", "estado", "condicion"] as const) expect(r[campo].length).toBeGreaterThan(0);
    expect((await puerto.consultar(RUC_ZAPATILLAS)).ciiu).toBe("4771");
    expect((await puerto.consultar(RUC_RESTAURANTE)).ciiu).toBe("5610");
  });
  it("devuelve null cuando el fixture dice null (el padrón no informa la clase)", async () => {
    const r = await crear({ dirFixtures: dirOk }).consultar(RUC_SIN_CLASE);
    expect(r.ciiu).toBeNull();
    expect(r.razonSocial.length).toBeGreaterThan(0);
  });
  it("la razón social sigue siendo la misma con y sin fixture (no cambia el contrato de 007b)", async () => {
    const con = await crear({ dirFixtures: dirOk }).consultar(RUC_FERRETERIA);
    const sin = await crear({ dirFixtures: carpeta("vacio-1", null) }).consultar(RUC_FERRETERIA);
    expect(con.razonSocial).toBe(sin.razonSocial);
    expect(con.razonSocial).not.toBe(`RUC ${RUC_FERRETERIA}`);
  });
  it("cuenta las llamadas igual que antes", async () => {
    const mock = crear({ dirFixtures: dirOk });
    await mock.consultar(RUC_FERRETERIA);
    await mock.consultar(RUC_FERRETERIA);
    expect(mock.llamadas).toBe(2);
    expect(mock.llamadasDe(RUC_FERRETERIA)).toBe(2);
  });
});

describe("MockConsultaRuc: ciiu determinista fuera del fixture", () => {
  it("un RUC que no está en el fixture recibe una clase de 4 dígitos", async () => {
    const r = await crear({ dirFixtures: dirOk }).consultar(RUC_AUSENTE);
    expect(r.ciiu).toMatch(/^[0-9]{4}$/);
  });
  it("es igual entre llamadas e instancias, y no depende del reloj", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));
    const m1 = crear({ dirFixtures: dirOk });
    const a = (await m1.consultar(RUC_AUSENTE)).ciiu;
    expect((await m1.consultar(RUC_AUSENTE)).ciiu).toBe(a);
    vi.setSystemTime(new Date("2031-07-04T23:59:59Z"));
    expect((await crear({ dirFixtures: dirOk }).consultar(RUC_AUSENTE)).ciiu).toBe(a);
  });
  it("RUC distintos no reciben todos la misma clase, y todas son de 4 dígitos", async () => {
    const mock = crear({ dirFixtures: dirOk });
    const clases = new Set<string | null>();
    for (let i = 0; i < 40; i++) {
      const ruc = `201000000${String(i * 10 + 1).padStart(2, "0")}`.slice(0, 11);
      const { ciiu } = await mock.consultar(ruc);
      expect(ciiu).toMatch(/^[0-9]{4}$/);
      clases.add(ciiu);
    }
    expect(clases.size).toBeGreaterThan(1);
  });
  it("una carpeta sin ciiu.json se comporta como «no está»: todo RUC resuelve con una clase determinista", async () => {
    const dir = carpeta("vacio-2", null);
    const a = (await crear({ dirFixtures: dir }).consultar(RUC_FERRETERIA)).ciiu;
    expect(a).toMatch(/^[0-9]{4}$/);
    expect((await crear({ dirFixtures: dir }).consultar(RUC_FERRETERIA)).ciiu).toBe(a);
  });
  it("una carpeta que no existe tampoco falla", async () => {
    const r = await crear({ dirFixtures: join(raiz, "no-existe") }).consultar(RUC_AUSENTE);
    expect(r.ciiu).toMatch(/^[0-9]{4}$/);
  });
});

describe("MockConsultaRuc: fixture malformado -> ErrorDatos", () => {
  const MALOS: [string, string][] = [
    ["JSON inválido", "{no es json"],
    ["vacío", ""],
    ["una lista", JSON.stringify([{ ruc: RUC_FERRETERIA, ciiu: "4752" }])],
    ["null", "null"],
    ["un número", "5"],
    ["una cadena", JSON.stringify("4752")],
    ["RUC de 10 dígitos", JSON.stringify({ "2070000002": "4752" })],
    ["RUC con letras", JSON.stringify({ "2070000000A": "4752" })],
    ["clave vacía", JSON.stringify({ "": "4752" })],
    ["clase de 3 dígitos", JSON.stringify({ [RUC_FERRETERIA]: "475" })],
    ["clase de 5 dígitos", JSON.stringify({ [RUC_FERRETERIA]: "47521" })],
    ["clase con letra", JSON.stringify({ [RUC_FERRETERIA]: "47a2" })],
    ["clase número", JSON.stringify({ [RUC_FERRETERIA]: 4752 })],
    ["clase vacía", JSON.stringify({ [RUC_FERRETERIA]: "" })],
    ["clase con espacio", JSON.stringify({ [RUC_FERRETERIA]: "4752 " })],
    ["clase objeto", JSON.stringify({ [RUC_FERRETERIA]: { ciiu: "4752" } })],
    ["una entrada buena y otra mala", JSON.stringify({ [RUC_FERRETERIA]: "4752", [RUC_ZAPATILLAS]: "x" })],
    ["más de 1 MiB", JSON.stringify({ [RUC_FERRETERIA]: "4752", relleno: "x".repeat(1_048_577) })],
  ];
  it.each(MALOS)("%s", async (_nombre, contenido) => {
    const mock = crear({ dirFixtures: carpeta(`malo-${Math.abs(hash(_nombre))}`, contenido) });
    await esErrorDatosFijo(mock.consultar(RUC_FERRETERIA), RUC_FERRETERIA, raiz);
    await esErrorDatosFijo(mock.consultar(RUC_AUSENTE), RUC_AUSENTE, raiz); // el fixture es uno solo: un defecto lo invalida entero
  });
  it("ciiu.json que es una carpeta -> ErrorDatos", async () => {
    const d = join(raiz, "carpeta-como-archivo");
    mkdirSync(join(d, "ciiu.json"), { recursive: true });
    await esErrorDatosFijo(crear({ dirFixtures: d }).consultar(RUC_FERRETERIA), RUC_FERRETERIA, raiz);
  });
  it("el mensaje del error es fijo: igual para dos defectos distintos", async () => {
    const mensajes: string[] = [];
    for (const [i, contenido] of ["{x", JSON.stringify({ [RUC_FERRETERIA]: "x" })].entries()) {
      try {
        await crear({ dirFixtures: carpeta(`msg-${i}`, contenido) }).consultar(RUC_FERRETERIA);
      } catch (e) {
        mensajes.push((e as Error).message);
      }
    }
    expect(mensajes).toHaveLength(2);
    expect(mensajes[0]).toBe(mensajes[1]);
  });
});

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

describe("MockConsultaRuc: centinelas y fallar() no cambian con el fixture", () => {
  it("el RUC que termina en 7 sigue siendo transitorio y el que termina en 8, de datos", async () => {
    const mock = crear({ dirFixtures: dirOk });
    await expect(mock.consultar("20100000007")).rejects.toBeInstanceOf(ErrorTransitorio);
    await expect(mock.consultar("20100000008")).rejects.toBeInstanceOf(ErrorDatos);
  });
  it("fallar('datos') y fallar('5xx', {veces}) siguen valiendo", async () => {
    const mock = crear({ dirFixtures: dirOk });
    mock.fallar("datos");
    await expect(mock.consultar(RUC_FERRETERIA)).rejects.toBeInstanceOf(ErrorDatos);
    mock.fallar("5xx", { veces: 1 });
    await expect(mock.consultar(RUC_FERRETERIA)).rejects.toBeInstanceOf(ErrorTransitorio);
    expect((await mock.consultar(RUC_FERRETERIA)).ciiu).toBe("4752");
  });
});

describe("fixtures/ruc/ciiu.json del repositorio (T9)", () => {
  const ruta = resolve(__dirname, "../../../../fixtures/ruc/ciiu.json");
  const leer = (): Record<string, unknown> => JSON.parse(readFileSync(ruta, "utf8")) as Record<string, unknown>;

  it("existe y cumple la gramática: RUC de 11 dígitos -> clase de 4 dígitos o null", () => {
    const f = leer();
    expect(Object.keys(f).length).toBeGreaterThanOrEqual(4);
    for (const [ruc, clase] of Object.entries(f)) {
      expect(ruc).toMatch(/^[0-9]{11}$/);
      expect(clase === null || (typeof clase === "string" && /^[0-9]{4}$/.test(clase))).toBe(true);
    }
  });
  it("trae la ferretería 4752, el proveedor de zapatillas 4771, un restaurante 5610 y un RUC con null", () => {
    const f = leer();
    expect(f["20700000002"]).toBe("4752");
    expect(f["20700000070"]).toBe("4771");
    expect(Object.values(f)).toContain("5610");
    expect(Object.values(f)).toContain(null);
  });
  it("el mock sin argumentos lo usa por defecto (no depende del cwd)", async () => {
    const mock = crear();
    expect((await mock.consultar("20700000002")).ciiu).toBe("4752");
    expect((await mock.consultar("20700000070")).ciiu).toBe("4771");
  });
});
