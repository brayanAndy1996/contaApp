import { HttpException, HttpStatus } from "@nestjs/common";
import type { CampoXmlAjeno, ErrorXml } from "@contapp/shared";

/** Códigos de las rutas con XML (spec 016, plan «Contratos: HTTP»): forma de `errorXmlSchema` de `@contapp/shared`. */
export type CodigoXml = ErrorXml["codigo"];

const ESTADO: Record<CodigoXml, number> = {
  xml_invalido: HttpStatus.UNPROCESSABLE_ENTITY,
  xml_incompleto: HttpStatus.UNPROCESSABLE_ENTITY,
  xml_ajeno: HttpStatus.UNPROCESSABLE_ENTITY,
  // P-6: ya hay un XML que no se reemplaza (real o subido).
  xml_existente: HttpStatus.CONFLICT,
};

/**
 * Error de las rutas con XML: cuerpo `{ codigo }` (más `campos` en `xml_ajeno`, los nombres de los campos que difieren) y nunca
 * el contenido del XML ni un mensaje con datos (D-11). El filtro global responde `cuerpo` tal cual.
 */
export class XmlError extends HttpException {
  readonly codigo: CodigoXml;
  readonly cuerpo: ErrorXml;

  constructor(codigo: Exclude<CodigoXml, "xml_ajeno">);
  constructor(codigo: "xml_ajeno", campos: readonly CampoXmlAjeno[]);
  constructor(codigo: CodigoXml, campos?: readonly CampoXmlAjeno[]) {
    const cuerpo = (codigo === "xml_ajeno" ? { codigo, campos: [...(campos ?? [])] } : { codigo }) as ErrorXml;
    super(cuerpo, ESTADO[codigo]);
    this.name = "XmlError";
    this.codigo = codigo;
    this.cuerpo = cuerpo;
  }
}
