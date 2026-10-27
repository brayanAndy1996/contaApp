// Enumera las rutas registradas en Nest y las declaraciones de acceso de cada una (CA-11, plan 005:
// Decisiones). Fuera de `src/` para que no cuente en la cobertura. Usa `DiscoveryService` sobre el
// `ModulesContainer` de la app y el `Reflector`, sin tocar la BD.
import "reflect-metadata";
import { RequestMethod, type Type } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { DiscoveryService, ModulesContainer, Reflector } from "@nestjs/core";
import {
  META_PERMISO,
  META_SOLO_ESTUDIO,
} from "../src/modules/acceso/guards/decoradores.js";
import {
  META_PUBLICO,
  META_SESION_OPCIONAL,
  META_SIN_ESTUDIO,
} from "../src/modules/auth/guards/decoradores.js";

// Claves internas de @nestjs/common/constants (PATH_METADATA y METHOD_METADATA).
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

export interface RutaDeclarada {
  metodo: string;
  ruta: string;
  controlador: string;
  handler: string;
  /** Nombres de las declaraciones que aplican (handler sobre clase): Permiso, SoloEstudio, Publico... */
  declaraciones: string[];
  usaClienteId: boolean;
}

function segmentos(valor: unknown): string[] {
  if (Array.isArray(valor))
    return valor.length === 0 ? [""] : valor.map(String);
  return [typeof valor === "string" ? valor : ""];
}

const unir = (...partes: string[]): string =>
  "/" +
  partes
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");

/** Rutas (una por handler HTTP) de las clases de controlador dadas. */
export function rutasDe(
  controladores: readonly Type[],
  reflector: Reflector,
): RutaDeclarada[] {
  const salida: RutaDeclarada[] = [];
  for (const clase of controladores) {
    const base = segmentos(Reflect.getMetadata(PATH_METADATA, clase));
    const proto = clase.prototype as Record<string, unknown>;
    for (const nombre of Object.getOwnPropertyNames(proto)) {
      const fn = proto[nombre];
      if (typeof fn !== "function") continue;
      const metodo = Reflect.getMetadata(METHOD_METADATA, fn) as
        number | undefined;
      if (metodo === undefined) continue;
      const propias = segmentos(Reflect.getMetadata(PATH_METADATA, fn));
      const declaraciones: string[] = [];
      const objetivos = [fn, clase];
      const permiso = reflector.getAllAndOverride<unknown>(
        META_PERMISO,
        objetivos,
      );
      if (typeof permiso === "string") declaraciones.push("Permiso");
      for (const [clave, nombreDecl] of [
        [META_SOLO_ESTUDIO, "SoloEstudio"],
        [META_PUBLICO, "Publico"],
        [META_SIN_ESTUDIO, "SinEstudio"],
        [META_SESION_OPCIONAL, "SesionOpcional"],
      ] as const) {
        if (reflector.getAllAndOverride<unknown>(clave, objetivos) === true)
          declaraciones.push(nombreDecl);
      }
      for (const b of base) {
        for (const p of propias) {
          const ruta = unir(b, p);
          salida.push({
            metodo: RequestMethod[metodo] ?? String(metodo),
            ruta,
            controlador: clase.name,
            handler: nombre,
            declaraciones,
            usaClienteId: /:clienteId(\/|$)/.test(ruta),
          });
        }
      }
    }
  }
  return salida;
}

/** Todas las rutas de los controladores registrados en la app. */
export function rutasRegistradas(app: INestApplication): RutaDeclarada[] {
  const descubrimiento = new DiscoveryService(app.get(ModulesContainer));
  const clases = descubrimiento
    .getControllers()
    .map((w) => w.metatype)
    .filter((m): m is Type => typeof m === "function");
  return rutasDe(clases, app.get(Reflector));
}

/**
 * CA-11: cada ruta declara exactamente UNA familia de acceso: `@Permiso`, `@SoloEstudio` o las marcas
 * de 004 (`@Publico`, `@SinEstudio`, `@SesionOpcional`). Las marcas de 004 se pueden combinar entre
 * si (login: `@Publico` + `@SinEstudio`; logout: `@SinEstudio` + `@SesionOpcional`), por lo que
 * cuentan como una sola familia. Toda ruta con `:clienteId` exige `@Permiso`.
 */
export function infracciones(rutas: readonly RutaDeclarada[]): string[] {
  const salida: string[] = [];
  for (const r of rutas) {
    const id = `${r.metodo} ${r.ruta} (${r.controlador}.${r.handler})`;
    const de004 = r.declaraciones.filter(
      (d) => d === "Publico" || d === "SinEstudio" || d === "SesionOpcional",
    );
    const familias =
      (r.declaraciones.includes("Permiso") ? 1 : 0) +
      (r.declaraciones.includes("SoloEstudio") ? 1 : 0) +
      (de004.length > 0 ? 1 : 0);
    if (familias !== 1) {
      salida.push(
        `${id}: ${familias} familias de declaracion [${r.declaraciones.join(",")}]`,
      );
    }
    if (r.usaClienteId && !r.declaraciones.includes("Permiso")) {
      salida.push(`${id}: usa :clienteId sin @Permiso`);
    }
  }
  return salida;
}
