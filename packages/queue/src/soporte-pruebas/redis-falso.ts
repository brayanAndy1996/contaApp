// Soporte de pruebas unitarias de `queue` (no se publica: excluido de tsconfig.build.json).
// Redis en memoria con la semantica de ioredis para los comandos que usan el despachador, el
// encolado y los arriendos (cadenas, conjuntos, ZSET, SET NX PX, pub/sub y multi/pipeline).
// Los vencimientos (PX/EX/pexpire) los gobierna el RelojFalso. NO soporta Lua (eval/evalsha): las
// unitarias solo deben usar estos comandos; lo demas se prueba en `*.int.spec.ts` con Redis real.
// Si el despachador necesita otro comando simple, se agrega aqui (sin cambiar las pruebas).
interface Reloj {
  ms(): number;
}

type Entrada =
  | { t: "str"; v: string; exp: number | null }
  | { t: "set"; v: Set<string>; exp: number | null }
  | { t: "zset"; v: Map<string, number>; exp: number | null };

const COMANDOS = [
  "get",
  "set",
  "del",
  "exists",
  "pexpire",
  "pttl",
  "incr",
  "sadd",
  "srem",
  "smembers",
  "scard",
  "sismember",
  "zadd",
  "zrem",
  "zrange",
  "zrangebyscore",
  "zcount",
  "zcard",
  "zscore",
  "zremrangebyscore",
  "publish",
  "time",
] as const;

const limite = (txt: string | number): { valor: number; excl: boolean } => {
  const s = String(txt);
  if (s === "+inf") return { valor: Infinity, excl: false };
  if (s === "-inf") return { valor: -Infinity, excl: false };
  return s.startsWith("(")
    ? { valor: Number(s.slice(1)), excl: true }
    : { valor: Number(s), excl: false };
};

export class RedisFalso {
  private datos = new Map<string, Entrada>();
  /** Mensajes publicados por `publish`, en orden. */
  readonly publicados: { canal: string; mensaje: string }[] = [];
  /** Cantidad de comandos recibidos (incluye los que fallaron). */
  comandos = 0;
  private error: Error | null = null;

  constructor(private readonly reloj: Reloj) {}

  /** Hace que TODO comando rechace con `e` (simula Redis caido); `null` lo restablece. */
  fallar(e: Error | null): void {
    this.error = e;
  }

  /** Claves vivas (para comprobar que no queda nada de un prefijo). */
  claves(): string[] {
    return [...this.datos.keys()].filter((k) => this.vivo(k) !== undefined);
  }

  private vivo(k: string): Entrada | undefined {
    const e = this.datos.get(k);
    if (e === undefined) return undefined;
    if (e.exp !== null && e.exp <= this.reloj.ms()) {
      this.datos.delete(k);
      return undefined;
    }
    return e;
  }

  private conjunto(k: string, crear: boolean): Set<string> | undefined {
    const e = this.vivo(k);
    if (e === undefined) {
      if (!crear) return undefined;
      const nuevo = new Set<string>();
      this.datos.set(k, { t: "set", v: nuevo, exp: null });
      return nuevo;
    }
    if (e.t !== "set") throw new Error("WRONGTYPE");
    return e.v;
  }

  private zset(k: string, crear: boolean): Map<string, number> | undefined {
    const e = this.vivo(k);
    if (e === undefined) {
      if (!crear) return undefined;
      const nuevo = new Map<string, number>();
      this.datos.set(k, { t: "zset", v: nuevo, exp: null });
      return nuevo;
    }
    if (e.t !== "zset") throw new Error("WRONGTYPE");
    return e.v;
  }

  private vaciar(k: string): void {
    const e = this.datos.get(k);
    if (e !== undefined && e.t !== "str" && e.v.size === 0)
      this.datos.delete(k);
  }

  private ordenados(k: string): [string, number][] {
    const z = this.zset(k, false);
    return z === undefined
      ? []
      : [...z.entries()].sort(
          (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
        );
  }

  // --- cadenas ---
  async get(k: string): Promise<string | null> {
    return this.ejecutar(() => {
      const e = this.vivo(k);
      if (e === undefined) return null;
      if (e.t !== "str") throw new Error("WRONGTYPE");
      return e.v;
    });
  }

  async set(
    k: string,
    v: string | number,
    ...args: (string | number)[]
  ): Promise<"OK" | null> {
    return this.ejecutar(() => {
      let exp: number | null = null;
      let nx = false;
      let xx = false;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === "PX") exp = this.reloj.ms() + Number(args[++i]);
        else if (a === "EX") exp = this.reloj.ms() + Number(args[++i]) * 1000;
        else if (a === "NX") nx = true;
        else if (a === "XX") xx = true;
      }
      const existe = this.vivo(k) !== undefined;
      if ((nx && existe) || (xx && !existe)) return null;
      this.datos.set(k, { t: "str", v: String(v), exp });
      return "OK";
    });
  }

  async del(...ks: string[]): Promise<number> {
    return this.ejecutar(
      () =>
        ks.filter((k) => this.vivo(k) !== undefined && this.datos.delete(k))
          .length,
    );
  }

  async exists(...ks: string[]): Promise<number> {
    return this.ejecutar(
      () => ks.filter((k) => this.vivo(k) !== undefined).length,
    );
  }

  async pexpire(k: string, ms: number): Promise<0 | 1> {
    return this.ejecutar(() => {
      const e = this.vivo(k);
      if (e === undefined) return 0;
      e.exp = this.reloj.ms() + Number(ms);
      return 1;
    });
  }

  async pttl(k: string): Promise<number> {
    return this.ejecutar(() => {
      const e = this.vivo(k);
      if (e === undefined) return -2;
      return e.exp === null ? -1 : e.exp - this.reloj.ms();
    });
  }

  async incr(k: string): Promise<number> {
    return this.ejecutar(() => {
      const e = this.vivo(k);
      const n = e === undefined ? 1 : Number((e as { v: string }).v) + 1;
      this.datos.set(k, { t: "str", v: String(n), exp: e?.exp ?? null });
      return n;
    });
  }

  // --- conjuntos ---
  async sadd(k: string, ...ms: string[]): Promise<number> {
    return this.ejecutar(() => {
      const s = this.conjunto(k, true)!;
      let n = 0;
      for (const m of ms) {
        if (!s.has(m)) {
          s.add(m);
          n++;
        }
      }
      return n;
    });
  }

  async srem(k: string, ...ms: string[]): Promise<number> {
    return this.ejecutar(() => {
      const s = this.conjunto(k, false);
      if (s === undefined) return 0;
      const n = ms.filter((m) => s.delete(m)).length;
      this.vaciar(k);
      return n;
    });
  }

  async smembers(k: string): Promise<string[]> {
    return this.ejecutar(() => [...(this.conjunto(k, false) ?? [])]);
  }

  async scard(k: string): Promise<number> {
    return this.ejecutar(() => this.conjunto(k, false)?.size ?? 0);
  }

  async sismember(k: string, m: string): Promise<0 | 1> {
    return this.ejecutar(() => (this.conjunto(k, false)?.has(m) ? 1 : 0));
  }

  // --- conjuntos ordenados ---
  async zadd(k: string, ...args: (string | number)[]): Promise<number> {
    return this.ejecutar(() => {
      const z = this.zset(k, true)!;
      let n = 0;
      let i = 0;
      while (
        ["NX", "XX", "GT", "LT", "CH"].includes(String(args[i]).toUpperCase())
      )
        i++;
      for (; i + 1 < args.length; i += 2) {
        const miembro = String(args[i + 1]);
        if (!z.has(miembro)) n++;
        z.set(miembro, Number(args[i]));
      }
      return n;
    });
  }

  async zrem(k: string, ...ms: string[]): Promise<number> {
    return this.ejecutar(() => {
      const z = this.zset(k, false);
      if (z === undefined) return 0;
      const n = ms.filter((m) => z.delete(m)).length;
      this.vaciar(k);
      return n;
    });
  }

  async zrange(
    k: string,
    ini: number,
    fin: number,
    conPuntajes?: string,
  ): Promise<string[]> {
    return this.ejecutar(() => {
      const todos = this.ordenados(k);
      const desde =
        Number(ini) < 0 ? Math.max(todos.length + Number(ini), 0) : Number(ini);
      const hasta = Number(fin) < 0 ? todos.length + Number(fin) : Number(fin);
      const parte = todos.slice(desde, hasta + 1);
      return String(conPuntajes ?? "").toUpperCase() === "WITHSCORES"
        ? parte.flatMap(([m, p]) => [m, String(p)])
        : parte.map(([m]) => m);
    });
  }

  async zrangebyscore(
    k: string,
    min: string | number,
    max: string | number,
  ): Promise<string[]> {
    return this.ejecutar(() => this.entre(k, min, max).map(([m]) => m));
  }

  async zcount(
    k: string,
    min: string | number,
    max: string | number,
  ): Promise<number> {
    return this.ejecutar(() => this.entre(k, min, max).length);
  }

  async zcard(k: string): Promise<number> {
    return this.ejecutar(() => this.zset(k, false)?.size ?? 0);
  }

  async zscore(k: string, m: string): Promise<string | null> {
    return this.ejecutar(() => {
      const p = this.zset(k, false)?.get(m);
      return p === undefined ? null : String(p);
    });
  }

  async zremrangebyscore(
    k: string,
    min: string | number,
    max: string | number,
  ): Promise<number> {
    return this.ejecutar(() => {
      const z = this.zset(k, false);
      if (z === undefined) return 0;
      const fuera = this.entre(k, min, max);
      for (const [m] of fuera) z.delete(m);
      this.vaciar(k);
      return fuera.length;
    });
  }

  private entre(
    k: string,
    min: string | number,
    max: string | number,
  ): [string, number][] {
    const a = limite(min);
    const b = limite(max);
    return this.ordenados(k).filter(
      ([, p]) =>
        (a.excl ? p > a.valor : p >= a.valor) &&
        (b.excl ? p < b.valor : p <= b.valor),
    );
  }

  // --- pub/sub ---
  async publish(canal: string, mensaje: string): Promise<number> {
    return this.ejecutar(() => {
      this.publicados.push({ canal, mensaje });
      return 0;
    });
  }

  // --- multi / pipeline ---
  multi(): ReturnType<RedisFalso["cadena"]> {
    return this.cadena();
  }

  pipeline(): ReturnType<RedisFalso["cadena"]> {
    return this.cadena();
  }

  private cadena() {
    const pendientes: (() => Promise<unknown>)[] = [];
    const yo = this as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    const cad: Record<string, unknown> = {};
    for (const c of COMANDOS) {
      cad[c] = (...a: unknown[]) => {
        pendientes.push(() => yo[c]!(...a));
        return cad;
      };
    }
    cad.exec = async (): Promise<[Error | null, unknown][]> => {
      const salida: [Error | null, unknown][] = [];
      for (const p of pendientes) {
        try {
          salida.push([null, await p()]);
        } catch (e) {
          salida.push([e as Error, undefined]);
        }
      }
      return salida;
    };
    return cad as Record<
      (typeof COMANDOS)[number],
      (...a: unknown[]) => unknown
    > & {
      exec(): Promise<[Error | null, unknown][]>;
    };
  }

  // --- servidor ---
  /** TIME: [segundos, microsegundos] del reloj falso (el mismo que gobierna los vencimientos). */
  async time(): Promise<[string, string]> {
    return this.ejecutar(() => {
      const ms = this.reloj.ms();
      return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
    });
  }

  // --- Lua y conexion ---
  async eval(): Promise<never> {
    throw new Error(
      "RedisFalso no soporta Lua: usa comandos simples o una prueba de integracion",
    );
  }

  async evalsha(): Promise<never> {
    return this.eval();
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  disconnect(): void {}

  private async ejecutar<T>(f: () => T): Promise<T> {
    this.comandos++;
    if (this.error !== null) throw this.error;
    return f();
  }
}
