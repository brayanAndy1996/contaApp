import { describe, expect, it } from "vitest";
import { origenXmlSchema } from "./origen.js";

describe("origenXmlSchema", () => {
  it.each(["simulado", "real"])("acepta %s", (valor) => {
    expect(origenXmlSchema.parse(valor)).toBe(valor);
  });

  it.each(["Simulado", "fixture", "", null, 1])("rechaza %s", (valor) => {
    expect(origenXmlSchema.safeParse(valor).success).toBe(false);
  });
});
