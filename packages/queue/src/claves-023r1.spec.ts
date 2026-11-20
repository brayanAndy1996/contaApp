// Spec 023 · T18 (H-023-1-1): la clave de dedupe no depende de la grafía del UUID del cliente.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claveDedupe, jsonCanonico } from "./index.js";

const C = "0190a000-0000-7000-8000-0000000000ab";

describe("claveDedupe · id del cliente en minúsculas", () => {
  it("mayúsculas y minúsculas dan la misma clave, igual a la ya guardada con el id de la BD (minúsculas)", () => {
    const guardada = createHash("sha256")
      .update(jsonCanonico(["sol.buzon.revisar", C, {}]), "utf8")
      .digest();
    expect(claveDedupe("sol.buzon.revisar", C.toUpperCase(), {})).toEqual(
      guardada,
    );
    expect(claveDedupe("sol.buzon.revisar", C, {})).toEqual(guardada);
  });

  it("los parámetros no se tocan: otra grafía en ellos es otra clave", () => {
    const m = "0190a000-0000-7000-8000-00000000aaa1";
    expect(
      claveDedupe("sol.buzon.abrir", C, { mensajeId: m.toUpperCase() }),
    ).not.toEqual(claveDedupe("sol.buzon.abrir", C, { mensajeId: m }));
  });
});
