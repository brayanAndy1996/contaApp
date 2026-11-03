import "reflect-metadata";
import { Controller, Get, Post, type INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearApp } from "../../app.js";
import {
  infracciones,
  rutasDe,
  rutasRegistradas,
} from "../../../test/auditoria-rutas.js";
import { Publico, SinEstudio } from "../auth/guards/decoradores.js";
import {
  Permiso,
  SoloEstudio,
  SoloPlataforma,
} from "../acceso/guards/decoradores.js";

// T2 de 006 (rojo), CA-11 de 005 extendido: las rutas nuevas aparecen en la auditoria con su declaracion
// (plan: Contratos HTTP) y `@SoloPlataforma` solo es valida junto a `@SinEstudio`. Se levanta `crearApp`
// sin BD, como rutas.spec.ts de acceso.
const ENV = {
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://usuario@127.0.0.1:1/inexistente",
  CORREO_PROVIDER: "consola",
};

const PLATAFORMA: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/plataforma/yo"],
  ["GET", "/plataforma/planes"],
  ["POST", "/plataforma/planes"],
  ["PUT", "/plataforma/planes/:planId"],
  ["GET", "/plataforma/estudios"],
  ["PUT", "/plataforma/estudios/:tenantId/suscripcion"],
];

describe("rutas de 006 registradas en la app (CA-11 de 005)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await crearApp({ env: ENV });
  });
  afterAll(async () => {
    await app?.close();
  });

  const buscar = (metodo: string, ruta: string) =>
    rutasRegistradas(app).find((r) => r.metodo === metodo && r.ruta === ruta);

  it.each([
    ["POST", "/registro", ["Publico"]],
    ["POST", "/registro/consultar", ["Publico"]],
    ["POST", "/registro/confirmar", ["Publico"]],
    ["POST", "/registro/confirmar-con-sesion", ["SinEstudio"]],
    ["GET", "/plan/uso", ["SoloEstudio"]],
  ] as const)("%s %s declara %j", (metodo, ruta, esperadas) => {
    const r = buscar(metodo, ruta);
    expect(r, `${metodo} ${ruta} no esta registrada`).toBeDefined();
    expect([...(r?.declaraciones ?? [])].sort()).toEqual([...esperadas].sort());
    expect(r?.usaClienteId).toBe(false);
  });

  it.each(PLATAFORMA)(
    "%s %s declara exactamente @SinEstudio + @SoloPlataforma",
    (metodo, ruta) => {
      const r = buscar(metodo, ruta);
      expect(r, `${metodo} ${ruta} no esta registrada`).toBeDefined();
      expect([...(r?.declaraciones ?? [])].sort()).toEqual([
        "SinEstudio",
        "SoloPlataforma",
      ]);
      expect(r?.usaClienteId).toBe(false);
    },
  );

  it("toda ruta bajo /plataforma declara @SoloPlataforma (no se puede agregar una abierta)", () => {
    const bajo = rutasRegistradas(app).filter(
      (r) => r.ruta === "/plataforma" || r.ruta.startsWith("/plataforma/"),
    );
    expect(bajo.length).toBeGreaterThanOrEqual(PLATAFORMA.length);
    for (const r of bajo) {
      expect(r.declaraciones, `${r.metodo} ${r.ruta}`).toContain(
        "SoloPlataforma",
      );
    }
  });

  it("ninguna ruta fuera de /plataforma usa @SoloPlataforma", () => {
    const fuera = rutasRegistradas(app).filter(
      (r) =>
        r.declaraciones.includes("SoloPlataforma") &&
        !r.ruta.startsWith("/plataforma/"),
    );
    expect(fuera.map((r) => `${r.metodo} ${r.ruta}`)).toEqual([]);
  });

  it("con las rutas nuevas, toda ruta de la app sigue declarando exactamente una familia valida", () => {
    expect(infracciones(rutasRegistradas(app))).toEqual([]);
  });
});

describe("la auditoria detecta @SoloPlataforma mal combinada (006, D5)", () => {
  const reflector = new Reflector();

  it("@SinEstudio + @SoloPlataforma no produce infracciones", () => {
    @Controller("plataforma")
    class Bien {
      @SinEstudio()
      @SoloPlataforma()
      @Get("yo")
      yo(): string {
        return "";
      }
    }
    const rutas = rutasDe([Bien], reflector);
    expect(rutas[0]?.declaraciones.sort()).toEqual([
      "SinEstudio",
      "SoloPlataforma",
    ]);
    expect(infracciones(rutas)).toEqual([]);
  });

  it("@SoloPlataforma sola es una infraccion", () => {
    @Controller("plataforma")
    class Sola {
      @SoloPlataforma()
      @Get("sola")
      sola(): string {
        return "";
      }
    }
    const fallos = infracciones(rutasDe([Sola], reflector));
    expect(fallos.some((f) => f.includes("GET /plataforma/sola"))).toBe(true);
  });

  it("@SoloPlataforma con @Permiso, con @SoloEstudio o con @Publico es una infraccion", () => {
    @Controller("plataforma")
    class Mal {
      @SinEstudio()
      @SoloPlataforma()
      @Permiso("plan.gestionar")
      @Get("con-permiso")
      conPermiso(): string {
        return "";
      }

      @SinEstudio()
      @SoloPlataforma()
      @SoloEstudio()
      @Get("con-estudio")
      conEstudio(): string {
        return "";
      }

      @Publico()
      @SinEstudio()
      @SoloPlataforma()
      @Post("publica")
      publica(): string {
        return "";
      }
    }
    const fallos = infracciones(rutasDe([Mal], reflector));
    for (const ruta of ["con-permiso", "con-estudio", "publica"]) {
      expect(
        fallos.some((f) => f.includes(`/plataforma/${ruta}`)),
        ruta,
      ).toBe(true);
    }
  });
});
