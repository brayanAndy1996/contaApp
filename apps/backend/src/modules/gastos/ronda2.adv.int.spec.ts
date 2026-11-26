/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Spec 027 · T18 (ronda adversarial 2, BD y HTTP). Caja negra con spec.md (R-4, R-8, R-12, D-8; CA-12) y caja blanca de 0071
// (`public.gnd_formas`) frente al dominio (`DiccionarioGlosas`, `mismaPalabra`), `reevaluar.service.ts` (dedupe de 008 con trabajos
// `en_cola` o `ejecutando`) y `procesadores/reevaluar-periodo.ts` (contexto leído por lote). Cada fallo es un hallazgo H-027-2-n.
// No repite T15 (`ronda1.adv.int.spec.ts`), T16 (`plural.int.spec.ts`) ni T17 (`tests/aislamiento/gnd-plataforma.spec.ts`).
import { DiccionarioGlosas } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoGastos, PERIODO, rutaPalabras, rutaReevaluar, type BancoGastos } from "../../../test/soporte-gastos.js";
import { prepararStorage, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoGastos;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoGastos();
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

/** El dominio dice «misma palabra» (token sin punto contra palabra del diccionario) por su API pública. */
const dominio = (palabra: string, token: string): boolean =>
  DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: [palabra] }]).coincidenciasPorItem([token]).length > 0;

describe("T18 · D-8: `gnd_formas` (0071) y el dominio deciden igual «la otra forma»", () => {
  it("regresión: para un corpus de pares (tildes ya normalizadas, «-ces», «-ches», «-ses», 3 letras, dígitos), `b = ANY(gnd_formas(a))` ⇔ el dominio coincide", async () => {
    const palabras = [
      "zapatilla", "pantalon", "lapiz", "lapices", "luz", "luces", "mes", "meses", "gas", "gases", "ron", "rones", "cine", "cines",
      "sandwich", "sandwiches", "coche", "coches", "reloj", "relojes", "rey", "reyes", "xbox", "xboxes", "club", "clubes", "album",
      "albumes", "guante", "guantes", "media", "medias", "tenis", "teni", "audifono", "audifonos", "audifonoes", "mp3", "mp3s",
      "chips", "chip", "paraguas", "paragua", "dulce", "dulces", "dulc", "ajies", "aji", "bus", "buses", "ses", "seses", "tes",
    ];
    const pares: [string, string][] = [];
    for (const a of palabras) for (const b of palabras) if (a.length >= 3 && b.length >= 3) pares.push([a, b]);
    const filas = await v.b.sql(
      "select x.a, x.b, x.b = any(public.gnd_formas(x.a)) as sql from unnest($1::text[], $2::text[]) as x(a, b)",
      [pares.map((p) => p[0]), pares.map((p) => p[1])],
    );
    const distintos = filas
      .filter((f: any) => f.sql !== dominio(f.a, f.b) || f.sql !== dominio(f.b, f.a))
      .map((f: any) => `${f.a}~${f.b}: sql=${f.sql} dominio=${dominio(f.a, f.b)}/${dominio(f.b, f.a)}`);
    expect(distintos).toEqual([]);
  });
});

describe("T18 · «Volver a evaluar» con un cambio del diccionario a mitad (R-8, R-12; CA-12)", () => {
  it("H-027-2-8 · pedirlo otra vez tras cambiar el diccionario mientras el trabajo ya se ejecuta encola una re-evaluación nueva (no se absorbe en el que ya leyó el diccionario viejo)", async () => {
    const est = await v.estudio();
    const contador = await v.b.c.p.b.miembro(est.tenantId, "contador");
    const c = await v.cliente(est, { responsable: contador.id });

    const primero = await v.http(contador, "POST", rutaReevaluar(c.id, PERIODO));
    expect(primero.status, primero.text).toBe(202);
    // El worker lo toma y procesa los primeros lotes (cada lote lee el diccionario de ESE momento).
    await v.b.sql("update job_registro set estado = 'ejecutando', iniciado_en = now() where id = $1", [primero.body.trabajoId]);

    // A mitad, el Dueño agrega una palabra y vuelve a pedir «Volver a evaluar» para que rija «en todo el periodo» (R-8).
    const palabra = `adv${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, "");
    const alta = await v.http(est.titular, "POST", rutaPalabras(), { palabra, categoria: "juguetes", excepciones: [] });
    expect(alta.status, alta.text).toBe(201);
    const segundo = await v.http(contador, "POST", rutaReevaluar(c.id, PERIODO));
    expect(segundo.status, segundo.text).toBe(202);

    // Esperado: un trabajo nuevo en cola (o el vivo marcado para repetirse). Obtenido: el mismo trabajo en ejecución, cuyos lotes ya
    // procesados no verán la palabra nueva; el 202 no dice que esas compras quedaron con el diccionario viejo.
    const trabajos = await v.trabajosReevaluar(est.tenantId, c.id);
    expect(segundo.body.trabajoId).not.toBe(primero.body.trabajoId);
    expect(trabajos.filter((t: any) => t.estado === "en_cola")).toHaveLength(1);
  });
});
