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
import {
  Publico,
  SesionOpcional,
  SinEstudio,
} from "../auth/guards/decoradores.js";
import { Permiso, SoloEstudio } from "./guards/decoradores.js";

// CA-11 (denegacion por defecto, D4): se levanta `crearApp` sin BD (el pool no conecta hasta la
// primera consulta, como en app.spec.ts), se enumeran las rutas con DiscoveryService + Reflector
// (test/auditoria-rutas.ts) y se exige exactamente una declaracion por ruta.
const ENV = {
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://usuario@127.0.0.1:1/inexistente",
  CORREO_PROVIDER: "consola",
};

describe("rutas registradas en la app (CA-11)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await crearApp({ env: ENV });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("la comprobacion no es vacia: ya hay rutas de 004 registradas", () => {
    const rutas = rutasRegistradas(app);
    expect(rutas.length).toBeGreaterThanOrEqual(10);
    expect(rutas.map((r) => `${r.metodo} ${r.ruta}`)).toContain(
      "POST /auth/login",
    );
    expect(rutas.map((r) => `${r.metodo} ${r.ruta}`)).toContain(
      "GET /estudio/actual",
    );
  });

  it("toda ruta declara exactamente una familia: @Permiso, @SoloEstudio o las marcas de 004 (@Publico, @SinEstudio, @SesionOpcional)", () => {
    expect(infracciones(rutasRegistradas(app))).toEqual([]);
  });

  it("GET /estudio/actual pasa a @SoloEstudio (sesion + estudio, sin permiso)", () => {
    const ruta = rutasRegistradas(app).find(
      (r) => r.metodo === "GET" && r.ruta === "/estudio/actual",
    );
    expect(ruta?.declaraciones).toEqual(["SoloEstudio"]);
  });

  // 008 (T6): las tres rutas de trabajos declaran @SoloEstudio (la lista y el stream filtran por alcance en el
  // servicio; cancelar decide 404/403 con el rol y el creador). El ID de la ruta es `:trabajoId`, no `:clienteId`.
  // `crearApp({ env: ENV })` no trae REDIS_URL ni hay Redis alcanzable: el módulo de trabajos no debe conectar al
  // arrancar (conexión perezosa) y `app.close()` debe terminar (si no, esta suite entera se cuelga).
  it("las rutas de 008 están registradas y declaran @SoloEstudio: GET /trabajos, GET /trabajos/stream y POST /trabajos/:trabajoId/cancelar", () => {
    const rutas = rutasRegistradas(app);
    for (const [metodo, ruta] of [
      ["GET", "/trabajos"],
      ["GET", "/trabajos/stream"],
      ["POST", "/trabajos/:trabajoId/cancelar"],
    ] as const) {
      const r = rutas.find((x) => x.metodo === metodo && x.ruta === ruta);
      expect(r, `${metodo} ${ruta} no está registrada`).toBeDefined();
      expect(r?.declaraciones, `${metodo} ${ruta}`).toEqual(["SoloEstudio"]);
      expect(r?.usaClienteId).toBe(false);
    }
  });

  it("toda ruta con :clienteId declara @Permiso (para que el 403 llegue antes que el 404)", () => {
    const conCliente = rutasRegistradas(app).filter((r) => r.usaClienteId);
    for (const r of conCliente)
      expect(r.declaraciones, `${r.metodo} ${r.ruta}`).toEqual(["Permiso"]);
  });

  it("PermisoGuard y ClienteScopeGuard se registran despues de CsrfGuard, en orden", () => {
    const config = (
      app as unknown as { config?: { getGlobalGuards?: () => object[] } }
    ).config;
    const nombres = (config?.getGlobalGuards?.() ?? []).map(
      (g) => g.constructor.name,
    );
    expect(nombres).toEqual([
      "OrigenGuard",
      "SesionGuard",
      "EstudioGuard",
      "CsrfGuard",
      "PermisoGuard",
      "ClienteScopeGuard",
    ]);
  });
});

describe("la comprobacion de rutas detecta lo que no declara (CA-11: agregar una ruta sin declarar rompe la prueba)", () => {
  const reflector = new Reflector();

  @Controller("sin-declarar")
  class ControladorSinDeclarar {
    @Get()
    listar(): string {
      return "";
    }
  }

  @Controller("clientes")
  class ControladorMalDeclarado {
    @SoloEstudio()
    @Get(":clienteId")
    leer(): string {
      return "";
    }

    @Permiso("clientes.ver")
    @SoloEstudio()
    @Get("doble")
    doble(): string {
      return "";
    }

    @Permiso("clientes.ver")
    @Publico()
    @Get("mezcla")
    mezcla(): string {
      return "";
    }
  }

  @Controller("bien")
  class ControladorBien {
    @Permiso("clientes.ver")
    @Get(":clienteId")
    leer(): string {
      return "";
    }

    @Permiso("clientes.asignar")
    @Post(":clienteId/asignaciones")
    asignar(): string {
      return "";
    }

    @SoloEstudio()
    @Get("yo")
    yo(): string {
      return "";
    }

    @Publico()
    @Post("publica")
    publica(): string {
      return "";
    }

    @SinEstudio()
    @Get("sin-estudio")
    sinEstudio(): string {
      return "";
    }

    @SesionOpcional()
    @Post("opcional")
    opcional(): string {
      return "";
    }

    // Idioma de 004: varias marcas de 004 juntas cuentan como una sola declaracion.
    @Publico()
    @SinEstudio()
    @Post("login")
    login(): string {
      return "";
    }
  }

  it("una ruta sin ninguna declaracion es una infraccion", () => {
    const fallos = infracciones(rutasDe([ControladorSinDeclarar], reflector));
    expect(fallos).toHaveLength(1);
    expect(fallos[0]).toContain("GET /sin-declarar");
  });

  it("una ruta con :clienteId sin @Permiso y una con dos declaraciones son infracciones", () => {
    const fallos = infracciones(rutasDe([ControladorMalDeclarado], reflector));
    expect(
      fallos.some(
        (f) => f.includes("/clientes/:clienteId") && f.includes("sin @Permiso"),
      ),
    ).toBe(true);
    expect(
      fallos.some(
        (f) => f.includes("/clientes/doble") && f.includes("2 familias"),
      ),
    ).toBe(true);
    expect(
      fallos.some(
        (f) => f.includes("/clientes/mezcla") && f.includes("2 familias"),
      ),
    ).toBe(true);
  });

  it("las rutas bien declaradas no producen infracciones", () => {
    expect(infracciones(rutasDe([ControladorBien], reflector))).toEqual([]);
  });
});
