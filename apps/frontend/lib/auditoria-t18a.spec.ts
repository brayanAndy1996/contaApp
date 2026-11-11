import { describe, expect, it } from "vitest";
import { fechaHoraLima } from "./fechas";
import { lineasDetalle, textoAccion, textoActor, textoDetalle } from "./auditoria";

// Spec 017 · T18a (P-2, P-3, P-4 y fechas en hora de Lima): el actor de un trabajo lleva el nombre de quien lo lanzó, el detalle
// no muestra códigos crudos (si llega uno desconocido, un texto genérico), el alta por invitación se lee «Se unió al estudio»,
// las acciones sobre otros nombran al `objetivo` y «Editó un cliente» muestra el antes → después con campos en español.

const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const ROSA = { id: U1, nombre: "Rosa Quispe", activo: true };
const BETO = { id: U2, nombre: "Beto Contador", activo: true };
const CODIGO = /[a-z]+_[a-z]+|[a-z]+\.[a-z]+|\bdueno\b|\bsol\b|\bsire_api\b|\bclasificar\b|\bsugerencia\b|\bdeshacer\b|\babierto\b|\brevisado\b/;

describe("textoActor · P-2", () => {
  it("un trabajo lanzado por un usuario dice «Nombre (proceso automático)»", () => {
    expect(textoActor({ tipo: "trabajo", autor: BETO, trabajoId: U1 })).toBe("Beto Contador (proceso automático)");
    expect(textoActor({ tipo: "trabajo", autor: { ...BETO, activo: false }, trabajoId: U1 })).toBe(
      "Beto Contador (inactivo) (proceso automático)",
    );
  });

  it("un trabajo sin autor sigue siendo «Proceso automático»; el sistema, «Sistema»; el usuario, su nombre", () => {
    expect(textoActor({ tipo: "trabajo", autor: null, trabajoId: U1 })).toBe("Proceso automático");
    expect(textoActor({ tipo: "sistema", autor: null, trabajoId: null })).toBe("Sistema");
    expect(textoActor({ tipo: "usuario", autor: ROSA, trabajoId: null })).toBe("Rosa Quispe");
  });
});

describe("textoDetalle · P-3, códigos traducidos", () => {
  it("estados de periodo: «Estado: Abierto → Revisado», y el alta de un periodo, solo el estado nuevo", () => {
    expect(
      textoDetalle({ accion: "periodo.estado_cambiado", datos: { libro: "compras", periodo: "202610", de: "abierto", a: "revisado" } }),
    ).toBe("Libro: Compras · Periodo: 202610 · Estado: Abierto → Revisado");
    expect(textoDetalle({ accion: "periodo.estado_cambiado", datos: { libro: "ventas", periodo: "202610", de: null, a: "abierto" } })).toBe(
      "Libro: Ventas · Periodo: 202610 · Estado: Abierto",
    );
  });

  it("roles: dueno → Dueño, admin → Administrador, y el cambio de rol", () => {
    expect(textoDetalle({ accion: "miembro.alta", datos: { rol: "dueno", via: "otro" } })).toBe("Rol: Dueño");
    expect(textoDetalle({ accion: "invitacion.creada", datos: { rol: "admin" } })).toBe("Rol: Administrador");
    expect(textoDetalle({ accion: "miembro.rol_cambiado", datos: { de: "asistente", a: "contador" } })).toBe(
      "Rol: Asistente → Contador",
    );
  });

  it("tipos de credencial, operaciones de compras y tipos de asignación", () => {
    expect(textoDetalle({ accion: "credencial.guardada", datos: { tipo: "sol" } })).toBe("Credencial: Clave SOL");
    expect(textoDetalle({ accion: "credencial.verificada", datos: { tipo: "sire_api" } })).toBe(
      "Credencial: Credencial de la API del SIRE",
    );
    expect(textoDetalle({ accion: "compra.operacion", datos: { tipo: "clasificar", periodo: "202610", filas: 3 } })).toBe(
      "Periodo: 202610 · Operación: Clasificación · Filas: 3",
    );
    expect(textoDetalle({ accion: "compra.operacion", datos: { tipo: "sugerencia" } })).toBe("Operación: Aceptar una sugerencia");
    expect(textoDetalle({ accion: "compra.operacion", datos: { tipo: "deshacer" } })).toBe("Operación: Deshacer");
    expect(textoDetalle({ accion: "asignacion.agregada", datos: { tipo: "responsable", usuarioId: U1 } })).toBe("Tipo: Responsable");
  });

  it("motivos y tipos de trabajo: ninguno sale como código", () => {
    for (const motivo of ["credencial.verificar", "sire.token", "credencial_invalida", "sire.propuesta.descargar", "sunat_no_responde"]) {
      const t = textoDetalle({ accion: "credencial.invalidada", datos: { tipo: "sol", motivo } });
      expect(t, motivo).not.toContain(motivo);
      expect(t, motivo).toMatch(/^Credencial: Clave SOL · Motivo: \p{Lu}/u);
    }
    expect(textoDetalle({ accion: "credencial.invalidada", datos: { motivo: "credencial.verificar" } })).toBe(
      "Motivo: Verificación de la credencial",
    );
  });

  it("un código desconocido da un texto genérico, nunca el código", () => {
    const t = textoDetalle({
      accion: "periodo.estado_cambiado",
      datos: { libro: "libro_nuevo", de: "estado_x", a: "estado_y", motivo: "motivo_x" },
    });
    expect(t).toBe("Libro: Otro libro · Estado: Otro estado → Otro estado · Motivo: Otro motivo");
    expect(textoDetalle({ accion: "miembro.alta", datos: { rol: "rol_x" } })).toBe("Rol: Otro rol");
    expect(textoDetalle({ accion: "credencial.guardada", datos: { tipo: "tipo_x" } })).toBe("Credencial: Otra credencial");
    expect(textoDetalle({ accion: "compra.operacion", datos: { tipo: "op_x" } })).toBe("Operación: Otra operación");
    // Un tipo sin contexto conocido no se muestra.
    expect(textoDetalle({ accion: "xml.subido", datos: { tipo: "algo", n: 2 } })).toBe("");
    // `__proto__` y `constructor` no son claves de los diccionarios.
    expect(textoDetalle({ accion: "miembro.alta", datos: { rol: "constructor" } })).toBe("Rol: Otro rol");
  });

  it("ninguna línea trae códigos crudos", () => {
    const filas = [
      { accion: "periodo.estado_cambiado", datos: { libro: "compras", periodo: "202610", de: "abierto", a: "revisado" } },
      { accion: "miembro.rol_cambiado", datos: { de: "dueno", a: "lectura" } },
      { accion: "credencial.invalidada", datos: { tipo: "sire_api", motivo: "sire.token" } },
    ];
    for (const f of filas) expect(textoDetalle(f).replace(/Periodo: \d+/, ""), f.accion).not.toMatch(CODIGO);
  });
});

describe("P-4 · alta por invitación, objetivo y cliente editado", () => {
  it("el alta por invitación dice «Se unió al estudio»; por registro, «Creó el estudio»; otra, el texto de siempre", () => {
    expect(textoAccion("miembro.alta", { rol: "admin", via: "invitacion" })).toBe("Se unió al estudio");
    expect(textoAccion("miembro.alta", { rol: "dueno", via: "registro" })).toBe("Creó el estudio");
    expect(textoAccion("miembro.alta", { rol: "admin", via: "otro" })).toBe("Dio de alta a un miembro");
    expect(textoAccion("miembro.alta")).toBe("Dio de alta a un miembro");
  });

  it("quien se une por invitación no se repite como «Miembro»; el rol sí se muestra", () => {
    expect(lineasDetalle({ accion: "miembro.alta", datos: { rol: "admin", via: "invitacion" }, objetivo: ROSA })).toEqual(["Rol: Administrador"]);
  });

  it("las acciones sobre otros nombran al objetivo (con «(inactivo)» y «Usuario desconocido»)", () => {
    expect(lineasDetalle({ accion: "miembro.rol_cambiado", datos: { de: "asistente", a: "contador" }, objetivo: BETO })).toEqual([
      "Miembro: Beto Contador",
      "Rol: Asistente → Contador",
    ]);
    expect(lineasDetalle({ accion: "miembro.desactivado", datos: {}, objetivo: BETO })).toEqual(["Miembro: Beto Contador"]);
    expect(lineasDetalle({ accion: "miembro.reactivado", datos: {}, objetivo: { ...BETO, activo: false } })).toEqual([
      "Miembro: Beto Contador (inactivo)",
    ]);
    expect(lineasDetalle({ accion: "asignacion.quitada", datos: { tipo: "responsable" }, objetivo: BETO })).toEqual([
      "Usuario: Beto Contador",
      "Tipo: Responsable",
    ]);
    expect(lineasDetalle({ accion: "asignacion.agregada", datos: { tipo: "colaborador" }, objetivo: { id: U2, nombre: null, activo: false } })).toEqual([
      "Usuario: Usuario desconocido",
      "Tipo: Colaborador",
    ]);
    expect(lineasDetalle({ accion: "invitacion.creada", datos: { rol: "contador" }, objetivo: null })).toEqual(["Rol: Contador"]);
    expect(lineasDetalle({ accion: "invitacion.revocada", datos: {}, objetivo: BETO })).toEqual(["Aceptada por: Beto Contador"]);
  });

  it("«Editó un cliente» muestra antes → después con nombres de campo en español", () => {
    const lineas = lineasDetalle({
      accion: "cliente.editado",
      datos: {
        cambios: {
          razon_social: ["Andina SAC", "Andina Perú SAC"],
          estado_contribuyente: [null, "ACTIVO"],
          regimen: ["rg", "rmt"],
          zona: ["general", "amazonia"],
          ventas_mixtas: [false, true],
          moneda_habitual: ["PEN", "USD"],
          campo_nuevo_x: ["a", "b"],
        },
      },
    });
    expect(lineas).toEqual([
      "Razón social: Andina SAC → Andina Perú SAC",
      "Estado del contribuyente: (vacío) → ACTIVO",
      "Régimen: Régimen General (RG) → Régimen MYPE Tributario (RMT)",
      "Zona: General → Amazonía",
      "Ventas mixtas: No → Sí",
      "Moneda habitual: Soles (PEN) → Dólares (USD)",
      "Otro dato: a → b",
    ]);
    expect(lineas.join(" ")).not.toMatch(/razon_social|estado_contribuyente|campo_nuevo_x|ventas_mixtas/);
  });

  it("cambios con otra forma no rompen ni muestran nada", () => {
    expect(lineasDetalle({ accion: "cliente.editado", datos: { cambios: "x" } })).toEqual([]);
    expect(lineasDetalle({ accion: "cliente.editado", datos: { cambios: { zona: ["general"] } } })).toEqual([]);
    expect(lineasDetalle({ accion: "cliente.editado", datos: {} })).toEqual([]);
  });
});

describe("fechaHoraLima · hora de Lima, no la del navegador ni UTC", () => {
  it("17:28 UTC es 12:28 p. m. en Lima, y pasada la medianoche UTC sigue siendo el día anterior", () => {
    expect(fechaHoraLima("2026-11-11T17:28:00.000Z")).toMatch(/^11\/11\/26,? 12:28\s?p\.\s?m\.$/);
    expect(fechaHoraLima("2026-11-12T03:30:00.000Z")).toMatch(/^11\/11\/26,? 10:30\s?p\.\s?m\.$/);
  });

  it("una fecha ilegible sale «—»", () => {
    expect(fechaHoraLima("no-es-fecha")).toBe("—");
  });
});
