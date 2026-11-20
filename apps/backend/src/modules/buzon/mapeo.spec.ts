// Spec 024 (T8): del repositorio de la bandeja a los contratos de `shared`, sin BD.
import { describe, expect, it } from "vitest";
import type { DetalleAtencionBuzon, FilaBandejaBuzon } from "@contapp/db";
import { aAtencionDetalle, aEventos, aFilaBandeja } from "./mapeo.js";

const U = "0190a000-0000-7000-8000-0000000000e1";
const EN = new Date("2026-11-12T15:00:00.123Z");
const fila = (atencion: FilaBandejaBuzon["atencion"]): FilaBandejaBuzon => ({
  id: "0190a000-0000-7000-8000-0000000000f1",
  asunto: "A",
  remitente: "SUNAT",
  fecha: EN,
  fechaTexto: "2026-11-12T15:00:00.123000Z",
  categoria: "coactiva",
  critico: true,
  motivoCritico: "codigo",
  leidoEnSunat: false,
  contenidoObtenido: false,
  adjuntosDeclarados: 0,
  cliente: { id: "0190a000-0000-7000-8000-0000000000c1", razonSocial: "Acme", archivado: false },
  atencion,
});

describe("aFilaBandeja", () => {
  it("una fila pendiente: atención en blanco y la fecha en ISO", () => {
    expect(aFilaBandeja(fila({ estado: "pendiente", por: null, en: null }))).toMatchObject({
      fecha: "2026-11-12T15:00:00.123Z",
      cliente: { razonSocial: "Acme", archivado: false },
      atencion: { estado: "pendiente", por: null, en: null },
    });
  });

  it("una atendida lleva quién y cuándo; un usuario sin nombre sale con texto vacío; sin comentario", () => {
    const f = aFilaBandeja(fila({ estado: "atendido", por: { id: U, nombre: null }, en: EN }));
    expect(f.atencion).toEqual({ estado: "atendido", por: { id: U, nombre: "" }, en: "2026-11-12T15:00:00.123Z" });
    expect(JSON.stringify(f)).not.toContain("comentario");
  });
});

describe("detalle de atención", () => {
  const detalle: DetalleAtencionBuzon = {
    estado: "atendido",
    por: { id: U, nombre: "Carla" },
    en: EN,
    comentario: "Hecho",
    historial: [
      { accion: "atendido", comentario: "Hecho", usuario: { id: U, nombre: "Carla" }, en: EN },
      { accion: "deshecho", comentario: null, usuario: { id: U, nombre: null }, en: EN },
    ],
  };

  it("estado vigente con el comentario del último atendido", () => {
    expect(aAtencionDetalle(detalle)).toEqual({
      estado: "atendido",
      por: { id: U, nombre: "Carla" },
      en: "2026-11-12T15:00:00.123Z",
      comentario: "Hecho",
    });
  });

  it("historial en el orden recibido, con fechas ISO", () => {
    expect(aEventos(detalle).map((e) => [e.accion, e.comentario, e.usuario.nombre, e.en])).toEqual([
      ["atendido", "Hecho", "Carla", "2026-11-12T15:00:00.123Z"],
      ["deshecho", null, "", "2026-11-12T15:00:00.123Z"],
    ]);
  });
});
