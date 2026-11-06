// Selección de adaptadores por entorno (spec 009, D8/D15). Cada puerto de `@contapp/sunat` se crea según su variable
// (`SIRE_CLIENT`, `SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER`; ausente = `mock`). Hoy solo existe `mock`: cualquier otro
// valor es un error de arranque que nombra la variable y nunca imprime valores. Con `NODE_ENV=production` y algún
// adaptador en `mock`, el arranque falla salvo `PERMITIR_ADAPTADORES_MOCK=1` (entonces avisa con un `warn`).
import { Global, Logger, Module } from "@nestjs/common";
import {
  MockConsultaRuc,
  MockSireApiClient,
  MockSireAuth,
  MockSolAuth,
  MockXmlProvider,
  type ConsultaRuc,
  type SireApiClient,
  type SireAuth,
  type SolAuth,
  type XmlProvider,
} from "@contapp/sunat";

type Entorno = Record<string, string | undefined>;

/** Error de configuración del worker (008); `trabajos.module.ts` lo reexporta con el mismo nombre. */
export class ConfiguracionTrabajosError extends Error {
  readonly codigo = "configuracion_trabajos";
}

/** Configuración de adaptadores inválida (variable con valor no soportado o guarda de producción). Sin valores. */
export class ConfiguracionAdaptadoresError extends ConfiguracionTrabajosError {
  readonly variable?: string;
  constructor(mensaje: string, variable?: string) {
    super(mensaje);
    this.name = "ConfiguracionAdaptadoresError";
    this.variable = variable;
  }
}

/** Variables que eligen adaptador, en el orden en que se informan. */
export const VARIABLES_ADAPTADOR = [
  "SIRE_CLIENT",
  "SOL_PORTAL",
  "RUC_CLIENT",
  "XML_PROVIDER",
] as const;
type VariableAdaptador = (typeof VARIABLES_ADAPTADOR)[number];

/** Tokens de inyección de Nest de los 5 puertos (`SireAuth` y `SireApiClient` comparten `SIRE_CLIENT`). */
export const SIRE_AUTH = "SIRE_AUTH";
export const SIRE_API_CLIENT = "SIRE_API_CLIENT";
export const SOL_AUTH = "SOL_AUTH";
export const CONSULTA_RUC = "CONSULTA_RUC";
export const XML_PROVIDER = "XML_PROVIDER";
/** Token del conjunto ya creado (y validado) de los 5 puertos. */
export const ADAPTADORES = "ADAPTADORES";

export interface Adaptadores {
  sireAuth: SireAuth;
  sireApiClient: SireApiClient;
  solAuth: SolAuth;
  consultaRuc: ConsultaRuc;
  xmlProvider: XmlProvider;
}

/** Lo mínimo del log que usa la guarda (el `Logger` de Nest lo cumple). */
export interface LoggerAdaptadores {
  warn(mensaje: string): void;
}

function soloMock(env: Entorno, variable: VariableAdaptador): void {
  if ((env[variable] ?? "mock") !== "mock")
    throw new ConfiguracionAdaptadoresError(`${variable} no soportado`, variable);
}

/** Solo existe el adaptador `mock` hasta 009 (SIRE_CLIENT=mock, 001 CA-8). */
export function sireAuthDesdeEntorno(env: Entorno): SireAuth {
  soloMock(env, "SIRE_CLIENT");
  return new MockSireAuth();
}

/** Solo existe el adaptador `mock` (RUC_CLIENT=mock, 007b). */
export function consultaRucDesdeEntorno(env: Entorno): ConsultaRuc {
  soloMock(env, "RUC_CLIENT");
  return new MockConsultaRuc();
}

/** Solo existe el adaptador `mock` (SOL_PORTAL=mock, 007b). */
export function solAuthDesdeEntorno(env: Entorno): SolAuth {
  soloMock(env, "SOL_PORTAL");
  return new MockSolAuth();
}

/** Cliente de la API del SIRE; comparte `SIRE_CLIENT` con `SireAuth`. Solo `mock`. */
export function sireApiClientDesdeEntorno(env: Entorno): SireApiClient {
  soloMock(env, "SIRE_CLIENT");
  return new MockSireApiClient();
}

/** `XML_PROVIDER=mock` con `XML_FIXTURES_DIR` y `XML_MOCK_LATENCIA_MS` opcionales (D5, D6). Solo `mock`. */
export function xmlProviderDesdeEntorno(env: Entorno): XmlProvider {
  soloMock(env, "XML_PROVIDER");
  const dirFixtures = env.XML_FIXTURES_DIR?.trim();
  const crudaLatencia = env.XML_MOCK_LATENCIA_MS?.trim();
  let latenciaMs: number | undefined;
  if (crudaLatencia !== undefined && crudaLatencia !== "") {
    if (!/^\d{1,7}$/.test(crudaLatencia))
      throw new ConfiguracionAdaptadoresError(
        "XML_MOCK_LATENCIA_MS inválido: se espera un entero de milisegundos",
        "XML_MOCK_LATENCIA_MS",
      );
    latenciaMs = Number(crudaLatencia);
  }
  return new MockXmlProvider({
    ...(dirFixtures ? { dirFixtures } : {}),
    ...(latenciaMs !== undefined ? { latenciaMs } : {}),
  });
}

/** Variables de adaptador que hoy resuelven a `mock` (ausente cuenta como `mock`). */
export function variablesEnMock(env: Entorno): VariableAdaptador[] {
  return VARIABLES_ADAPTADOR.filter((v) => (env[v] ?? "mock") === "mock");
}

/**
 * Guarda de producción (D15): con `NODE_ENV=production` y algún adaptador en `mock`, falla nombrando las variables;
 * con `PERMITIR_ADAPTADORES_MOCK=1` solo avisa. Fuera de producción no hace nada.
 */
export function verificarGuardaProduccion(
  env: Entorno,
  logger: LoggerAdaptadores,
): void {
  if (env.NODE_ENV !== "production") return;
  const enMock = variablesEnMock(env);
  if (enMock.length === 0) return;
  if (env.PERMITIR_ADAPTADORES_MOCK === "1") {
    logger.warn(
      `Adaptadores en mock en producción (PERMITIR_ADAPTADORES_MOCK=1): ${enMock.join(", ")}`,
    );
    return;
  }
  throw new ConfiguracionAdaptadoresError(
    `Adaptadores en mock con NODE_ENV=production: ${enMock.join(", ")}. ` +
      "Configura adaptadores reales o fija PERMITIR_ADAPTADORES_MOCK=1.",
  );
}

/** Crea los 5 puertos del entorno. Primero valida cada variable y luego aplica la guarda de producción. */
export function crearAdaptadores(
  env: Entorno,
  logger: LoggerAdaptadores = new Logger("Adaptadores"),
): Adaptadores {
  const adaptadores: Adaptadores = {
    sireAuth: sireAuthDesdeEntorno(env),
    sireApiClient: sireApiClientDesdeEntorno(env),
    solAuth: solAuthDesdeEntorno(env),
    consultaRuc: consultaRucDesdeEntorno(env),
    xmlProvider: xmlProviderDesdeEntorno(env),
  };
  verificarGuardaProduccion(env, logger);
  return adaptadores;
}

/** Exporta los 5 puertos por token (D9: hoy solo los consume `TrabajosService`). Falla el arranque si el entorno es inválido. */
@Global()
@Module({
  providers: [
    { provide: ADAPTADORES, useFactory: () => crearAdaptadores(process.env) },
    {
      provide: SIRE_AUTH,
      useFactory: (a: Adaptadores) => a.sireAuth,
      inject: [ADAPTADORES],
    },
    {
      provide: SIRE_API_CLIENT,
      useFactory: (a: Adaptadores) => a.sireApiClient,
      inject: [ADAPTADORES],
    },
    {
      provide: SOL_AUTH,
      useFactory: (a: Adaptadores) => a.solAuth,
      inject: [ADAPTADORES],
    },
    {
      provide: CONSULTA_RUC,
      useFactory: (a: Adaptadores) => a.consultaRuc,
      inject: [ADAPTADORES],
    },
    {
      provide: XML_PROVIDER,
      useFactory: (a: Adaptadores) => a.xmlProvider,
      inject: [ADAPTADORES],
    },
  ],
  exports: [
    ADAPTADORES,
    SIRE_AUTH,
    SIRE_API_CLIENT,
    SOL_AUTH,
    CONSULTA_RUC,
    XML_PROVIDER,
  ],
})
export class AdaptadoresModule {}
