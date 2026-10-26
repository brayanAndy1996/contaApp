import { HttpException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { OrigenGuard } from "./origen.guard.js";

// CA-7 / D6 (spec 004). Contrato (plan: Decisiones: CSRF):
//   new OrigenGuard(appOrigin: string)   // APP_ORIGIN exacto, p. ej. "http://localhost:3000"
//   canActivate(ctx): true si pasa; si no, lanza HttpException 403 cuyo cuerpo es
//     { codigo: "origen_invalido" }.
// Matriz, solo para métodos que no son GET:
//   - con `Origin`: debe ser igual a APP_ORIGIN (comparación exacta, sin barra final);
//   - sin `Origin`: `Sec-Fetch-Site` debe ser "same-origin";
//   - sin ambos, o con "cross-site" / "same-site" / "none": 403.
// Un GET no se valida (ningún GET cambia estado).
const APP = "http://localhost:3000";

function contexto(metodo: string, headers: Record<string, string | undefined>): ExecutionContext {
  const limpios: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) limpios[k] = v;
  const req = { method: metodo, headers: limpios };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function resultado(metodo: string, headers: Record<string, string | undefined>) {
  const guard = new OrigenGuard(APP);
  try {
    return { pasa: guard.canActivate(contexto(metodo, headers)) as boolean };
  } catch (e) {
    return { error: e };
  }
}

function expectaRechazo(metodo: string, headers: Record<string, string | undefined>) {
  const r = resultado(metodo, headers);
  expect(r.pasa).toBeUndefined();
  expect(r.error).toBeInstanceOf(HttpException);
  const e = r.error as HttpException;
  expect(e.getStatus()).toBe(403);
  expect(e.getResponse()).toMatchObject({ codigo: "origen_invalido" });
}

const METODOS = ["POST", "PUT", "PATCH", "DELETE"];

describe("Origin presente", () => {
  it.each(METODOS)("%s con Origin igual a APP_ORIGIN pasa", (m) => {
    expect(resultado(m, { origin: APP }).pasa).toBe(true);
  });

  it.each(METODOS)("%s con Origin igual y Sec-Fetch-Site same-origin pasa", (m) => {
    expect(resultado(m, { origin: APP, "sec-fetch-site": "same-origin" }).pasa).toBe(true);
  });

  it.each([
    ["otro dominio", "http://evil.example"],
    ["subdominio engañoso", "http://localhost:3000.evil.example"],
    ["prefijo engañoso", "http://localhost:30000"],
    ["otro puerto", "http://localhost:3001"],
    ["otro esquema", "https://localhost:3000"],
    ["con barra final", "http://localhost:3000/"],
    ["con ruta", "http://localhost:3000/login"],
    ["null (contexto opaco)", "null"],
    ["vacío", ""],
    ["lista de orígenes", `${APP}, http://evil.example`],
  ])("Origin ajeno (%s) -> 403 origen_invalido", (_n, origin) => {
    expectaRechazo("POST", { origin });
  });

  it("Origin ajeno gana sobre Sec-Fetch-Site same-origin", () => {
    expectaRechazo("POST", { origin: "http://evil.example", "sec-fetch-site": "same-origin" });
  });

  it.each(METODOS)("%s con Origin ajeno -> 403", (m) => {
    expectaRechazo(m, { origin: "http://evil.example" });
  });

  // T16 (H2): con Origin correcto, un Sec-Fetch-Site presente también decide.
  it.each([["cross-site"], ["same-site"], ["none"], [""]])(
    "Origin igual con Sec-Fetch-Site %j -> 403",
    (valor) => {
      expectaRechazo("POST", { origin: APP, "sec-fetch-site": valor });
    },
  );
});

describe("sin Origin: decide Sec-Fetch-Site", () => {
  it.each(METODOS)("%s con same-origin pasa", (m) => {
    expect(resultado(m, { "sec-fetch-site": "same-origin" }).pasa).toBe(true);
  });

  it.each([["cross-site"], ["same-site"], ["none"], ["Same-Origin-x"], [""]])(
    "Sec-Fetch-Site %j -> 403",
    (valor) => {
      expectaRechazo("POST", { "sec-fetch-site": valor });
    },
  );

  it.each(METODOS)("%s sin Origin ni Sec-Fetch-Site -> 403", (m) => {
    expectaRechazo(m, {});
  });

  it("el Referer no sustituye a Origin", () => {
    expectaRechazo("POST", { referer: `${APP}/login` });
  });
});

describe("GET no se valida", () => {
  it.each([
    ["sin cabeceras", {}],
    ["con Origin ajeno", { origin: "http://evil.example" }],
    ["con Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("GET %s pasa", (_n, headers) => {
    expect(resultado("GET", headers).pasa).toBe(true);
  });
});

describe("configuración", () => {
  it("compara contra el APP_ORIGIN recibido, no contra uno fijo", () => {
    const guard = new OrigenGuard("https://app.estudio.pe");
    expect(guard.canActivate(contexto("POST", { origin: "https://app.estudio.pe" }))).toBe(true);
    expect(() => guard.canActivate(contexto("POST", { origin: APP }))).toThrow(HttpException);
  });
});
