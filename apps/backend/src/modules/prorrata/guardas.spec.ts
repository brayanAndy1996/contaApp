// Spec 026 (T14a): guardas del módulo prorrata que no necesitan BD. Traducción de SQLSTATE a HTTP (D-7: solo códigos) y cuerpo ausente
// (sin cuerpo JSON Nest entrega `undefined`/`null`: es 400 `solicitud_invalida`, nunca un 500 ni una escritura).
import { ProrrataRepoError } from "@contapp/db";
import { describe, expect, it, vi } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { aErrorHttp } from "./apoyo.js";
import { ProrrataError } from "./errores.js";
import { EscrituraProrrataService } from "./escritura.service.js";
import { ObtencionProrrataService } from "./obtencion.service.js";

const CLIENTE = "8f14e45f-ceea-467f-a8e0-0c6a6c1d4f10";
const SESION = {} as never;
const ALCANCE = {} as never;

describe("aErrorHttp: SQLSTATE de 0066 a error HTTP (plan 026, «HTTP»)", () => {
  it.each([
    ["P0002", AccesoError, "no_encontrado", 404],
    ["55000", AccesoError, "cliente_archivado", 409],
    ["22023", AccesoError, "solicitud_invalida", 400],
    ["CA409", ProrrataError, "mes_cambiado", 409],
    ["CA412", ProrrataError, "mes_declarado", 409],
    ["CA413", ProrrataError, "prorrata_declarada", 409],
  ])("%s -> %s", (sqlstate, clase, codigo, estado) => {
    const r = aErrorHttp(new ProrrataRepoError(sqlstate)) as AccesoError | ProrrataError;
    expect(r).toBeInstanceOf(clase);
    expect(r.codigo).toBe(codigo);
    expect(r.getStatus()).toBe(estado);
    // El cuerpo es solo el código: ni SQLSTATE ni mensaje de BD.
    expect(r.getResponse()).toEqual({ codigo });
  });

  it("un SQLSTATE sin traducción (40P01, 42501, desconocido) pasa tal cual para el filtro global", () => {
    for (const s of ["40P01", "42501", "desconocido"]) {
      const original = new ProrrataRepoError(s);
      expect(aErrorHttp(original)).toBe(original);
    }
  });

  it("lo que no es ProrrataRepoError pasa tal cual", () => {
    const e = new Error("otro");
    expect(aErrorHttp(e)).toBe(e);
    expect(aErrorHttp("texto")).toBe("texto");
  });
});

describe("cuerpo ausente: 400 solicitud_invalida antes de abrir la transacción", () => {
  const withTenant = vi.fn();
  const escritura = new EscrituraProrrataService({ withTenant });
  const pedir = vi.fn();
  const obtencion = new ObtencionProrrataService({ encolarCon: pedir } as never);

  const comoSolicitudInvalida = async (f: () => Promise<unknown>): Promise<void> => {
    const e = await f().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).codigo).toBe("solicitud_invalida");
    expect((e as AccesoError).getStatus()).toBe(400);
  };

  it.each([[undefined], [null]])("guardarMes, eliminarMes y guardarUsada con cuerpo %s", async (cuerpo) => {
    await comoSolicitudInvalida(() => escritura.guardarMes(SESION, ALCANCE, CLIENTE, "202610", cuerpo));
    await comoSolicitudInvalida(() => escritura.eliminarMes(SESION, ALCANCE, CLIENTE, "202610", cuerpo));
    await comoSolicitudInvalida(() => escritura.guardarUsada(SESION, ALCANCE, CLIENTE, "202610", cuerpo));
    expect(withTenant).not.toHaveBeenCalled();
  });

  it.each([[undefined], [null]])("obtener con cuerpo %s no encola nada", async (cuerpo) => {
    await comoSolicitudInvalida(() => obtencion.obtener(SESION, ALCANCE, CLIENTE, cuerpo));
    expect(pedir).not.toHaveBeenCalled();
  });
});
