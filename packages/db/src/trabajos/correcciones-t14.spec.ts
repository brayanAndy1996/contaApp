// T14 (backend, correcciones de la ronda adversarial 1) sin BD: guarda de intentos en `transicionar` (H-008-1b-3) y
// `marcarCredencialInvalida` con el trabajo que falló (H-008-1b-5). El comportamiento con BD real lo fijan los
// `*-r1b.adv.int.spec.ts` del worker.
import { describe, expect, it } from "vitest";
import { marcarCredencialInvalida } from "../credenciales/estado";
import { transicionar } from "./registro";
import { txFalso } from "./soporte-prueba";

const ID = "00000000-0000-4000-8000-0000000000j1";
const CLI = "00000000-0000-4000-8000-0000000000c1";

describe("transicionar con guarda de intentos", () => {
  it("agrega `and intentos = $n` con el valor como parámetro y gana solo con rowCount 1", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    expect(
      await transicionar(
        tx,
        ID,
        "ejecutando",
        "completado",
        { resultado: null },
        { intentos: 2 },
      ),
    ).toBe(true);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(
      /where id = \$1 and estado = \$2 and intentos = \$5$/,
    );
    expect(valores).toEqual([ID, "ejecutando", "completado", null, 2]);
  });

  it("una guarda no entera lanza antes de consultar", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await expect(
      transicionar(tx, ID, "ejecutando", "error", {}, { intentos: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(llamadas).toHaveLength(0);
  });
});

describe("marcarCredencialInvalida con trabajoId", () => {
  it("solo marca si el estado no cambió desde el inicio del trabajo (subconsulta por id, como parámetro)", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    expect(
      await marcarCredencialInvalida(tx, CLI, "sol", "credencial_invalida", ID),
    ).toBe(true);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(
      /estado_at is null or estado_at <= \(select j\.iniciado_en from job_registro j where j\.id = \$4\)/,
    );
    expect(valores).toEqual([CLI, "sol", "credencial_invalida", ID]);
    expect(texto).not.toContain(ID);
  });

  it("si la credencial cambió (0 filas) devuelve false", async () => {
    const { tx } = txFalso({ rowCount: 0 });
    expect(
      await marcarCredencialInvalida(tx, CLI, "sol", "credencial_invalida", ID),
    ).toBe(false);
  });
});
