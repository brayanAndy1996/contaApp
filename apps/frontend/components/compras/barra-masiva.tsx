"use client";

import {
  DESTINOS_COMPRA,
  masivaAceptarSchema,
  masivaClasificarSchema,
  masivaExcluirSchema,
  masivaRestaurarSchema,
  type DestinoCompra,
  type FilaCompraVista,
  type InformeMasiva,
} from "@contapp/shared";
import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  TOPE_SELECCION,
  masivaAceptarCompras,
  masivaClasificarCompras,
  masivaExcluirCompras,
  masivaRestaurarCompras,
  type ContextoCompras,
  type ResultadoCompras,
} from "../../lib/compras";
import { MENSAJES_APRENDIZAJE as A } from "../../lib/aprendizaje";
import { RecordarTrasClasificar } from "../reglas/recordar-tras-clasificar";
import { Button, Input, Label, velo } from "../ui";
import type { AlAvisar } from "./accion-compras";
import { useErrorAnunciado } from "./aviso-unico";
import { InformeMasivo } from "./informe-masivo";

// Barra de acciones masivas (spec 015, D-8, RF-063, CA-7). Con filas seleccionadas ofrece clasificar, excluir (motivo
// opcional), restaurar y «Aceptar R-RED» (en masa solo se acepta R-RED, 014 D-15). Hace UNA petición con el
// `versionBase` de cada fila cargada. Las masivas son parciales: el informe muestra las aplicadas y las rechazadas con
// su motivo; se recargan las aplicadas y las `version_obsoleta` (lo demás no cambió). Sin actualización optimista.

type Modo = "barra" | "excluir";

/** «Recordar» tras una masiva (spec 021, P-2): solo con un único proveedor en toda la selección y lo que se aplicó. */
interface OfertaRecordar {
  n: number;
  compraIds: string[];
  proveedor: FilaCompraVista["proveedor"];
  destino: DestinoCompra;
}

/** El proveedor (tipo + número) común a todas las filas, o `null` si hay varios o ninguna. */
function proveedorUnico(
  filas: readonly FilaCompraVista[],
): FilaCompraVista["proveedor"] | null {
  const primera = filas[0];
  if (primera === undefined) return null;
  const mismo = filas.every(
    (f) => f.proveedor.tipo === primera.proveedor.tipo && f.proveedor.numero === primera.proveedor.numero,
  );
  return mismo ? primera.proveedor : null;
}

export function BarraMasiva({
  contexto,
  filas,
  seleccion,
  alAvisar,
  alOperacion,
  alLimpiarSeleccion,
}: {
  contexto: ContextoCompras;
  /** Las filas cargadas: de ahí salen el `versionBase` de cada seleccionada y los comprobantes del informe. */
  filas: readonly FilaCompraVista[];
  seleccion: ReadonlySet<string>;
  alAvisar?: AlAvisar;
  /** Se llama si la masiva aplicó al menos una fila (T10 la cuenta para el atajo de deshacer, P-4). */
  alOperacion?: () => void;
  /** Se llama cuando no quedó ninguna rechazada. */
  alLimpiarSeleccion?: () => void;
}) {
  const [modo, setModo] = useState<Modo>("barra");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { avisarError, rolDe } = useErrorAnunciado(alAvisar);
  const [ocupado, setOcupado] = useState(false);
  const [informe, setInforme] = useState<InformeMasiva | null>(null);
  const [recordar, setRecordar] = useState<OfertaRecordar | null>(null);

  if (!contexto.permisos.clasificar) return null;
  if (seleccion.size === 0 && informe === null && recordar === null) return null;

  const items = filas
    .filter((f) => seleccion.has(f.id))
    .map((f) => ({ compraId: f.id, versionBase: f.version }));
  const hayRed = filas.some(
    (f) => seleccion.has(f.id) && f.hallazgos.some((h) => h.regla === "R-RED"),
  );
  const hayStd = filas.some(
    (f) => seleccion.has(f.id) && f.hallazgos.some((h) => h.regla === "R-STD"),
  );
  const demasiadas = items.length > TOPE_SELECCION;
  const bloqueo = contexto.soloLectura;
  const deshabilitado = ocupado || bloqueo !== null || demasiadas;

  async function aplicar(
    pedir: () => Promise<ResultadoCompras<InformeMasiva>>,
    destinoOk?: DestinoCompra,
  ): Promise<void> {
    if (ocupado) return;
    setError(null);
    setRecordar(null);
    setOcupado(true);
    try {
      const r = await pedir();
      if (!r.ok) {
        setError(r.mensaje);
        avisarError(r.mensaje);
        setOcupado(false);
        return;
      }
      const rechazadas = new Set(r.datos.rechazadas.map((x) => x.compraId));
      const obsoletas = r.datos.rechazadas
        .filter((x) => x.codigo === "version_obsoleta")
        .map((x) => x.compraId);
      const aplicadas = items
        .map((i) => i.compraId)
        .filter((id) => !rechazadas.has(id));
      const recargar = [...aplicadas, ...obsoletas];
      await Promise.all([
        recargar.length > 0 ? contexto.recargarFilas(recargar) : undefined,
        contexto.recargarResumen(),
      ]);
      if (r.datos.aplicadas > 0) alOperacion?.();
      if (destinoOk !== undefined && aplicadas.length > 0) {
        const proveedor = proveedorUnico(filas.filter((f) => seleccion.has(f.id)));
        if (proveedor !== null) {
          setRecordar((previo) => ({
            n: (previo?.n ?? 0) + 1,
            compraIds: aplicadas,
            proveedor,
            destino: destinoOk,
          }));
        }
      }
      setInforme(r.datos);
      setModo("barra");
      setMotivo("");
      alAvisar?.(
        `${M.aplicadas(r.datos.aplicadas)} · ${M.rechazadas(r.datos.rechazadas.length)}`,
        r.datos.aplicadas > 0 ? "ok" : "error",
      );
      if (r.datos.rechazadas.length === 0) alLimpiarSeleccion?.();
    } catch {
      setError(MENSAJES.errorGeneral);
      avisarError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const invalida = () => {
    setError(M.datosInvalidos);
  };

  const clasificar = (destino: DestinoCompra) => {
    const cuerpo = masivaClasificarSchema.safeParse({ items, destino });
    if (!cuerpo.success) return invalida();
    void aplicar(
      () => masivaClasificarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
      destino,
    );
  };

  const restaurar = () => {
    const cuerpo = masivaRestaurarSchema.safeParse({ items });
    if (!cuerpo.success) return invalida();
    void aplicar(() =>
      masivaRestaurarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  };

  const aceptarRed = () => {
    const cuerpo = masivaAceptarSchema.safeParse({ items, regla: "R-RED" });
    if (!cuerpo.success) return invalida();
    void aplicar(() =>
      masivaAceptarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  };

  // Spec 025 (CA-9, CA-10): R-STD no pide dato ni confirmación; tras aplicarse se ofrece «Recordar» con DNG.
  const aceptarStd = () => {
    const cuerpo = masivaAceptarSchema.safeParse({ items, regla: "R-STD" });
    if (!cuerpo.success) return invalida();
    void aplicar(
      () => masivaAceptarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
      "DNG",
    );
  };

  function excluir(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault();
    const limpio = motivo.trim();
    const cuerpo = masivaExcluirSchema.safeParse({
      items,
      ...(limpio === "" ? {} : { motivo: limpio }),
    });
    if (!cuerpo.success) {
      setError(M.motivoMaximo);
      return;
    }
    void aplicar(() =>
      masivaExcluirCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  }

  const boton = (
    texto: string,
    alPulsar: () => void,
    extra: { deshabilitado?: boolean; ayuda?: string } = {},
  ) => (
    <Button
      key={texto}
      variant="secundario"
      size="sm"
      disabled={deshabilitado || extra.deshabilitado === true}
      title={bloqueo ?? extra.ayuda}
      onClick={alPulsar}
      className="max-lg:h-11"
    >
      {texto}
    </Button>
  );

  return (
    <>
      {seleccion.size > 0 && (
        <div
          role="toolbar"
          aria-label={M.barraMasiva}
          className="flex flex-col gap-2 rounded-control border border-linea bg-hoja-alterna p-2 text-tinta"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">
              {M.seleccionadas(seleccion.size)}
            </span>
            {DESTINOS_COMPRA.map((d) =>
              boton(M.clasificarComo(M.destinos[d]), () => clasificar(d)),
            )}
            {boton(M.excluir, () => {
              setError(null);
              setModo("excluir");
            })}
            {boton(M.restaurar, restaurar)}
            {boton(M.aceptarRed, aceptarRed, {
              deshabilitado: !hayRed,
              ayuda: hayRed ? undefined : M.aceptarRedSinSugerencia,
            })}
            {boton(A.aceptarStd, aceptarStd, {
              deshabilitado: !hayStd,
              ayuda: hayStd ? undefined : A.aceptarStdSinSugerencia,
            })}
            {alLimpiarSeleccion && (
              <Button
                variant="terciario"
                size="sm"
                disabled={ocupado}
                onClick={alLimpiarSeleccion}
                className="max-lg:h-11"
              >
                {M.limpiarSeleccion}
              </Button>
            )}
          </div>
          {modo === "excluir" && (
            <form
              aria-label={`${M.excluir} · ${M.seleccionadas(seleccion.size)}`}
              onSubmit={excluir}
              noValidate
              className="flex flex-wrap items-end gap-2"
            >
              <Label>
                {M.motivoExclusion}
                <Input
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  className="w-72 max-w-full max-lg:h-11"
                />
              </Label>
              <Button type="submit" size="sm" disabled={deshabilitado} className="max-lg:h-11">
                {M.excluir}
              </Button>
              <Button
                variant="secundario"
                size="sm"
                disabled={ocupado}
                onClick={() => setModo("barra")}
                className="max-lg:h-11"
              >
                {M.cancelar}
              </Button>
            </form>
          )}
          {demasiadas && (
            <p className="text-sm text-aviso">
              {M.seleccionarDemasiadas(TOPE_SELECCION)}
            </p>
          )}
          {bloqueo !== null && <p className="text-sm">{bloqueo}</p>}
          {error && (
            <p role={rolDe(error)} className="text-sm text-error">
              {error}
            </p>
          )}
        </div>
      )}
      {recordar !== null && (
        <RecordarTrasClasificar
          key={recordar.n}
          contexto={contexto}
          compraIds={recordar.compraIds}
          proveedor={recordar.proveedor}
          destino={recordar.destino}
          alAvisar={alAvisar}
          alTerminar={() => setRecordar(null)}
        />
      )}
      {informe && (
        <div className={velo}>
          <InformeMasivo
            informe={informe}
            filas={filas}
            alCerrar={() => setInforme(null)}
          />
        </div>
      )}
    </>
  );
}
