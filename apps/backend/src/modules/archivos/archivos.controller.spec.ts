// Spec 012b (T16a) · controladores de archivos sin BD ni HTTP: reparten la petición al servicio y fallan cerrado si el acceso
// resuelto por el guard no está. El contrato HTTP completo lo cubren los `*.int.spec.ts` de este módulo.
import "reflect-metadata";
import { StreamableFile } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PeticionAcceso } from "../acceso/guards/decoradores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ArchivosComprasController, ArchivosVentasController } from "./archivos.controller.js";

const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const ARCHIVO = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: "t", usuarioId: USUARIO } as SesionResuelta;
const acceso = { usuarioId: USUARIO, rol: "contador", permisos: new Set(["clientes.ver", "sire.aprobar_generar"]), alcance: "global" };
const conAcceso = { acceso } as unknown as PeticionAcceso;

/**
 * Una petición cuyo `acceso` está en la primera lectura (la de `alcanceDe`) y desaparece en la segunda (la de `permisosDe`): así se
 * ejercita la guarda propia de `permisosDe`, que con un `acceso` ausente desde el inicio nunca se alcanza porque `alcanceDe` falla antes.
 */
function conAccesoQueDesaparece(): PeticionAcceso {
  let lecturas = 0;
  return {
    get acceso() {
      lecturas += 1;
      return lecturas === 1 ? acceso : undefined;
    },
  } as unknown as PeticionAcceso;
}

function armar() {
  const servicio = {
    previo: vi.fn().mockResolvedValue("previo"),
    generar: vi.fn().mockResolvedValue({ trabajoId: "t1" }),
    versiones: vi.fn().mockResolvedValue(["v1"]),
    descargar: vi.fn().mockResolvedValue({ nombre: "CONTAPP-X.zip", bytes: new Uint8Array([1, 2, 3]) }),
  };
  return {
    servicio,
    compras: new ArchivosComprasController(servicio as never),
    ventas: new ArchivosVentasController(servicio as never),
  };
}

describe.each([
  ["compras", (a: ReturnType<typeof armar>) => a.compras],
  ["ventas", (a: ReturnType<typeof armar>) => a.ventas],
] as const)("controlador de archivos de %s", (libro, elegir) => {
  it("reparte previo, versiones y generar al servicio con el libro de la ruta y el alcance del acceso", async () => {
    const a = armar();
    const ctl = elegir(a);
    expect(await ctl.previo(sesion, conAcceso, CLIENTE, "202610")).toBe("previo");
    expect(a.servicio.previo).toHaveBeenCalledWith(sesion, { tipo: "global" }, CLIENTE, "202610", libro);
    expect(await ctl.versiones(sesion, conAcceso, CLIENTE, "202610")).toEqual(["v1"]);
    expect(a.servicio.versiones).toHaveBeenCalledWith(sesion, { tipo: "global" }, CLIENTE, "202610", libro);
    expect(await ctl.generar(sesion, conAcceso, CLIENTE, "202610", { registro: "x" })).toEqual({ trabajoId: "t1" });
    expect(a.servicio.generar).toHaveBeenCalledWith(sesion, { tipo: "global" }, acceso.permisos, CLIENTE, "202610", libro, { registro: "x" });
  });

  it("descargar entrega el ZIP como adjunto con su nombre y longitud", async () => {
    const a = armar();
    const r = await elegir(a).descargar(sesion, conAcceso, CLIENTE, "202610", ARCHIVO);
    expect(a.servicio.descargar).toHaveBeenCalledWith(sesion, { tipo: "global" }, CLIENTE, "202610", libro, ARCHIVO);
    expect(r).toBeInstanceOf(StreamableFile);
    expect(r.getHeaders()).toMatchObject({
      type: "application/zip",
      disposition: 'attachment; filename="CONTAPP-X.zip"',
      length: 3,
    });
  });

  it("sin acceso resuelto, ninguna ruta llega al servicio (falla cerrado con permiso_denegado)", () => {
    const a = armar();
    const ctl = elegir(a);
    const sinAcceso = {} as PeticionAcceso;
    expect(() => ctl.generar(sesion, sinAcceso, CLIENTE, "202610", {})).toThrowError(expect.objectContaining({ codigo: "permiso_denegado" }));
    expect(() => ctl.previo(sesion, sinAcceso, CLIENTE, "202610")).toThrowError(expect.objectContaining({ codigo: "permiso_denegado" }));
    expect(() => ctl.versiones(sesion, sinAcceso, CLIENTE, "202610")).toThrowError(expect.objectContaining({ codigo: "permiso_denegado" }));
    expect(a.servicio.generar).not.toHaveBeenCalled();
    expect(a.servicio.previo).not.toHaveBeenCalled();
    expect(a.servicio.versiones).not.toHaveBeenCalled();
  });

  it("generar no encola si el acceso desaparece antes de leer los permisos", () => {
    const a = armar();
    expect(() => elegir(a).generar(sesion, conAccesoQueDesaparece(), CLIENTE, "202610", {})).toThrowError(
      expect.objectContaining({ codigo: "permiso_denegado" }),
    );
    expect(a.servicio.generar).not.toHaveBeenCalled();
  });

  it("descargar sin acceso rechaza sin pedir el ZIP", async () => {
    const a = armar();
    await expect(elegir(a).descargar(sesion, {} as PeticionAcceso, CLIENTE, "202610", ARCHIVO)).rejects.toMatchObject({ codigo: "permiso_denegado" });
    expect(a.servicio.descargar).not.toHaveBeenCalled();
  });
});
