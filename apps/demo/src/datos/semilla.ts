// Datos 100 % FICTICIOS para la demo. Los RUC son inventados (prefijo 2070000…/1070000… con
// dígito verificador válido) y las razones sociales llevan "DEMO". No hay datos reales.
// Los casos especiales reproducen las reglas de negocio de docs/01-definiciones-base.md §7 y
// los fixtures sintéticos de fixtures/ (San Juan ISC, mixta 21.48/1.61, ICBPER, USD, zapatilla, boleta 291).
import { Money, TASA_IGV_10, TASA_IGV_18, igvEsperado } from "@contapp/domain";
import { cero, sumar } from "../motor/dominio";
import type {
  Aprendida,
  Cliente,
  FilaCompra,
  FilaVenta,
  Mensaje,
  MesProrrata,
  MontosPlanos,
  PropuestaSemilla,
  Proveedor,
  Usuario,
  XmlDemo,
  XmlItem,
} from "./tipos";

export const ESTUDIO = {
  nombre: "Estudio Contable Demo & Asociados",
  plan: "Plan Estudio",
  limiteRucs: 10,
  limiteUsuarios: 5,
  frecuenciaBuzon: "Cada 6 horas",
};

export const USUARIOS: Usuario[] = [
  { id: "u1", nombre: "Ana Demo Quispe", email: "ana@estudio-demo.pe", rol: "Administrador", activo: true },
  { id: "u2", nombre: "Carlos Demo Rojas", email: "carlos@estudio-demo.pe", rol: "Contador", activo: true },
  { id: "u3", nombre: "Lucía Demo Flores", email: "lucia@estudio-demo.pe", rol: "Asistente", activo: true },
];

export const PERMISOS_ROL: Record<Usuario["rol"], string[]> = {
  Administrador: ["clientes.gestionar", "clientes.asignar", "credenciales.editar", "sire.editar", "sire.aprobar_generar", "usuarios.gestionar", "auditoria.ver"],
  Contador: ["clientes.gestionar", "credenciales.editar", "sire.editar", "sire.aprobar_generar", "auditoria.ver"],
  Asistente: ["sire.editar"],
};

export const PERIODO_ACTUAL = "202610";
export const PERIODOS = ["202610", "202609", "202608"];

export const PROVEEDORES: Proveedor[] = [
  { ruc: "20700000011", razonSocial: "CERVECERÍA SELVA DEMO S.A.C.", rubro: "Bebidas alcohólicas", emisorIsc: true },
  { ruc: "20700000045", razonSocial: "MINIMARKET MIXTO DEMO S.A.C.", rubro: "Comercio minorista" },
  { ruc: "20700000053", razonSocial: "BOLSAS Y EMPAQUES DEMO S.A.C.", rubro: "Comercio de empaques" },
  { ruc: "20700000061", razonSocial: "IMPORTADORA PACÍFICO DEMO S.A.C.", rubro: "Importación de insumos" },
  { ruc: "20700000070", razonSocial: "CALZADOS URBANOS DEMO S.A.C.", rubro: "Venta de calzado y ropa" },
  { ruc: "20700001050", razonSocial: "ELECTRO DISTRIBUCIÓN DEMO S.A.A.", rubro: "Energía eléctrica" },
  { ruc: "20700001076", razonSocial: "TELEFONÍA DEMO S.A.A.", rubro: "Telecomunicaciones" },
  { ruc: "20700001084", razonSocial: "COMBUSTIBLES DEMO S.A.C.", rubro: "Venta de combustible" },
  { ruc: "20700001092", razonSocial: "PAPELERÍA CENTRAL DEMO E.I.R.L.", rubro: "Útiles de oficina" },
  { ruc: "20700001106", razonSocial: "INMOBILIARIA DEMO S.A.C.", rubro: "Alquiler de inmuebles" },
  { ruc: "20700001114", razonSocial: "TRANSPORTES CARGA DEMO S.A.C.", rubro: "Transporte de carga" },
  { ruc: "20700001122", razonSocial: "AGUA POTABLE DEMO S.A.", rubro: "Agua y saneamiento" },
  { ruc: "20700001131", razonSocial: "INSUMOS AGRÍCOLAS DEMO S.A.C.", rubro: "Insumos agrícolas" },
  { ruc: "20700001165", razonSocial: "FERRETERÍA MAYORISTA DEMO S.A.C.", rubro: "Ferretería" },
  { ruc: "20700001173", razonSocial: "RESTAURANTE EL SABOR DEMO E.I.R.L.", rubro: "Restaurantes" },
  { ruc: "20700001181", razonSocial: "SOFTWARE CONTABLE DEMO S.A.C.", rubro: "Servicios de software" },
  { ruc: "20700001190", razonSocial: "MERCADERÍA MIXTA DEMO S.A.C.", rubro: "Comercio mayorista" },
];

export const CLIENTES: Cliente[] = [
  {
    id: "c1",
    ruc: "20700000002",
    razonSocial: "DISTRIBUIDORA ANDINA DEMO S.A.C.",
    regimen: "Régimen General",
    ubicacion: "Lima - Lima - Ate",
    actividad: "Venta al por mayor de alimentos y bebidas",
    zonaSelva: false,
    ventasExoneradas: false,
    responsable: "Carlos Demo Rojas",
    credencialSol: "valida",
    credencialSire: "valida",
    usuarioSol: "DEMOANDI",
    activo: true,
  },
  {
    id: "c2",
    ruc: "20700001025",
    razonSocial: "AGROINDUSTRIAS HUALLAGA DEMO S.A.C.",
    regimen: "Régimen General",
    ubicacion: "Huánuco - Leoncio Prado - Rupa Rupa (zona selva)",
    actividad: "Cultivo y venta de frutas (exonerado - Ley de la Amazonía)",
    zonaSelva: true,
    ventasExoneradas: true,
    responsable: "Carlos Demo Rojas",
    credencialSol: "valida",
    credencialSire: "valida",
    usuarioSol: "DEMOHUAL",
    activo: true,
  },
  {
    id: "c3",
    ruc: "20700001033",
    razonSocial: "FERRETERÍA EL PERNO DEMO E.I.R.L.",
    regimen: "Régimen MYPE Tributario",
    ubicacion: "Arequipa - Arequipa - Cercado",
    actividad: "Venta al por menor de artículos de ferretería",
    zonaSelva: false,
    ventasExoneradas: false,
    responsable: "Lucía Demo Flores",
    credencialSol: "invalida",
    credencialSire: "valida",
    usuarioSol: "DEMOPERN",
    activo: true,
  },
  {
    id: "c4",
    ruc: "20700001041",
    razonSocial: "TRANSPORTES RUTA SUR DEMO S.A.C.",
    regimen: "Régimen General",
    ubicacion: "Ica - Ica - Cercado",
    actividad: "Transporte de carga y venta de repuestos (gravado y exonerado)",
    zonaSelva: false,
    ventasExoneradas: false,
    responsable: "Ana Demo Quispe",
    credencialSol: "valida",
    credencialSire: "valida",
    usuarioSol: "DEMORUTA",
    activo: true,
  },
  {
    id: "c5",
    ruc: "10700001003",
    razonSocial: "PÉREZ DEMO JUAN CARLOS",
    regimen: "Régimen Especial (RER)",
    ubicacion: "Lima - Lima - San Juan de Lurigancho",
    actividad: "Bodega",
    zonaSelva: false,
    ventasExoneradas: false,
    responsable: "Lucía Demo Flores",
    credencialSol: "sin",
    credencialSire: "sin",
    activo: true,
  },
];

/** Catálogo "Consulta RUC" simulado para el alta de clientes. */
export const PADRON_RUC: Record<string, { razonSocial: string; ubicacion: string; actividad: string; regimen: string }> = {
  "20700001050": { razonSocial: "ELECTRO DISTRIBUCIÓN DEMO S.A.A.", ubicacion: "Lima - Lima - San Isidro", actividad: "Distribución de energía eléctrica", regimen: "Régimen General" },
  "20700001114": { razonSocial: "TRANSPORTES CARGA DEMO S.A.C.", ubicacion: "Callao - Callao - Callao", actividad: "Transporte de carga por carretera", regimen: "Régimen General" },
  "20700001203": { razonSocial: "PANADERÍA LA ESPIGA DEMO S.A.C.", ubicacion: "Lima - Lima - Surco", actividad: "Elaboración de productos de panadería", regimen: "Régimen MYPE Tributario" },
  "20700001211": { razonSocial: "CLÍNICA VETERINARIA DEMO E.I.R.L.", ubicacion: "Cusco - Cusco - Wanchaq", actividad: "Actividades veterinarias", regimen: "Régimen MYPE Tributario" },
  "20700001220": { razonSocial: "HOTEL AMAZONAS DEMO S.A.C.", ubicacion: "Loreto - Maynas - Iquitos (zona selva)", actividad: "Alojamiento (exonerado - Ley de la Amazonía)", regimen: "Régimen General" },
};

// ---------------------------------------------------------------- utilidades de montos
const M = (s: string) => Money.desde(s, "PEN");
const igv18 = (base: string) => igvEsperado(M(base), TASA_IGV_18).toString();
const igv10 = (base: string) => igvEsperado(M(base), TASA_IGV_10).toString();

function montos(p: Partial<MontosPlanos>): MontosPlanos {
  const m = { ...cero(), ...p };
  if (p.total === undefined) {
    const { total: _t, ...cols } = m;
    m.total = sumar(Object.values(cols));
  }
  return m;
}

/** Compra gravada al 18 % en DG (lo que manda el SIRE por defecto). */
function dg(base: string, extra: Partial<MontosPlanos> = {}): MontosPlanos {
  return montos({ biDg: base, igvDg: igv18(base), ...extra });
}

let correlativo = 0;
function compra(cliente: string, ruc: string, serie: string, numero: string, fecha: string, m: MontosPlanos, tipo = "01"): FilaCompra {
  correlativo += 1;
  return { id: `${cliente}-c${correlativo}`, tipo, serie, numero, fecha, proveedorRuc: ruc, montos: m };
}

function item(descripcion: string, cantidad: string, unidad: string, valor: string, afectacion: XmlItem["afectacion"] = "Gravado", extra: Partial<XmlItem> = {}): XmlItem {
  return {
    descripcion,
    cantidad,
    unidad,
    precioUnitario: valor,
    valor,
    afectacion,
    igv: afectacion === "Gravado" ? igv18(valor) : "0.00",
    isc: "0.00",
    icbper: "0.00",
    ...extra,
  };
}

/** XML coherente con una fila gravada simple (lo que haría MockXmlProvider con UBL sintético). */
function xmlSimple(m: MontosPlanos, items: XmlItem[]): XmlDemo {
  return {
    moneda: "PEN",
    items,
    gravado: sumar([m.biDg, m.biDgng, m.biDng]),
    igv: sumar([m.igvDg, m.igvDgng, m.igvDng]),
    noGravado: m.noGravado,
    isc: m.isc,
    icbper: m.icbper,
    total: m.total,
  };
}

// Glosas típicas por proveedor (para los XML sintéticos).
const GLOSAS: Record<string, [string, string][]> = {
  "20700001050": [["Consumo de energía eléctrica - suministro 0001", "KWH"]],
  "20700001076": [["Servicio de telefonía e internet - plan empresa", "SERV"]],
  "20700001084": [["Petróleo diésel B5", "GAL"], ["Gasohol 90", "GAL"]],
  "20700001092": [["Papel bond A4 x 500 hojas", "PAQ"], ["Tóner para impresora", "UND"], ["Archivadores de palanca", "UND"]],
  "20700001106": [["Alquiler de local comercial - mes", "SERV"]],
  "20700001114": [["Servicio de transporte de mercadería Lima - Huánuco", "SERV"]],
  "20700001122": [["Servicio de agua potable y alcantarillado", "SERV"]],
  "20700001131": [["Fertilizante NPK 20-20-20 saco 50 kg", "SAC"], ["Semillas certificadas", "KG"]],
  "20700001165": [["Pernos hexagonales 1/2\" caja x 100", "CJA"], ["Cemento portland tipo I", "BOL"], ["Tubo PVC 2\"", "UND"]],
  "20700001173": [["Menú ejecutivo", "UND"]],
  "20700001181": [["Licencia anual de software contable", "SERV"]],
  "20700001190": [["Mercadería surtida para reventa", "UND"]],
};

function xmlDeGlosa(ruc: string, m: MontosPlanos): XmlDemo {
  const g = GLOSAS[ruc]?.[0] ?? ["Bienes y servicios varios", "UND"];
  return xmlSimple(m, [item(g[0], "1", g[1], sumar([m.biDg, m.biDgng, m.biDng]))]);
}

// ---------------------------------------------------------------- propuestas por cliente
function propuestaC1(): PropuestaSemilla {
  const C = "c1";
  const xml: Record<string, XmlDemo> = {};
  const compras: FilaCompra[] = [];
  const add = (f: FilaCompra, x?: XmlDemo | null) => {
    compras.push(f);
    if (x !== null) xml[f.id] = x ?? xmlDeGlosa(f.proveedorRuc, f.montos);
    return f;
  };

  // Caso San Juan: cerveza con ISC enviada a DG con IGV 0 (regla 7 / R-ISC). El XML lo confirma.
  add(compra(C, "20700000011", "F001", "1040", "2026-10-02", montos({ biDg: "770.00", total: "770.00" })), {
    moneda: "PEN",
    items: [item("Cerveza rubia caja x 12 botellas 620 ml (ISC al valor)", "35", "CJA", "0.00", "Gravado", { precioUnitario: "22.00", isc: "770.00" })],
    gravado: "0.00", igv: "0.00", noGravado: "0.00", isc: "770.00", icbper: "0.00", total: "770.00",
  });
  // Caso mixta (regla 10 / R-MIX): base 21.48 con IGV 1.61. El XML trae el exacto 8.97.
  add(compra(C, "20700000045", "F001", "2056", "2026-10-05", montos({ biDg: "21.48", igvDg: "1.61", total: "23.09" })), {
    moneda: "PEN",
    items: [
      item("Gaseosa 3 L (gravado)", "1", "UND", "8.97", "Gravado", { igv: "1.61" }),
      item("Arroz extra 5 kg (exonerado)", "1", "BOL", "12.51", "Exonerado"),
    ],
    gravado: "8.97", igv: "1.61", noGravado: "12.51", isc: "0.00", icbper: "0.00", total: "23.09",
  });
  // ICBPER correcto: 3 bolsas × 0.50.
  add(compra(C, "20700000053", "F001", "3064", "2026-10-08", dg("100.00", { icbper: "1.50" })), {
    moneda: "PEN",
    items: [
      item("Cajas de cartón corrugado", "50", "UND", "100.00", "Gravado", { precioUnitario: "2.00" }),
      item("Bolsa plástica (ICBPER)", "3", "UND", "0.00", "Gravado", { precioUnitario: "0.00", igv: "0.00", icbper: "1.50" }),
    ],
    gravado: "100.00", igv: "18.00", noGravado: "0.00", isc: "0.00", icbper: "1.50", total: "119.50",
  });
  // Redondeo en dólares (regla 11 / R-RED): USD 0.15 + 0.03 con TC 3.300 → el SIRE manda total 0.59.
  {
    const f = compra(C, "20700000061", "F001", "4062", "2026-10-09", montos({ biDg: "0.50", igvDg: "0.10", total: "0.59" }));
    f.usd = { montos: montos({ biDg: "0.15", igvDg: "0.03", total: "0.18" }), tipoCambio: "3.300" };
    add(f, {
      moneda: "USD",
      tipoCambio: "3.300",
      items: [item("Muestra de insumo importado", "1", "UND", "0.15", "Gravado", { igv: "0.03" })],
      gravado: "0.15", igv: "0.03", noGravado: "0.00", isc: "0.00", icbper: "0.00", total: "0.18",
    });
  }
  // Gasto personal (regla 15 / R-GP + R-NEW): zapatillas en una distribuidora de alimentos.
  add(compra(C, "20700000070", "F001", "5070", "2026-10-11", dg("150.00")), {
    moneda: "PEN",
    items: [item("Par de zapatillas deportivas talla 42", "1", "PAR", "150.00")],
    gravado: "150.00", igv: "27.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", total: "177.00",
  });
  // Proveedor nuevo sin problemas de montos (R-NEW).
  add(compra(C, "20700001181", "E001", "120", "2026-10-15", dg("850.00")));
  // Descuadre de 0.01 (R-RED sin USD) sin XML disponible al primer intento.
  add(compra(C, "20700001092", "F002", "8831", "2026-10-16", montos({ biDg: "254.24", igvDg: "45.76", total: "300.01" })), null);

  // Compras normales del mes.
  const normales: [string, string, string, string, string][] = [
    ["20700001050", "S001", "556201", "2026-10-03", "412.50"],
    ["20700001076", "E001", "33021", "2026-10-04", "169.49"],
    ["20700001084", "F010", "120455", "2026-10-06", "1250.00"],
    ["20700001084", "F010", "120612", "2026-10-13", "980.40"],
    ["20700001084", "F010", "120840", "2026-10-21", "1104.20"],
    ["20700001092", "F002", "8790", "2026-10-07", "320.34"],
    ["20700001106", "E001", "410", "2026-10-01", "3500.00"],
    ["20700001114", "F003", "2210", "2026-10-10", "1800.00"],
    ["20700001114", "F003", "2264", "2026-10-24", "1650.00"],
    ["20700001122", "S002", "99120", "2026-10-12", "96.61"],
    ["20700001165", "F001", "15502", "2026-10-14", "2340.68"],
    ["20700001165", "F001", "15633", "2026-10-22", "715.25"],
    ["20700001173", "B005", "4410", "2026-10-18", "84.75"],
    ["20700001190", "F001", "7740", "2026-10-19", "6420.00"],
    ["20700001190", "F001", "7801", "2026-10-26", "5133.90"],
    ["20700000053", "F001", "3102", "2026-10-25", "210.00"],
    ["20700000045", "F001", "2101", "2026-10-27", "305.08"],
    ["20700001050", "S001", "556999", "2026-10-28", "38.14"],
  ];
  const sinXml = new Set(["20700001173"]);
  for (const [ruc, serie, num, fecha, base] of normales) {
    const f = compra(C, ruc, serie, num, fecha, dg(base));
    add(f, sinXml.has(ruc) ? null : undefined);
  }
  // Una nota de crédito.
  add(compra(C, "20700001165", "FC01", "220", "2026-10-29", montos({ biDg: "-100.00", igvDg: "-18.00", total: "-118.00" }), "07"));

  // Ventas: boletas B001-280…300 sin la 291 (regla 1) y facturas completas.
  const ventas: FilaVenta[] = [];
  let v = 0;
  const venta = (tipo: string, serie: string, numero: number, fecha: string, base: string, doc = "-", nombre = "Clientes varios"): FilaVenta => {
    v += 1;
    const igv = igv18(base);
    return { id: `${C}-v${v}`, tipo, serie, numero: String(numero), fecha, docCliente: doc, nombreCliente: nombre, base, igv, exonerado: "0.00", total: sumar([base, igv]) };
  };
  const bases = ["100.00", "50.00", "84.75", "42.37", "211.86", "63.56", "127.12", "33.90", "76.27", "152.54", "98.31", "45.76", "60.17", "180.51", "29.66", "118.64", "55.08", "72.03", "139.83", "88.98", "47.46"];
  for (let n = 280; n <= 300; n++) {
    if (n === 291) continue;
    const dia = String(1 + Math.floor((n - 280) * 1.4)).padStart(2, "0");
    ventas.push(venta("03", "B001", n, `2026-10-${dia}`, bases[n - 280]!));
  }
  const clientesF: [string, string][] = [
    ["20700001203", "PANADERÍA LA ESPIGA DEMO S.A.C."],
    ["20700001211", "CLÍNICA VETERINARIA DEMO E.I.R.L."],
    ["20700001246", "MINIMARKET LOS OLIVOS DEMO S.A.C."],
  ];
  const basesF = ["4237.29", "1271.19", "8474.58", "2118.64", "3389.83", "6779.66", "1694.92", "5084.75", "2966.10", "7627.12", "1355.93", "4661.02"];
  basesF.forEach((b, i) => {
    const [doc, nom] = clientesF[i % 3]!;
    ventas.push(venta("01", "F001", 1501 + i, `2026-10-${String(2 + i * 2).padStart(2, "0")}`, b, doc, nom));
  });

  const xmlReintento: Record<string, XmlDemo> = {};
  for (const f of compras) {
    if (xml[f.id]) continue;
    xmlReintento[f.id] =
      f.proveedorRuc === "20700001092"
        ? { moneda: "PEN", items: [item("Papel bond A4 x 500 hojas", "40", "PAQ", "254.24", "Gravado", { precioUnitario: "6.36", igv: "45.76" })], gravado: "254.24", igv: "45.76", noGravado: "0.00", isc: "0.00", icbper: "0.00", total: "300.00" }
        : xmlDeGlosa(f.proveedorRuc, f.montos);
  }
  return { compras, ventas, xml, xmlReintento };
}

function propuestaC2(): PropuestaSemilla {
  // Zona selva con ventas exoneradas (regla 3): el SIRE manda todo a DG, pero lo correcto es DNG.
  const C = "c2";
  const xml: Record<string, XmlDemo> = {};
  const compras: FilaCompra[] = [];
  const filas: [string, string, string, string, string][] = [
    ["20700001131", "F001", "3301", "2026-10-02", "4520.00"],
    ["20700001131", "F001", "3355", "2026-10-09", "2780.50"],
    ["20700001131", "F001", "3412", "2026-10-20", "3960.00"],
    ["20700001114", "F003", "2230", "2026-10-05", "2200.00"],
    ["20700001114", "F003", "2290", "2026-10-26", "2450.00"],
    ["20700001084", "F010", "120501", "2026-10-07", "1530.00"],
    ["20700001084", "F010", "120777", "2026-10-18", "1688.14"],
    ["20700001050", "S001", "557100", "2026-10-03", "640.68"],
    ["20700001076", "E001", "33555", "2026-10-04", "127.12"],
    ["20700001165", "F001", "15580", "2026-10-15", "1310.17"],
    ["20700001092", "F002", "8850", "2026-10-17", "211.86"],
    ["20700001181", "E001", "131", "2026-10-22", "850.00"],
  ];
  for (const [ruc, serie, num, fecha, base] of filas) {
    const f = compra(C, ruc, serie, num, fecha, dg(base));
    compras.push(f);
    xml[f.id] = xmlDeGlosa(ruc, f.montos);
  }
  // Cerveza para evento de la empresa con ISC mal ubicado y SIN XML todavía (R-ISC requiere confirmación).
  const f = compra(C, "20700000011", "F001", "1102", "2026-10-28", montos({ biDg: "440.00", total: "440.00" }));
  compras.push(f);
  const xmlReintento: Record<string, XmlDemo> = {
    [f.id]: { moneda: "PEN", items: [item("Cerveza rubia caja x 12 (evento de fin de campaña, ISC al valor)", "20", "CJA", "0.00", "Gravado", { precioUnitario: "22.00", isc: "440.00" })], gravado: "0.00", igv: "0.00", noGravado: "0.00", isc: "440.00", icbper: "0.00", total: "440.00" },
  };

  const ventas: FilaVenta[] = [];
  const basesV = ["12500.00", "8340.00", "15200.00", "6780.00", "9900.00", "11250.00", "7420.00", "13300.00"];
  basesV.forEach((b, i) => {
    ventas.push({
      id: `${C}-v${i + 1}`,
      tipo: "01",
      serie: "F001",
      numero: String(801 + i),
      fecha: `2026-10-${String(3 + i * 3).padStart(2, "0")}`,
      docCliente: i % 2 ? "20700001246" : "20700001254",
      nombreCliente: i % 2 ? "MINIMARKET LOS OLIVOS DEMO S.A.C." : "FRUTAS DEL CENTRO DEMO S.A.C.",
      base: "0.00",
      igv: "0.00",
      exonerado: b,
      total: b,
    });
  });
  return { compras, ventas, xml, xmlReintento };
}

function propuestaC3(): PropuestaSemilla {
  const C = "c3";
  const xml: Record<string, XmlDemo> = {};
  const compras: FilaCompra[] = [];
  const filas: [string, string, string, string, string][] = [
    ["20700001165", "F001", "15510", "2026-10-02", "5084.75"],
    ["20700001165", "F001", "15590", "2026-10-12", "3220.34"],
    ["20700001165", "F001", "15660", "2026-10-25", "4410.17"],
    ["20700001114", "F003", "2241", "2026-10-06", "750.00"],
    ["20700001050", "S001", "558300", "2026-10-04", "298.31"],
    ["20700001076", "E001", "34001", "2026-10-05", "110.17"],
    ["20700001092", "F002", "8811", "2026-10-09", "145.76"],
  ];
  for (const [ruc, serie, num, fecha, base] of filas) {
    const f = compra(C, ruc, serie, num, fecha, dg(base));
    compras.push(f);
    xml[f.id] = xmlDeGlosa(ruc, f.montos);
  }
  // Restaurante al 10 % (régimen MYPE de restaurantes): cuadra con 10 %, no dispara R-MIX.
  const r = compra(C, "20700001173", "B005", "4502", "2026-10-19", montos({ biDg: "180.00", igvDg: igv10("180.00") }));
  compras.push(r);
  xml[r.id] = xmlSimple(r.montos, [item("Almuerzo de trabajo con proveedores", "4", "UND", "180.00", "Gravado", { igv: igv10("180.00"), precioUnitario: "45.00" })]);
  const ventas: FilaVenta[] = [];
  for (let n = 3401; n <= 3418; n++) {
    const base = ["254.24", "84.75", "1271.19", "42.37", "635.59"][n % 5]!;
    const igv = igv18(base);
    ventas.push({ id: `${C}-v${n}`, tipo: "03", serie: "B002", numero: String(n), fecha: `2026-10-${String(1 + (n - 3401)).padStart(2, "0")}`, docCliente: "-", nombreCliente: "Clientes varios", base, igv, exonerado: "0.00", total: sumar([base, igv]) });
  }
  return { compras, ventas, xml, xmlReintento: {} };
}

function propuestaC4(): PropuestaSemilla {
  // Transportista con ventas gravadas y exoneradas: alquiler del local secundario va a DGNG (regla 4).
  const C = "c4";
  const xml: Record<string, XmlDemo> = {};
  const compras: FilaCompra[] = [];
  const filas: [string, string, string, string, string][] = [
    ["20700001084", "F010", "121001", "2026-10-02", "5600.00"],
    ["20700001084", "F010", "121150", "2026-10-11", "6120.34"],
    ["20700001084", "F010", "121388", "2026-10-23", "5890.00"],
    ["20700001106", "E001", "455", "2026-10-01", "2800.00"],
    ["20700001106", "E001", "456", "2026-10-01", "1500.00"],
    ["20700001050", "S001", "559010", "2026-10-06", "355.93"],
    ["20700001165", "F001", "15601", "2026-10-14", "980.00"],
    ["20700001076", "E001", "34120", "2026-10-05", "211.02"],
  ];
  for (const [ruc, serie, num, fecha, base] of filas) {
    const f = compra(C, ruc, serie, num, fecha, dg(base));
    compras.push(f);
    xml[f.id] = xmlDeGlosa(ruc, f.montos);
  }
  // Mercadería para ventas gravadas y exoneradas a la vez, mixta SIN XML: R-MIX pide confirmar el gravado.
  const mx = compra(C, "20700001190", "F001", "7811", "2026-10-20", montos({ biDg: "1500.00", igvDg: "171.00" }));
  compras.push(mx);
  const xmlReintento: Record<string, XmlDemo> = {
    [mx.id]: {
      moneda: "PEN",
      items: [item("Repuestos y filtros para camión (gravado)", "1", "LOTE", "950.00"), item("Llantas para transporte de pasajeros (exonerado)", "2", "UND", "550.00", "Exonerado", { precioUnitario: "275.00" })],
      gravado: "950.00", igv: "171.00", noGravado: "550.00", isc: "0.00", icbper: "0.00", total: "1671.00",
    },
  };
  const ventas: FilaVenta[] = [];
  for (let i = 0; i < 10; i++) {
    const gravada = i % 3 !== 0;
    const b = ["3200.00", "4150.00", "2780.00", "5100.00", "3940.00"][i % 5]!;
    const igv = gravada ? igv18(b) : "0.00";
    ventas.push({ id: `${C}-v${i}`, tipo: "01", serie: "F002", numero: String(601 + i), fecha: `2026-10-${String(2 + i * 2).padStart(2, "0")}`, docCliente: "20700001262", nombreCliente: "LOGÍSTICA DEL SUR DEMO S.A.C.", base: gravada ? b : "0.00", igv, exonerado: gravada ? "0.00" : b, total: sumar([b, igv]) });
  }
  return { compras, ventas, xml, xmlReintento };
}

function propuestaC5(): PropuestaSemilla {
  const C = "c5";
  const compras = [compra(C, "20700001190", "F001", "7750", "2026-10-08", dg("1200.00")), compra(C, "20700001050", "S001", "559500", "2026-10-09", dg("84.75"))];
  const xml: Record<string, XmlDemo> = {};
  for (const f of compras) xml[f.id] = xmlDeGlosa(f.proveedorRuc, f.montos);
  return { compras, ventas: [], xml, xmlReintento: {} };
}

export function propuestaDe(clienteId: string): PropuestaSemilla {
  correlativo = 0;
  switch (clienteId) {
    case "c1":
      return propuestaC1();
    case "c2":
      return propuestaC2();
    case "c3":
      return propuestaC3();
    case "c4":
      return propuestaC4();
    default:
      return propuestaC5();
  }
}

/**
 * Historial de clasificación por cliente y proveedor (meses anteriores). Las claves son los
 * "proveedores conocidos" del cliente para R-NEW; el valor, cómo se clasificó.
 */
export const HISTORIAL: Record<string, Record<string, { periodo: string; destino: "DG" | "DGNG" | "DNG" }[]>> = {
  c1: Object.fromEntries(
    ["20700000011", "20700000045", "20700000053", "20700000061", "20700001050", "20700001076", "20700001084", "20700001092", "20700001106", "20700001114", "20700001122", "20700001165", "20700001173", "20700001190"].map((r) => [
      r,
      [
        { periodo: "202609", destino: "DG" as const },
        { periodo: "202608", destino: "DG" as const },
      ],
    ]),
  ),
  c2: Object.fromEntries(
    ["20700001131", "20700001114", "20700001084", "20700001050", "20700001076", "20700001165", "20700001092", "20700000011"].map((r) => [
      r,
      [
        { periodo: "202609", destino: "DNG" as const },
        { periodo: "202608", destino: "DNG" as const },
      ],
    ]),
  ),
  c3: Object.fromEntries(["20700001165", "20700001114", "20700001050", "20700001076", "20700001092", "20700001173"].map((r) => [r, [{ periodo: "202609", destino: "DG" as const }]])),
  c4: Object.fromEntries(
    ["20700001084", "20700001106", "20700001050", "20700001165", "20700001076", "20700001190"].map((r) => [
      r,
      [{ periodo: "202609", destino: r === "20700001106" ? ("DGNG" as const) : ("DG" as const) }],
    ]),
  ),
  c5: {},
};

/** Reglas aprendidas (Smart Mapping, R2) por cliente. */
export const APRENDIDAS: Record<string, Aprendida[]> = {
  c2: ["20700001131", "20700001114", "20700001084", "20700001050", "20700001076", "20700001165", "20700001092"].map((r, i) => ({ proveedorRuc: r, destino: "DNG", aplicada: 6 + i, aceptada: 6 + i, activa: true })),
  c4: [{ proveedorRuc: "20700001106", destino: "DGNG", aplicada: 4, aceptada: 4, activa: true }],
};

export const MENSAJES: Mensaje[] = [
  { id: "m1", clienteId: "c1", buzon: "SOL", asunto: "Resolución de Ejecución Coactiva N.° 023-006-DEMO", tipo: "Cobranza coactiva", fecha: "2026-11-05T09:12:00", leidoSunat: false, critico: true, contenido: "Se le notifica el inicio del procedimiento de cobranza coactiva por la deuda tributaria ficticia contenida en la orden de pago 023-001-DEMO. Plazo: 7 días hábiles.", adjunto: "REC-023-006-DEMO.pdf" },
  { id: "m2", clienteId: "c1", buzon: "SOL", asunto: "Constancia de presentación PDT 621 - periodo 2026-09", tipo: "Comunicado", fecha: "2026-10-14T18:40:00", leidoSunat: true, critico: false, contenido: "Constancia de presentación de la declaración mensual del periodo 2026-09 (dato ficticio)." },
  { id: "m3", clienteId: "c2", buzon: "Notificaciones SUNAT", asunto: "Requerimiento N.° 0222-DEMO - Fiscalización parcial IGV", tipo: "Requerimiento de fiscalización", fecha: "2026-11-04T11:05:00", leidoSunat: false, critico: true, contenido: "Se requiere sustentar el crédito fiscal del periodo 2026-06. Presentar registro de compras y comprobantes (requerimiento ficticio).", adjunto: "REQ-0222-DEMO.pdf" },
  { id: "m4", clienteId: "c3", buzon: "SOL", asunto: "Resolución de Multa N.° 054-002-DEMO", tipo: "Resolución de multa", fecha: "2026-11-02T16:30:00", leidoSunat: false, critico: true, contenido: "Multa por presentar la declaración fuera de plazo (infracción ficticia).", adjunto: "RM-054-002-DEMO.pdf" },
  { id: "m5", clienteId: "c3", buzon: "SOL", asunto: "Aviso: actualiza tu información en el RUC", tipo: "Notificación", fecha: "2026-10-28T08:00:00", leidoSunat: true, critico: false, contenido: "Recuerde mantener actualizado su domicilio fiscal (aviso ficticio)." },
  { id: "m6", clienteId: "c4", buzon: "SOL", asunto: "Resolución de Determinación N.° 012-003-DEMO", tipo: "Resolución de determinación", fecha: "2026-11-01T10:20:00", leidoSunat: false, critico: true, contenido: "Se determina una omisión de IGV por el periodo 2026-03 (dato ficticio).", adjunto: "RD-012-003-DEMO.pdf" },
  { id: "m7", clienteId: "c4", buzon: "Notificaciones SUNAT", asunto: "Cronograma de obligaciones 2027", tipo: "Comunicado", fecha: "2026-10-30T12:00:00", leidoSunat: false, critico: false, contenido: "Se publica el cronograma de vencimientos (comunicado ficticio)." },
  { id: "m8", clienteId: "c2", buzon: "SOL", asunto: "Constancia de presentación SIRE - Registro de Ventas 2026-09", tipo: "Comunicado", fecha: "2026-10-12T19:15:00", leidoSunat: true, critico: false, contenido: "Constancia de generación del RVIE (dato ficticio)." },
];

/** Montos declarados (PDT 621) de los últimos 12 meses, para la prorrata (R2). */
export const PRORRATA: Record<string, MesProrrata[]> = {
  c4: [
    ["202510", "41200.00", "15600.00"],
    ["202511", "39850.00", "17200.00"],
    ["202512", "52300.00", "21400.00"],
    ["202601", "38900.00", "14800.00"],
    ["202602", "36700.00", "16100.00"],
    ["202603", "44500.00", "18900.00"],
    ["202604", "42100.00", "17500.00"],
    ["202605", "45800.00", "19300.00"],
    ["202606", "47200.00", "18100.00"],
    ["202607", "43900.00", "16900.00"],
    ["202608", "46300.00", "17800.00"],
    ["202609", "", ""],
  ].map(([periodo, gravadas, noGravadas]) => ({
    periodo: periodo!,
    gravadas: gravadas!,
    noGravadas: noGravadas!,
    origen: "Declarado (PDT 621)" as const,
  })),
  c1: [
    "202510", "202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609",
  ].map((periodo, i) => ({
    periodo,
    gravadas: ["98500.00", "102300.00", "135800.00", "88400.00", "91200.00", "97600.00", "99100.00", "104500.00", "101800.00", "108900.00", "110200.00", "106700.00"][i]!,
    noGravadas: ["2100.00", "1850.00", "3400.00", "1500.00", "1720.00", "1980.00", "2050.00", "2240.00", "1990.00", "2310.00", "2400.00", "2180.00"][i]!,
    origen: "Declarado (PDT 621)" as const,
  })),
};
