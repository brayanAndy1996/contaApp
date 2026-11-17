// Spec 023, T1 (CA-3, CA-6, P-5): plan de captura por página y decisión de aviso.
// Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  DIAS_AVISO_PRIMERA_SINCRONIZACION,
  MAX_PAGINAS_CAPTURA,
  TOPE_MENSAJES_CAPTURA,
  debeAvisar,
  planificarCaptura,
  type EstadoCaptura,
  type MensajeListado,
  type PaginaListado,
} from "./index";

const msg = (n: number, leido = false): MensajeListado => ({
  idSunat: `m${String(n).padStart(4, "0")}`,
  asunto: `Asunto ${n}`,
  remitente: "SUNAT",
  fecha: new Date(Date.UTC(2026, 10, 17) - n * 3_600_000).toISOString(),
  codigoTipo: null,
  leidoEnSunat: leido,
  adjuntos: [],
});

const estado = (e: Partial<EstadoCaptura> = {}): EstadoCaptura => ({
  cursorPendiente: null,
  cursorActual: null,
  nuevosAcumulados: 0,
  paginasLeidas: 0,
  ...e,
});

const pagina = (
  desde: number,
  hasta: number,
  siguiente: string | null,
): PaginaListado => ({
  mensajes: Array.from({ length: hasta - desde + 1 }, (_, i) => msg(desde + i)),
  siguiente,
});

describe("constantes de captura", () => {
  it("200 mensajes nuevos y 20 páginas por captura", () => {
    expect(TOPE_MENSAJES_CAPTURA).toBe(200);
    expect(MAX_PAGINAS_CAPTURA).toBe(20);
    expect(DIAS_AVISO_PRIMERA_SINCRONIZACION).toBe(30);
  });
});

describe("planificarCaptura: una página", () => {
  it("todo nuevo y hay más páginas: sigue con el cursor siguiente", () => {
    const r = planificarCaptura(estado(), pagina(1, 3, "c2"), new Set());
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["m0001", "m0002", "m0003"]);
    expect(r.actualizar).toEqual([]);
    expect(r.siguienteCursor).toBe("c2");
    expect(r.terminada).toBe(false);
    expect(r.sincronizado).toBe(false);
  });

  it("última página (sin siguiente): termina y queda sincronizado, sin pendiente", () => {
    const r = planificarCaptura(estado(), pagina(1, 3, null), new Set());
    expect(r.nuevos).toHaveLength(3);
    expect(r.siguienteCursor).toBeNull();
    expect(r.terminada).toBe(true);
    expect(r.sincronizado).toBe(true);
  });

  it("buzón vacío: termina y queda sincronizado", () => {
    const r = planificarCaptura(
      estado(),
      { mensajes: [], siguiente: null },
      new Set(),
    );
    expect(r.nuevos).toEqual([]);
    expect(r.terminada).toBe(true);
    expect(r.sincronizado).toBe(true);
  });

  it("los nuevos conservan el orden de lo reciente a lo antiguo y los mismos datos", () => {
    const p = pagina(1, 4, null);
    const r = planificarCaptura(estado(), p, new Set());
    expect(r.nuevos).toEqual(p.mensajes);
  });
});

describe("planificarCaptura: conocidos", () => {
  it("los conocidos solo actualizan el leído en SUNAT", () => {
    const p: PaginaListado = {
      mensajes: [msg(1), msg(2, true), msg(3)],
      siguiente: "c2",
    };
    const r = planificarCaptura(
      estado({ cursorPendiente: "pend" }),
      p,
      new Set(["m0002"]),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["m0001", "m0003"]);
    expect(r.actualizar).toEqual([{ idSunat: "m0002", leidoEnSunat: true }]);
  });

  it("sin pendiente, se detiene en el primer conocido y no avanza más", () => {
    const p: PaginaListado = {
      mensajes: [msg(1), msg(2), msg(3, true), msg(4)],
      siguiente: "c2",
    };
    const r = planificarCaptura(estado(), p, new Set(["m0003"]));
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["m0001", "m0002"]);
    expect(r.actualizar).toEqual([{ idSunat: "m0003", leidoEnSunat: true }]);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBeNull();
  });

  it("sin pendiente, una página de puros conocidos termina sin nuevos", () => {
    const r = planificarCaptura(
      estado(),
      pagina(1, 3, "c2"),
      new Set(["m0001", "m0002", "m0003"]),
    );
    expect(r.nuevos).toEqual([]);
    expect(r.actualizar.map((a) => a.idSunat)).toEqual(["m0001"]);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBeNull();
  });

  it("con cursor pendiente (relleno) sigue más allá del primer conocido", () => {
    const conocidos = new Set(["m0001", "m0002", "m0003"]);
    const r = planificarCaptura(
      estado({ cursorPendiente: "pend" }),
      pagina(1, 3, "c2"),
      conocidos,
    );
    expect(r.nuevos).toEqual([]);
    expect(r.actualizar.map((a) => a.idSunat)).toEqual([
      "m0001",
      "m0002",
      "m0003",
    ]);
    expect(r.terminada).toBe(false);
    expect(r.siguienteCursor).toBe("c2");
  });

  it("en el relleno, llegar al final deja el cliente sincronizado y sin pendiente", () => {
    const r = planificarCaptura(
      estado({ cursorPendiente: "pend" }),
      pagina(401, 450, null),
      new Set(),
    );
    expect(r.nuevos).toHaveLength(50);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBeNull();
    expect(r.sincronizado).toBe(true);
  });
});

describe("planificarCaptura: cortes", () => {
  it("corta al llegar a 200 nuevos y guarda el cursor de la página siguiente", () => {
    const r = planificarCaptura(
      estado({ nuevosAcumulados: 100 }),
      pagina(101, 200, "c3"),
      new Set(),
    );
    expect(r.nuevos).toHaveLength(100);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBe("c3");
    expect(r.sincronizado).toBe(false);
  });

  it("con 200 nuevos justo al final del buzón, termina sincronizado y sin pendiente", () => {
    const r = planificarCaptura(
      estado({ nuevosAcumulados: 100 }),
      pagina(101, 200, null),
      new Set(),
    );
    expect(r.nuevos).toHaveLength(100);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBeNull();
    expect(r.sincronizado).toBe(true);
  });

  it("199 nuevos acumulados y una página de 3: acepta solo 1 y vuelve a leer esa página la próxima vez", () => {
    const r = planificarCaptura(
      estado({ nuevosAcumulados: 199, cursorActual: "c-actual" }),
      pagina(200, 202, "c-sig"),
      new Set(),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["m0200"]);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBe("c-actual");
    expect(r.sincronizado).toBe(false);
  });

  it("nunca acepta más de 200 nuevos en total", () => {
    const r = planificarCaptura(
      estado({ nuevosAcumulados: 150 }),
      pagina(151, 400, "c9"),
      new Set(),
    );
    expect(150 + r.nuevos.length).toBe(TOPE_MENSAJES_CAPTURA);
  });

  it("corta al leer la página 20 y guarda el cursor siguiente", () => {
    const r = planificarCaptura(
      estado({
        paginasLeidas: MAX_PAGINAS_CAPTURA - 1,
        cursorPendiente: "pend",
      }),
      pagina(1, 3, "c21"),
      new Set(["m0001", "m0002", "m0003"]),
    );
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBe("c21");
    expect(r.sincronizado).toBe(false);
  });

  it("en la página 19 todavía sigue", () => {
    const r = planificarCaptura(
      estado({
        paginasLeidas: MAX_PAGINAS_CAPTURA - 2,
        cursorPendiente: "pend",
      }),
      pagina(1, 3, "c20"),
      new Set(["m0001", "m0002", "m0003"]),
    );
    expect(r.terminada).toBe(false);
    expect(r.siguienteCursor).toBe("c20");
  });

  it("la página 20 que es la última del buzón termina sincronizada", () => {
    const r = planificarCaptura(
      estado({ paginasLeidas: MAX_PAGINAS_CAPTURA - 1 }),
      pagina(1, 3, null),
      new Set(),
    );
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBeNull();
    expect(r.sincronizado).toBe(true);
  });
});

describe("planificarCaptura: 450 mensajes en tres capturas (CA-3)", () => {
  const TOTAL = 450;
  const buzon = Array.from({ length: TOTAL }, (_, i) => msg(i + 1));

  /** Una captura completa: pide páginas desde la primera hasta que el plan termine. */
  function capturar(
    tamanoPagina: number,
    conocidos: Set<string>,
    cursorPendiente: string | null,
  ) {
    const guardados: string[] = [];
    let pos = 0;
    let acumulados = 0;
    let paginas = 0;
    for (let guardia = 0; guardia < 100; guardia++) {
      const mensajes = buzon.slice(pos, pos + tamanoPagina);
      const siguiente =
        pos + tamanoPagina < TOTAL ? `pos:${pos + tamanoPagina}` : null;
      const r = planificarCaptura(
        {
          cursorPendiente,
          cursorActual: pos === 0 ? null : `pos:${pos}`,
          nuevosAcumulados: acumulados,
          paginasLeidas: paginas,
        },
        { mensajes, siguiente },
        conocidos,
      );
      for (const m of r.nuevos) {
        guardados.push(m.idSunat);
        conocidos.add(m.idSunat);
      }
      acumulados += r.nuevos.length;
      paginas += 1;
      if (r.terminada) {
        return {
          guardados,
          pendiente: r.siguienteCursor,
          sincronizado: r.sincronizado,
          paginas,
        };
      }
      if (r.siguienteCursor === null)
        throw new Error("sin cursor y sin terminar");
      pos = Number(r.siguienteCursor.split(":")[1]);
    }
    throw new Error("la captura no termina");
  }

  it.each([100, 70, 33])(
    "páginas de %i: 200, 200 y 50, sin huecos ni duplicados",
    (tamano) => {
      const conocidos = new Set<string>();
      const c1 = capturar(tamano, conocidos, null);
      expect(c1.guardados).toHaveLength(200);
      expect(c1.sincronizado).toBe(false);
      expect(c1.pendiente).not.toBeNull();

      const c2 = capturar(tamano, conocidos, c1.pendiente);
      expect(c2.guardados).toHaveLength(200);
      expect(c2.sincronizado).toBe(false);
      expect(c2.pendiente).not.toBeNull();

      const c3 = capturar(tamano, conocidos, c2.pendiente);
      expect(c3.guardados).toHaveLength(50);
      expect(c3.sincronizado).toBe(true);
      expect(c3.pendiente).toBeNull();

      const todos = [...c1.guardados, ...c2.guardados, ...c3.guardados];
      expect(new Set(todos).size).toBe(TOTAL);
      expect(todos).toEqual(buzon.map((m) => m.idSunat));
      for (const c of [c1, c2, c3])
        expect(c.paginas).toBeLessThanOrEqual(MAX_PAGINAS_CAPTURA);
    },
  );

  it("repetir la captura sobre un buzón ya sincronizado no guarda nada nuevo", () => {
    const conocidos = new Set(buzon.map((m) => m.idSunat));
    const c = capturar(100, conocidos, null);
    expect(c.guardados).toEqual([]);
    expect(c.pendiente).toBeNull();
  });
});

describe("debeAvisar (CA-6, P-5)", () => {
  const ahora = new Date("2026-11-17T15:00:00Z");
  const hace = (dias: number, extraMs = 0) =>
    new Date(ahora.getTime() - dias * 86_400_000 + extraMs);

  describe("primera sincronización (sincronizadoEn = null)", () => {
    it("crítico de hace 29 días: avisa", () => {
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(29),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(true);
    });
    it("crítico de hace 31 días: no avisa", () => {
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(31),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(false);
    });
    it("crítico de hace exactamente 30 días: avisa (fecha >= ahora − 30 días)", () => {
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(30),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(true);
    });
    it("un milisegundo más antiguo que 30 días: no avisa", () => {
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(30, -1),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(false);
    });
    it("crítico de hoy y con fecha futura (desfase de reloj): avisa", () => {
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(0),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(true);
      expect(
        debeAvisar({
          critico: true,
          fecha: hace(-1),
          sincronizadoEn: null,
          ahora,
        }),
      ).toBe(true);
    });
  });

  describe("cliente ya sincronizado", () => {
    const sincronizadoEn = new Date("2026-10-01T00:00:00Z");
    it("avisa siempre un crítico, aunque la fecha sea muy antigua", () => {
      expect(
        debeAvisar({ critico: true, fecha: hace(400), sincronizadoEn, ahora }),
      ).toBe(true);
      expect(
        debeAvisar({ critico: true, fecha: hace(1), sincronizadoEn, ahora }),
      ).toBe(true);
    });
  });

  describe("no crítico", () => {
    it("nunca avisa, sincronizado o no, reciente o antiguo", () => {
      const sincronizadoEn = new Date("2026-10-01T00:00:00Z");
      for (const sinc of [null, sincronizadoEn]) {
        for (const dias of [0, 1, 29, 31, 400]) {
          expect(
            debeAvisar({
              critico: false,
              fecha: hace(dias),
              sincronizadoEn: sinc,
              ahora,
            }),
          ).toBe(false);
        }
      }
    });
  });
});
