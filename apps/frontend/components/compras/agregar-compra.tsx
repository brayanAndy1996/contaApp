"use client";

import {
  COLUMNAS_MONTO_COMPRA,
  agregarCompraSchema,
  type ColumnaMontoCompra,
  type FilaCompraVista,
} from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  agregarCompra,
  type ContextoCompras,
} from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  mensajeDeErrorXml,
  vistaPreviaDesdeXml,
  type VistaPreviaDesdeXml,
} from "../../lib/lupa-compras";
import { conMiles, sumar, validarMonto } from "../../lib/montos-compras";
import type { AlAvisar } from "./accion-compras";
import { AgregarDesdeXml } from "./agregar-desde-xml";
import { SelectorXml } from "./subir-xml";

// Diálogo «Agregar compra» (spec 015, D-11, P-7, HU-18, CA-11). Comprobante, proveedor, fecha, moneda, tipo de
// cambio (obligatorio solo en USD) y las 10 columnas de monto con el total en vivo (`sumar`, solo informativo: el
// servidor lo recalcula). Todo se valida con `agregarCompraSchema` de shared antes de enviar. 409 `duplicado` avisa
// «Ya existe en la propuesta» con un enlace que ubica la fila existente (también si está excluida). «Subir XML» (016, T16)
// lee el XML con la vista previa del servidor y pasa a `AgregarDesdeXml` (solo destino; en USD, tipo de cambio). Los montos son cadenas; no se convierten a número.

type Campo =
  | "tipo"
  | "serie"
  | "numero"
  | "tipoDoc"
  | "documento"
  | "razonSocial"
  | "fecha"
  | "moneda"
  | "tipoCambio";

type Valores = Record<Campo, string> & Record<ColumnaMontoCompra, string>;

const CERO = "0.00";

function inicial(): Valores {
  return {
    tipo: "01",
    serie: "",
    numero: "",
    tipoDoc: "6",
    documento: "",
    razonSocial: "",
    fecha: "",
    moneda: "PEN",
    tipoCambio: "",
    biDg: CERO,
    igvDg: CERO,
    biDgng: CERO,
    igvDgng: CERO,
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    isc: CERO,
    icbper: CERO,
    otrosTributos: CERO,
  };
}

/** Etiqueta del campo del formulario al que apunta una ruta de error del esquema. */
function etiquetaDeRuta(ruta: readonly PropertyKey[]): string {
  const [a, b] = ruta;
  if (a === "proveedor") {
    if (b === "tipo") return M.campos.tipoDoc;
    if (b === "numero") return M.campos.documento;
    return M.campos.razonSocial;
  }
  if (a === "montos") {
    const columna = b as ColumnaMontoCompra | undefined;
    return columna ? M.casilleros[columna] : M.columnas.acciones;
  }
  const campo = a as Campo | undefined;
  return campo && campo in M.campos ? M.campos[campo] : String(a ?? "");
}

export function AgregarCompra({
  contexto,
  alAgregar,
  alCancelar,
  alUbicarExistente,
  alAvisar,
}: {
  contexto: ContextoCompras;
  /** Tras el 201, con la fila creada (queda marcada «Agregada»). */
  alAgregar: (fila: FilaCompraVista) => void;
  alCancelar: () => void;
  /** Enlace del 409 `duplicado`: ubica la compra existente (T10 cambia de vista si hace falta). */
  alUbicarExistente: (compraId: string) => void;
  alAvisar?: AlAvisar;
}) {
  const [v, setV] = useState<Valores>(inicial);
  const [error, setError] = useState<string | null>(null);
  const [duplicada, setDuplicada] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [desdeXml, setDesdeXml] = useState<{ archivo: File; vista: VistaPreviaDesdeXml } | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [errorXml, setErrorXml] = useState<string | null>(null);
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
  }, []);

  const bloqueo =
    !contexto.permisos.clasificar ? M.soloLectura.sinPermiso : contexto.soloLectura;
  if (bloqueo !== null) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={M.formularioAgregar}
        className="flex w-96 max-w-full flex-col gap-3 rounded border bg-white p-4 shadow-lg"
      >
        <h3 className="text-base font-medium">{M.formularioAgregar}</h3>
        <p className="text-sm">{bloqueo}</p>
        <button
          type="button"
          onClick={alCancelar}
          className="w-fit rounded border px-3 py-1 text-sm"
        >
          {M.cerrar}
        </button>
      </div>
    );
  }

  if (desdeXml !== null) {
    return (
      <AgregarDesdeXml
        contexto={contexto}
        archivo={desdeXml.archivo}
        vista={desdeXml.vista}
        alAgregar={alAgregar}
        alQuitar={() => setDesdeXml(null)}
        alCancelar={alCancelar}
        alUbicarExistente={alUbicarExistente}
        alAvisar={alAvisar}
      />
    );
  }

  async function leerXml(archivo: File): Promise<void> {
    if (leyendo) return;
    setErrorXml(null);
    setLeyendo(true);
    try {
      const r = await vistaPreviaDesdeXml(contexto.clienteId, contexto.periodo, archivo);
      if (r.ok) setDesdeXml({ archivo, vista: r.datos });
      else if (r.status !== 401) setErrorXml(mensajeDeErrorXml(r, "cliente"));
    } catch {
      setErrorXml(MENSAJES.errorGeneral);
    }
    setLeyendo(false);
  }

  const poner = (campo: Campo | ColumnaMontoCompra) => (valor: string) => {
    setV((previos) => ({ ...previos, [campo]: valor }));
    setDuplicada(null);
  };

  // Cada columna se valida con `validarMonto`; el total en vivo solo existe si todas son válidas.
  const revisadas = COLUMNAS_MONTO_COMPRA.map((c) => ({
    columna: c,
    resultado: validarMonto(v[c]),
  }));
  const validos = revisadas.flatMap((r) =>
    r.resultado.ok ? [r.resultado.valor] : [],
  );
  const totalVivo =
    validos.length === revisadas.length ? sumar(validos) : null;

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    setDuplicada(null);
    if (v.moneda === "USD" && v.tipoCambio.trim() === "") {
      setError(M.tipoCambioObligatorio);
      return;
    }
    const invalido = revisadas.find((r) => !r.resultado.ok);
    if (invalido && !invalido.resultado.ok) {
      setError(`${M.casilleros[invalido.columna]}: ${invalido.resultado.motivo}`);
      return;
    }
    const montos: Record<string, string> = {};
    for (const r of revisadas) if (r.resultado.ok) montos[r.columna] = r.resultado.valor;
    const analisis = agregarCompraSchema.safeParse({
      tipo: v.tipo.trim(),
      serie: v.serie.trim().toUpperCase(),
      numero: v.numero.trim(),
      proveedor: {
        tipo: v.tipoDoc.trim().toUpperCase(),
        numero: v.documento.trim(),
        razonSocial: v.razonSocial.trim(),
      },
      fecha: v.fecha,
      moneda: v.moneda,
      ...(v.moneda === "USD" ? { tipoCambio: v.tipoCambio.trim() } : {}),
      montos,
    });
    if (!analisis.success) {
      const campos = [
        ...new Set(analisis.error.issues.map((i) => etiquetaDeRuta(i.path))),
      ];
      setError(`${M.datosInvalidos} ${campos.join(", ")}.`);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await agregarCompra(contexto.clienteId, contexto.periodo, analisis.data);
      if (r.ok) {
        await Promise.all([
          contexto.recargarFila(r.datos.fila.id),
          contexto.recargarResumen(),
        ]);
        alAvisar?.(M.compraAgregada, "ok");
        alAgregar(r.datos.fila);
        return;
      }
      if (r.codigo === "duplicado" && r.id !== undefined) {
        setDuplicada(r.id);
        setError(M.yaExisteEnPropuesta);
      } else {
        setError(r.mensaje);
      }
      alAvisar?.(r.codigo === "duplicado" ? M.yaExisteEnPropuesta : r.mensaje, "error");
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
    }
    setOcupado(false);
  }

  const texto = (
    campo: Campo,
    opciones: { ancho?: string; modo?: "numeric" | "decimal"; ref?: boolean } = {},
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      {M.campos[campo]}
      <input
        ref={opciones.ref ? primero : undefined}
        type="text"
        inputMode={opciones.modo}
        autoComplete="off"
        value={v[campo]}
        onChange={(e) => poner(campo)(e.target.value)}
        className={`rounded border px-3 py-2 ${opciones.ancho ?? ""}`}
      />
    </label>
  );

  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={M.formularioAgregar}
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className="flex max-h-[90vh] w-[56rem] max-w-full flex-col gap-3 overflow-auto rounded border bg-white p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">{M.formularioAgregar}</h3>
        <SelectorXml etiqueta={M.subirXml} ocupado={leyendo || ocupado} alElegir={(a) => void leerXml(a)} />
      </div>
      {leyendo && (
        <p role="status" className="text-sm">
          {L.subir.leyendo}
        </p>
      )}
      {errorXml && (
        <p role="alert" className="text-sm text-red-600">
          {errorXml}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {texto("tipo", { ancho: "w-20", modo: "numeric", ref: true })}
        {texto("serie", { ancho: "w-28" })}
        {texto("numero", { ancho: "w-40", modo: "numeric" })}
        <label className="flex flex-col gap-1 text-sm">
          {M.campos.fecha}
          <input
            type="date"
            value={v.fecha}
            onChange={(e) => poner("fecha")(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {M.campos.moneda}
          <select
            value={v.moneda}
            onChange={(e) => poner("moneda")(e.target.value)}
            className="rounded border px-3 py-2"
          >
            <option value="PEN">PEN</option>
            <option value="USD">USD</option>
          </select>
        </label>
        {v.moneda === "USD" && texto("tipoCambio", { ancho: "w-32", modo: "decimal" })}
      </div>

      <div className="flex flex-wrap gap-3">
        {texto("tipoDoc", { ancho: "w-20" })}
        {texto("documento", { ancho: "w-48" })}
        {texto("razonSocial", { ancho: "w-96" })}
      </div>

      <div className="flex flex-wrap gap-3">
        {revisadas.map((r) => (
          <div key={r.columna} className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-sm">
              {M.casilleros[r.columna]}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={v[r.columna]}
                onChange={(e) => poner(r.columna)(e.target.value)}
                aria-invalid={!r.resultado.ok}
                aria-describedby={r.resultado.ok ? undefined : `agregar-${r.columna}-error`}
                className={`w-32 rounded border px-3 py-2 text-right ${r.resultado.ok ? "" : "border-red-500"}`}
              />
            </label>
            {!r.resultado.ok && (
              <span
                id={`agregar-${r.columna}-error`}
                className="max-w-32 text-xs text-red-600"
              >
                {r.resultado.motivo}
              </span>
            )}
          </div>
        ))}
        <div className="flex flex-col gap-1 text-sm">
          {M.casilleros.total}
          <output
            aria-label={M.casilleros.total}
            className="w-32 rounded border bg-gray-50 px-3 py-2 text-right font-medium"
          >
            {totalVivo === null ? "—" : conMiles(totalVivo)}
          </output>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
          {duplicada !== null && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => alUbicarExistente(duplicada)}
                className="underline"
              >
                {M.ubicarExistente}
              </button>
            </>
          )}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={ocupado}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {M.agregar}
        </button>
        <button
          type="button"
          onClick={alCancelar}
          disabled={ocupado}
          className="rounded border px-4 py-2 text-sm"
        >
          {M.cancelar}
        </button>
      </div>
    </form>
  );
}
