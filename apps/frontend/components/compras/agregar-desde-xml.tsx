"use client";

import {
  DESTINOS_COMPRA,
  destinoDesdeXmlSchema,
  type DestinoCompra,
  type FilaCompraVista,
  type VistaPreviaDesdeXml,
} from "@contapp/shared";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  agregarDesdeXml,
  etiquetaTipo,
  mensajeDeErrorXml,
} from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";
import { cn } from "../../lib/utils";
import type { AlAvisar } from "./accion-compras";
import { ItemsXml } from "./items-xml";
import {
  Alert,
  AlertDescription,
  Button,
  enlace,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  panelDialogo,
} from "../ui";

// «Agregar desde XML» (spec 016, T16; HU-18, CA-13, D-8, P-9). Con la vista previa ya leída por el servidor
// (`vistaPreviaDesdeXmlSchema`) se muestran los campos prellenados (solo lectura: salen del XML) y se pide SOLO el
// destino de la base imponible y el IGV; en USD, además el tipo de cambio (el XML no lo trae). El envío manda el
// mismo archivo como cuerpo crudo con el destino en la query; el servidor lo vuelve a leer y valida. Nada se calcula
// aquí: los montos se muestran con formato. 409 `duplicado` (o `existente` en la vista previa) ofrece ubicar la compra.

const COLUMNAS = [
  ["biDg", L.desdeXml.base],
  ["igvDg", "IGV"],
  ["noGravado", M.casilleros.noGravado],
  ["isc", M.casilleros.isc],
  ["icbper", M.casilleros.icbper],
  ["otrosTributos", M.casilleros.otrosTributos],
] as const;

export function AgregarDesdeXml({
  contexto,
  archivo,
  vista,
  alAgregar,
  alQuitar,
  alCancelar,
  alUbicarExistente,
  alAvisar,
}: {
  contexto: ContextoCompras;
  archivo: File;
  vista: VistaPreviaDesdeXml;
  alAgregar: (fila: FilaCompraVista) => void;
  /** Descarta el XML y vuelve al formulario manual. */
  alQuitar: () => void;
  alCancelar: () => void;
  alUbicarExistente: (compraId: string) => void;
  alAvisar?: AlAvisar;
}) {
  const [destino, setDestino] = useState<DestinoCompra | "">("");
  const [tipoCambio, setTipoCambio] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicada, setDuplicada] = useState<string | null>(vista.existente?.id ?? null);
  const [ocupado, setOcupado] = useState(false);
  const primero = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    primero.current?.focus();
  }, []);

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado || duplicada !== null) return;
    if (destino === "") {
      setError(L.desdeXml.destinoObligatorio);
      return;
    }
    const cambio = tipoCambio.trim();
    if (vista.requiereTipoCambio && cambio === "") {
      setError(M.tipoCambioObligatorio);
      return;
    }
    const analisis = destinoDesdeXmlSchema.safeParse({
      destino,
      ...(vista.requiereTipoCambio ? { tipoCambio: cambio } : {}),
    });
    if (!analisis.success || (vista.requiereTipoCambio && !/[1-9]/.test(cambio))) {
      setError(L.desdeXml.tipoCambioInvalido);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await agregarDesdeXml(
        contexto.clienteId,
        contexto.periodo,
        archivo,
        analisis.data.destino,
        analisis.data.tipoCambio,
      );
      if (r.ok) {
        await Promise.all([contexto.recargarFila(r.datos.id), contexto.recargarResumen()]);
        alAvisar?.(L.desdeXml.agregada, "ok");
        alAgregar(r.datos);
        return;
      }
      if (r.codigo === "duplicado" && r.id !== undefined) {
        setDuplicada(r.id);
        setError(M.yaExisteEnPropuesta);
      } else {
        setError(mensajeDeErrorXml(r, "cliente"));
      }
      alAvisar?.(r.codigo === "duplicado" ? M.yaExisteEnPropuesta : mensajeDeErrorXml(r, "cliente"), "error");
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
    }
    setOcupado(false);
  }

  const dato = (nombre: string, valor: string) => (
    <div className="flex flex-col">
      <dt className="text-xs font-semibold text-tinta-suave">{nombre}</dt>
      <dd className="break-words text-sm text-tinta">{valor}</dd>
    </div>
  );

  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={L.desdeXml.titulo}
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className={cn(panelDialogo, "max-w-4xl gap-3")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-titulo text-lg font-semibold text-tinta">{L.desdeXml.titulo}</h3>
        <Button variant="secundario" size="sm" onClick={alQuitar} disabled={ocupado} className="max-lg:h-11">
          {L.desdeXml.volver}
        </Button>
      </div>

      <section aria-label={L.desdeXml.resumen} className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-tinta">{L.desdeXml.resumen}</h4>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {dato(M.campos.tipo, etiquetaTipo(vista.tipo))}
          {dato(L.secciones.cabecera, `${vista.serie}-${vista.numero}`)}
          {dato(M.campos.fecha, vista.fecha)}
          {dato(M.campos.moneda, vista.moneda)}
          {dato(L.desdeXml.proveedor, `${vista.proveedor.numero} · ${vista.proveedor.razonSocial}`)}
        </dl>
        <Table aria-label={L.desdeXml.montos}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNAS.map(([clave, nombre]) => (
                <TableHead key={clave} scope="col" className="text-right">
                  {nombre}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              {COLUMNAS.map(([clave]) => (
                <TableCell key={clave} numerico className="py-2">
                  {conMiles(vista.montos[clave] ?? "0.00")}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </section>

      <ItemsXml items={vista.items} hayXml />

      <div className="flex flex-wrap items-start gap-3">
        <Label>
          {L.desdeXml.destino}
          <Select
            ref={primero}
            value={destino}
            onChange={(e) => {
              setDestino(e.target.value as DestinoCompra | "");
              setError(null);
            }}
            className="min-w-48 max-lg:h-11"
          >
            <option value="">{L.desdeXml.elegirDestino}</option>
            {DESTINOS_COMPRA.map((d) => (
              <option key={d} value={d}>
                {M.destinos[d]}
              </option>
            ))}
          </Select>
        </Label>
        {vista.requiereTipoCambio && (
          <div className="flex flex-col gap-1.5">
            <Label>
              {L.desdeXml.tipoCambio}
              <Input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={tipoCambio}
                onChange={(e) => {
                  setTipoCambio(e.target.value);
                  setError(null);
                }}
                aria-describedby="desde-xml-tipo-cambio"
                className={cn("w-32 max-lg:h-11", "cifras")}
              />
            </Label>
            <span id="desde-xml-tipo-cambio" className="text-xs text-tinta-suave">
              {L.desdeXml.tipoCambioAyuda}
            </span>
          </div>
        )}
      </div>
      <p className="text-xs text-tinta-suave">{M.destinoAyuda}</p>

      {duplicada !== null && (
        <p role="note" className="text-sm text-tinta-media">
          {L.desdeXml.yaExiste}{" "}
          <button
            type="button"
            onClick={() => alUbicarExistente(duplicada)}
            className={cn(enlace, "min-h-6 font-semibold max-lg:min-h-11")}
          >
            {M.ubicarExistente}
          </button>
        </p>
      )}
      {error && (
        <Alert tono="error">
          <CircleAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={ocupado || duplicada !== null} className="max-lg:h-11">
          {ocupado ? L.desdeXml.agregando : L.desdeXml.agregar}
        </Button>
        <Button variant="secundario" onClick={alCancelar} disabled={ocupado} className="max-lg:h-11">
          {M.cancelar}
        </Button>
      </div>
    </form>
  );
}
