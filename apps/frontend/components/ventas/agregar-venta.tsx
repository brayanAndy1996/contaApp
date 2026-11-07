"use client";

import { ventaAgregarSchema, type VentaAgregarInput } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_VENTAS as M,
  agregarVenta,
  mensajeDeErrorVentas,
} from "../../lib/ventas";
import type { SaltoElegido } from "./correlatividad-ventas";

// Formulario «Agregar venta» (spec 013, D9; RF-055, CA-8). Valida la forma con `ventaAgregarSchema` de shared
// y envía los montos como cadenas. NO suma ni compara montos: si el total no cuadra o la clave se repite,
// lo decide el servidor (400 y 409).

type Campo =
  | "tipo"
  | "serie"
  | "numero"
  | "fecha"
  | "moneda"
  | "tipoCambio"
  | "tipoDoc"
  | "documento"
  | "baseGravada"
  | "igv"
  | "exonerada"
  | "inafecta"
  | "isc"
  | "icbper"
  | "otros"
  | "total";

type Valores = Record<Campo, string>;

const MONTOS = [
  "baseGravada",
  "igv",
  "exonerada",
  "inafecta",
  "isc",
  "icbper",
  "otros",
  "total",
] as const;

const CERO = "0.00";

function inicial(salto: SaltoElegido | null): Valores {
  return {
    tipo: salto?.tipo ?? "",
    serie: salto?.serie ?? "",
    numero: salto ? String(salto.desde) : "",
    fecha: "",
    moneda: "PEN",
    tipoCambio: "",
    tipoDoc: "",
    documento: "-",
    baseGravada: CERO,
    igv: CERO,
    exonerada: CERO,
    inafecta: CERO,
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    total: CERO,
  };
}

/** Arma el cuerpo del POST con las cadenas escritas; lo no aplicable (tipo de cambio en PEN, tipo de documento vacío) no viaja. */
function cuerpoDe(v: Valores): unknown {
  const t = (c: Campo) => v[c].trim();
  return {
    tipo: t("tipo"),
    serie: t("serie"),
    numero: t("numero"),
    fechaEmision: t("fecha"),
    moneda: v.moneda,
    ...(v.moneda === "USD" ? { tipoCambio: t("tipoCambio") } : {}),
    ...(t("tipoDoc") !== "" ? { tipoDocContraparte: t("tipoDoc") } : {}),
    docContraparte: t("documento"),
    baseGravada: t("baseGravada"),
    igv: t("igv"),
    exonerada: t("exonerada"),
    inafecta: t("inafecta"),
    isc: t("isc"),
    icbper: t("icbper"),
    otros: t("otros"),
    total: t("total"),
  };
}

export function AgregarVenta({
  clienteId,
  periodo,
  salto,
  alAgregar,
  alCancelar,
}: {
  clienteId: string;
  periodo: string;
  /** El salto desde el que se abrió; `null` para la venta manual sin datos previos. */
  salto: SaltoElegido | null;
  /** Se llama tras el 201, para que la pantalla recargue grilla, resumen y correlatividad. */
  alAgregar: () => void;
  alCancelar: () => void;
}) {
  const [valores, setValores] = useState<Valores>(() => inicial(salto));
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const primero = useRef<HTMLInputElement>(null);

  useEffect(() => {
    primero.current?.focus();
  }, []);

  const poner = (campo: Campo) => (valor: string) =>
    setValores((previos) => ({ ...previos, [campo]: valor }));

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    const analisis = ventaAgregarSchema.safeParse(cuerpoDe(valores));
    if (!analisis.success) {
      setError(M.datosInvalidos);
      return;
    }
    const datos: VentaAgregarInput = analisis.data;
    setError(null);
    setOcupado(true);
    try {
      const r = await agregarVenta(clienteId, periodo, datos);
      if (r.ok) {
        alAgregar();
        return;
      }
      setError(mensajeDeErrorVentas(r.status, r.datos, M.datosInvalidos));
    } catch {
      setError(MENSAJES.errorGeneral);
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
        value={valores[campo]}
        onChange={(e) => poner(campo)(e.target.value)}
        className={`rounded border px-3 py-2 ${opciones.ancho ?? ""}`}
      />
    </label>
  );

  return (
    <form
      aria-label={M.formularioAgregar}
      onSubmit={(e) => void enviar(e)}
      noValidate
      className="flex max-w-3xl flex-col gap-3 rounded border p-3"
    >
      <h3 className="text-base font-medium">{M.formularioAgregar}</h3>
      <div className="flex flex-wrap gap-3">
        {texto("tipo", { ancho: "w-20", modo: "numeric", ref: true })}
        {texto("serie", { ancho: "w-28" })}
        {texto("numero", { ancho: "w-40", modo: "numeric" })}
        <label className="flex flex-col gap-1 text-sm">
          {M.campos.fecha}
          <input
            type="date"
            value={valores.fecha}
            onChange={(e) => poner("fecha")(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {M.campos.moneda}
          <select
            value={valores.moneda}
            onChange={(e) => poner("moneda")(e.target.value)}
            className="rounded border px-3 py-2"
          >
            <option value="PEN">PEN</option>
            <option value="USD">USD</option>
          </select>
        </label>
        {valores.moneda === "USD" &&
          texto("tipoCambio", { ancho: "w-32", modo: "decimal" })}
      </div>
      <div className="flex flex-wrap gap-3">
        {texto("tipoDoc", { ancho: "w-20" })}
        {texto("documento", { ancho: "w-48" })}
      </div>
      <div className="flex flex-wrap gap-3">
        {MONTOS.map((m) => (
          <span key={m}>{texto(m, { ancho: "w-32", modo: "decimal" })}</span>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
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
