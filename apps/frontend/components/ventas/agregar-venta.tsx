"use client";

import { ventaAgregarSchema, type VentaAgregarInput } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_VENTAS as M,
  agregarVenta,
  mensajeDeErrorVentas,
} from "../../lib/ventas";
import { Alert, Button, Input, Label, Select } from "../ui";
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

/** Campos que se escriben en mono (D7): serie, número y documento de la contraparte. */
const CON_MONO: ReadonlySet<Campo> = new Set<Campo>(["serie", "numero", "documento"]);

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
    <Label>
      {M.campos[campo]}
      <Input
        ref={opciones.ref ? primero : undefined}
        type="text"
        inputMode={opciones.modo}
        autoComplete="off"
        value={valores[campo]}
        onChange={(e) => poner(campo)(e.target.value)}
        className={`font-normal max-lg:h-11 ${opciones.ancho ?? ""} ${opciones.modo === "decimal" ? "cifra" : ""} ${CON_MONO.has(campo) ? "font-mono" : ""}`}
      />
    </Label>
  );

  return (
    <form
      aria-label={M.formularioAgregar}
      onSubmit={(e) => void enviar(e)}
      noValidate
      className="flex w-full max-w-3xl flex-col gap-4 rounded-tarjeta border border-linea bg-hoja p-5 shadow-tarjeta"
    >
      <h3 className="m-0 font-titulo text-base font-bold text-tinta">{M.formularioAgregar}</h3>
      <div className="flex flex-wrap gap-3">
        {texto("tipo", { ancho: "w-20", modo: "numeric", ref: true })}
        {texto("serie", { ancho: "w-28" })}
        {texto("numero", { ancho: "w-40", modo: "numeric" })}
        <Label>
          {M.campos.fecha}
          <Input
            type="date"
            value={valores.fecha}
            onChange={(e) => poner("fecha")(e.target.value)}
            className="w-44 font-normal max-lg:h-11"
          />
        </Label>
        <Label>
          {M.campos.moneda}
          <Select
            value={valores.moneda}
            onChange={(e) => poner("moneda")(e.target.value)}
            className="w-28 font-normal max-lg:h-11"
          >
            <option value="PEN">PEN</option>
            <option value="USD">USD</option>
          </Select>
        </Label>
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
      {error && <Alert tono="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={ocupado} className="max-lg:h-11">
          {M.agregar}
        </Button>
        <Button
          type="button"
          variant="secundario"
          onClick={alCancelar}
          disabled={ocupado}
          className="max-lg:h-11"
        >
          {M.cancelar}
        </Button>
      </div>
    </form>
  );
}
