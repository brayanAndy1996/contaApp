// T16 (backend, correcciones de la ronda adversarial 2) sin BD: tope atómico de pendientes en `insertarTrabajo`
// (H-008-2a-3, H-008-2b-7) y versión de la credencial en `marcarCredencialInvalida` (H-008-2a-4). El comportamiento con
// BD real lo fijan `packages/queue/src/{despachador-r2a,carreras-r2b}.adv.int.spec.ts` y
// `apps/worker/src/trabajos/ejecutor-r2a.adv.int.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  marcarCredencialInvalida,
  versionCredencial,
} from "../credenciales/estado";
import { TrabajosRepoError } from "./errores";
import { insertarTrabajo, type NuevoTrabajo } from "./registro";
import { errorPg, FILA, txFalso } from "./soporte-prueba";

const CLI = "00000000-0000-4000-8000-0000000000c1";
const nuevo: NuevoTrabajo & { maxPendientes: number } = {
  clienteId: CLI,
  ruc: "20100000001",
  tipo: "sire.propuesta.descargar",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  parametros: { periodo: "202610" },
  claveDedupe: Buffer.alloc(32, 1),
  creadoPor: null,
  maxIntentos: 4,
  maxPendientes: 2,
};
const textos = (ll: Array<{ texto: string }>) =>
  ll.map((l) => l.texto.trim().split(/\s+/).slice(0, 4).join(" "));

describe("insertarTrabajo con tope de pendientes", () => {
  it("inserta, toma el candado del estudio y la cola, cuenta y confirma el savepoint", async () => {
    const { tx, llamadas } = txFalso(
      { rows: [] },
      { rows: [FILA] },
      { rows: [{}] },
      { rows: [{ n: "2" }] },
      { rows: [] },
    );
    const r = await insertarTrabajo(tx, nuevo, { sinDuplicar: true });
    expect(r).toMatchObject({ id: FILA.id, estado: "en_cola" });
    const t = llamadas.map((l) => l.texto);
    expect(t).toHaveLength(5);
    expect(t[0]).toBe("savepoint job_insertar");
    expect(t[1]).toMatch(/^insert into job_registro/);
    expect(t[2]).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\(\s*'job_registro\.pendientes:'/,
    );
    expect(t[2]).toMatch(/current_setting\('app\.tenant_id', true\)/);
    expect(t[3]).toMatch(/^select count\(\*\)/);
    expect(t[4]).toBe("release savepoint job_insertar");
    expect(llamadas[1]!.texto).toMatch(/on conflict/);
    expect(llamadas[2]!.valores).toEqual(["sire"]);
  });

  it("si con el propio pasa el tope, vuelve al savepoint y responde 'lleno'", async () => {
    const { tx, llamadas } = txFalso(
      { rows: [] },
      { rows: [FILA] },
      { rows: [{}] },
      { rows: [{ n: "3" }] },
      { rows: [] },
    );
    expect(await insertarTrabajo(tx, nuevo)).toBe("lleno");
    expect(textos(llamadas).slice(-2)).toEqual([
      "rollback to savepoint job_insertar",
      "release savepoint job_insertar",
    ]);
    expect(llamadas[1]!.texto).not.toMatch(/on conflict/);
  });

  it("un choque de dedupe (sin fila con ON CONFLICT) vuelve al savepoint y da null, sin candado", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await insertarTrabajo(tx, nuevo, { sinDuplicar: true })).toBeNull();
    expect(textos(llamadas)).toEqual([
      "savepoint job_insertar",
      "insert into job_registro (cliente_id,",
      "rollback to savepoint job_insertar",
      "release savepoint job_insertar",
    ]);
  });

  it("un 23505 sin ON CONFLICT vuelve al savepoint y da null; otro error se propaga sin datos", async () => {
    const choque = txFalso({ rows: [] }, errorPg("23505"), { rows: [] });
    expect(await insertarTrabajo(choque.tx, nuevo)).toBeNull();
    expect(textos(choque.llamadas).slice(-2)).toEqual([
      "rollback to savepoint job_insertar",
      "release savepoint job_insertar",
    ]);
    const otro = txFalso({ rows: [] }, errorPg("23514"));
    const e = await insertarTrabajo(otro.tx, nuevo).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("23514");
    expect(String((e as Error).message)).not.toContain("CANARIO");
  });

  it("sin tope, el INSERT es el de siempre (sin savepoint ni candado)", async () => {
    const { tx, llamadas } = txFalso({ rows: [FILA] });
    const sinTope: NuevoTrabajo = { ...nuevo, maxPendientes: undefined };
    expect(await insertarTrabajo(tx, sinTope)).toMatchObject({ id: FILA.id });
    expect(llamadas).toHaveLength(1);
  });
});

describe("credencial: versión de la fila (H-008-2a-4)", () => {
  it("versionCredencial devuelve el xmin como texto, o null sin credencial", async () => {
    const hay = txFalso({ rows: [{ version: "1234" }] });
    expect(await versionCredencial(hay.tx, CLI, "sol")).toBe("1234");
    expect(hay.llamadas[0]!.texto).toMatch(
      /select xmin::text as version from credencial/,
    );
    expect(hay.llamadas[0]!.valores).toEqual([CLI, "sol"]);
    expect(
      await versionCredencial(txFalso({ rows: [] }).tx, CLI, "sol"),
    ).toBeNull();
  });

  it("marcar con versión compara el xmin (parámetro) y no la fecha", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    expect(
      await marcarCredencialInvalida(
        tx,
        CLI,
        "sol",
        "credencial_invalida",
        "j",
        "1234",
      ),
    ).toBe(true);
    expect(llamadas[0]!.texto).toMatch(/and xmin::text = \$4$/);
    expect(llamadas[0]!.texto).not.toContain("iniciado_en");
    expect(llamadas[0]!.valores).toEqual([
      CLI,
      "sol",
      "credencial_invalida",
      "1234",
    ]);
  });

  it("marcar con versión null (no había credencial al empezar) no consulta ni marca", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    expect(
      await marcarCredencialInvalida(
        tx,
        CLI,
        "sol",
        "credencial_invalida",
        "j",
        null,
      ),
    ).toBe(false);
    expect(llamadas).toHaveLength(0);
  });
});
