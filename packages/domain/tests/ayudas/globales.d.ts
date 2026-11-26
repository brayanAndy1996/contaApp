// `types: []` deja fuera los tipos de Node; las pruebas de 028 (correo) usan `structuredClone`, que Node y Vitest ofrecen en ejecución.
declare function structuredClone<T>(valor: T): T;
