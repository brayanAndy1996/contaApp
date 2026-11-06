import {
  clasificarError,
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
} from "../errores.js";
import type { ClaseError } from "../errores.js";
import type { RespuestaXml, SolicitudXml, XmlProvider } from "../puertos.js";
import {
  claveDeComprobante,
  dirFixturesXmlPorDefecto,
  leerFixtureXml,
  partesDeClave,
} from "./ruta-fixture.js";
import { generarUblSintetico } from "./ubl-sintetico.js";

export type ModoFallaXml = "no_encontrado" | "timeout" | "credencial" | null;

/** Caso forzado con `inyectar`: un XML (`fuente: "inyectado"`) o un error que se lanza tal cual. */
export type CasoXmlInyectado = { xml: string } | { error: Error };

export interface OpcionesMockXmlProvider {
  /** Carpeta de fixtures XML. Por defecto `fixtures/xml` del repo, resuelta desde este archivo. */
  dirFixtures?: string;
  /** Latencia simulada por llamada, en ms (`XML_MOCK_LATENCIA_MS`; 0 por defecto). */
  latenciaMs?: number;
}

/** Una llamada registrada. Nunca incluye credenciales, contenido de XML ni la entrada cruda inválida. */
export interface EntradaRegistroXml {
  /** `{ruc}-{tipo}-{serie}-{numero}`, o `null` si la solicitud no cumplió la gramática. */
  clave: string | null;
  resultado: "ok" | "error";
  fuente?: RespuestaXml["fuente"];
  clase?: ClaseError;
}

/**
 * Adaptador en memoria de `XmlProvider` (`XML_PROVIDER=mock`). Orden de `obtener` (plan 009):
 * gramática (D6) -> latencia -> `fallar` -> inyectado -> centinela por último dígito del número
 * -> fixture -> UBL sintético con `referencia` -> `ErrorDatos`.
 *
 * Centinelas (último dígito del número): `7` -> `ErrorTransitorio`, `8` -> `ErrorDatos`,
 * `9` -> `ErrorCredencial`. El resultado siempre es `origen: "simulado"`, también con fixture.
 */
export class MockXmlProvider implements XmlProvider {
  private readonly dirFixtures: string;
  private readonly latenciaMs: number;
  private readonly inyectados = new Map<string, CasoXmlInyectado>();
  private readonly entradas: EntradaRegistroXml[] = [];
  private modo: ModoFallaXml = null;
  private restantes: number | null = null;

  constructor(opciones: OpcionesMockXmlProvider = {}) {
    this.dirFixtures = opciones.dirFixtures ?? dirFixturesXmlPorDefecto();
    const latencia = opciones.latenciaMs ?? 0;
    this.latenciaMs =
      Number.isFinite(latencia) && latencia > 0 ? Math.floor(latencia) : 0;
  }

  /** Fuerza un XML o un error para un comprobante (`{ruc}-{tipo}-{serie}-{numero}`). Clave inválida -> `ErrorDatos`. */
  inyectar(clave: string, caso: CasoXmlInyectado): void {
    partesDeClave(clave);
    this.inyectados.set(clave, caso);
  }

  /** Fuerza el fallo de todas las llamadas (o de las siguientes `veces`). `null` lo apaga. */
  fallar(modo: ModoFallaXml, opciones: { veces?: number } = {}): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  /** Llamadas hechas, sin credenciales ni contenido. */
  registro(): readonly EntradaRegistroXml[] {
    return this.entradas.map((e) => ({ ...e }));
  }

  async obtener(solicitud: SolicitudXml): Promise<RespuestaXml> {
    let clave: string | null = null;
    try {
      clave = claveDeComprobante(solicitud);
      const respuesta = await this.resolver(solicitud, clave);
      this.entradas.push({
        clave,
        resultado: "ok",
        fuente: respuesta.fuente,
      });
      return respuesta;
    } catch (e) {
      this.entradas.push({
        clave,
        resultado: "error",
        clase: clasificarError(e).clase,
      });
      throw e;
    }
  }

  private async resolver(
    s: SolicitudXml,
    clave: string,
  ): Promise<RespuestaXml> {
    if (this.latenciaMs > 0) await dormir(this.latenciaMs);

    const falla = this.consumirFalla();
    if (falla === "timeout") throw new ErrorTransitorio();
    if (falla === "credencial") throw new ErrorCredencial();
    if (falla === "no_encontrado") throw new ErrorDatos();

    const inyectado = this.inyectados.get(clave);
    if (inyectado !== undefined) {
      if ("error" in inyectado) throw inyectado.error;
      return { xml: inyectado.xml, origen: "simulado", fuente: "inyectado" };
    }

    const ultimo = s.numero.slice(-1);
    if (ultimo === "7") throw new ErrorTransitorio();
    if (ultimo === "8") throw new ErrorDatos();
    if (ultimo === "9") throw new ErrorCredencial();

    const fixture = await leerFixtureXml(this.dirFixtures, clave);
    if (fixture !== null) {
      return { xml: fixture, origen: "simulado", fuente: "fixture" };
    }

    if (s.referencia === undefined) throw new ErrorDatos();
    try {
      const xml = generarUblSintetico(s, s.referencia);
      return { xml, origen: "simulado", fuente: "sintetico" };
    } catch {
      // Referencia fuera de contrato (monto, moneda o fecha inválidos): sin eco del valor.
      throw new ErrorDatos();
    }
  }

  private consumirFalla(): ModoFallaXml {
    const modo = this.modo;
    if (modo === null) return null;
    if (this.restantes !== null) {
      this.restantes -= 1;
      if (this.restantes <= 0) {
        this.modo = null;
        this.restantes = null;
      }
    }
    return modo;
  }
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}
