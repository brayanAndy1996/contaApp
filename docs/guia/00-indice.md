# Guía de uso de ContApp

Esta guía explica **qué hace ContApp, para qué sirve cada pantalla y cómo usarla paso a paso**. Está escrita para quien va a trabajar con el sistema: el dueño del estudio, el contador y su equipo. No necesitas saber programar, salvo para el módulo 01, que explica cómo levantar el sistema en tu computadora para probarlo.

Si quieres entender **cómo está construido** por dentro (PostgreSQL, colas, cifrado), eso está en el [curso técnico](../curso/00-indice.md).

## Antes de empezar: lee esto

> **La apariencia cambió después de escribir esta guía.** La spec 038 (noviembre de 2026) aplicó el diseño nuevo, verde petróleo, a todas las pantallas: menú lateral en escritorio, barra inferior en celular y «Ventas» accesible desde la ficha del cliente. Los nombres de botones, los pasos y las reglas de esta guía siguen valiendo; lo que cambia es el aspecto y dónde está el menú. Las dos capturas de los módulos 06 y 09 muestran el diseño anterior. Las reglas aprendidas de la spec 021 todavía no tienen módulo en esta guía.

> **ContApp todavía no se conecta con SUNAT.** La versión actual (Release 1) está completa y probada, pero las conexiones con SUNAT son **simulaciones**: la descarga de propuestas SIRE, la consulta RUC, la verificación de credenciales y los XML de los comprobantes devuelven datos de prueba. Con un RUC real no verás los comprobantes reales de tu cliente.

> **No ingreses claves SOL ni credenciales SIRE reales en tu entorno de prueba.** En modo desarrollo las credenciales se cifran con una llave de pruebas cuya parte privada está guardada en el propio repositorio (`packages/crypto/fixtures/mock-kek/`). Quien tenga acceso al repositorio podría descifrarlas. Usa siempre los datos de prueba que trae el proyecto y una clave inventada, como `CLAVEPRUEBA1`. Las credenciales reales se podrán usar cuando existan la configuración de producción y la conexión real con SUNAT.

Para probar, el proyecto trae un **contribuyente de prueba** (RUC `20700000002`, «PRUEBA CONTRIBUYENTE S.A.C.») con propuestas de compras y de ventas del periodo **octubre de 2026 (`202610`)**. Esos datos están pensados para mostrar cada función: una compra con el ISC mal ubicado (caso San Juan), una compra mixta con el IGV mal calculado, una boleta faltante (la 291), ventas en dólares y una nota de crédito. Todos los módulos los usan en su sección «Pruébalo».

## Qué hace ContApp

ContApp ayuda a un estudio contable a **revisar y corregir los registros de compras y ventas del SIRE de todos sus clientes antes de presentarlos**, sin hacerlo fila por fila en Excel:

1. **Descarga la propuesta** de SUNAT (compras RCE y ventas RVIE) de cada cliente.
2. **Detecta errores** con reglas de contador: IGV que no es 18 % ni 10 %, ISC registrado como base gravada, compras mixtas, redondeos, proveedores nuevos y posibles gastos personales.
3. **Sugiere la corrección** y te deja aplicarla con un clic, o editar a mano en una grilla tipo Excel con el cuadre en vivo.
4. **Compara con el XML** del comprobante (la «lupa») para confirmar qué dice la factura real.
5. **Revisa la correlatividad** de las ventas (boletas o facturas que faltan).
6. **Genera el archivo de reemplazo** (TXT dentro de un ZIP) solo si todo está correcto, y guarda cada versión con su huella para descargarla después.
7. Todo con **varios usuarios, roles y permisos**, un **registro de auditoría** de quién hizo qué, y **notificaciones** dentro del sistema.

## Mapa de módulos

| # | Módulo | En una línea |
|---|---|---|
| 00 | [Índice](00-indice.md) | Este archivo: qué es ContApp, avisos importantes y cómo usar la guía. |
| 01 | [Preparar tu entorno de prueba](01-preparar-entorno.md) | Instalar, arrancar ContApp en tu computadora, usuarios y datos de prueba, y dónde ver los correos. |
| 02 | [Entrar a ContApp](02-entrar-a-contapp.md) | Registrar un estudio, iniciar sesión, recuperar la contraseña, cambiar de estudio y cerrar sesión. |
| 03 | [Tu equipo: usuarios, roles y asignaciones](03-equipo-roles-asignaciones.md) | Invitar usuarios, qué puede hacer cada rol y cómo asignar clientes a un responsable. |
| 04 | [Planes y límites](04-planes-y-limites.md) | Cuántos RUC y usuarios permite tu plan, qué pasa al llegar al límite y la consola del super-admin. |
| 05 | [Clientes](05-clientes.md) | Crear un cliente por RUC, su perfil fiscal, archivarlo y cargar muchos clientes desde Excel o CSV. |
| 06 | [Credenciales y trabajos](06-credenciales-y-trabajos.md) | Guardar las credenciales SOL y SIRE, verificarlas y seguir los trabajos en la cola en tiempo real. |
| 07 | [Ventas (RVIE)](07-ventas.md) | Descargar o importar las ventas del periodo, revisar el resumen y la correlatividad, y justificar faltantes. |
| 08 | [Compras (RCE)](08-compras.md) | La grilla de compras: corregir, clasificar, aplicar sugerencias, excluir, agregar, deshacer y exportar. |
| 09 | [La lupa y el XML](09-lupa-y-xml.md) | Ver el comprobante con su XML, comparar con el SIRE, subir un XML a mano y agregar una compra desde el XML. |
| 10 | [Generar el archivo SIRE](10-generar-archivo.md) | Prevalidar el periodo, ver el resumen de cambios, generar el ZIP y descargar sus versiones. |
| 11 | [Auditoría y notificaciones](11-auditoria-y-notificaciones.md) | Quién hizo qué y cuándo, y los avisos que te llegan dentro de ContApp. |
| 12 | [Un mes de trabajo de punta a punta](12-un-mes-de-punta-a-punta.md) | El cierre de un periodo completo con todos los módulos, lo que aún no hace y cómo resolver problemas comunes. |

## Orden recomendado

```text
01 → 02 → 05 → 06 → 07 → 08 → 09 → 10 → 12
              ↘ 03 → 04            ↘ 11
```

- **Para probar rápido (1 hora):** 01, 02, 05, 08 y 10. Con eso levantas el sistema, creas un cliente, corriges sus compras y generas el archivo.
- **Si vas a trabajar con un equipo:** agrega 03 (roles) y 11 (auditoría).
- **Para ver el ciclo completo:** termina con el 12.

## Cómo está escrito cada módulo

| Sección | Para qué |
|---|---|
| **Para qué sirve** | La función explicada como contador: qué problema resuelve y en qué momento del mes se usa. |
| **Quién puede usarlo** | Qué rol o permiso hace falta. Si no ves un botón, casi siempre es por esto. |
| **Paso a paso** | Cada tarea con los pasos exactos y el resultado que debes ver. Los nombres de botones van entre comillas: «Generar». |
| **Qué ves en pantalla** | Columnas, estados y avisos, y qué significa cada uno. |
| **Reglas y límites** | Lo que el sistema no te deja hacer, por qué, y qué mensaje verás. |
| **Pruébalo** | Un recorrido con los datos de prueba, con los resultados esperados. |
| **Problemas frecuentes** | Síntoma, causa y solución. |
| **Comprueba lo aprendido** | Ejercicios prácticos con solución escondida. |

## Glosario de la pantalla

| Término | Qué significa en ContApp |
|---|---|
| **Estudio** | Tu estudio contable dentro de ContApp. Sus datos nunca se ven desde otro estudio. Un usuario puede pertenecer a varios. |
| **Cliente** | Un contribuyente (RUC) que tu estudio atiende. |
| **Responsable / colaborador** | Usuarios asignados a un cliente. Cada cliente tiene un responsable; los colaboradores ayudan. |
| **Propuesta** | Lo que SUNAT propone como registro de compras o de ventas de un periodo. ContApp la guarda tal como llegó y nunca la modifica. |
| **Periodo** | Un mes, escrito `AAAAMM` (por ejemplo `202610` es octubre de 2026). |
| **Estado del periodo** | `abierto` (se puede editar), `revisado` (solo quien aprueba puede cambiar algo) o `generado` (ya tiene archivo; para cambiarlo hay que reabrir). |
| **Sugerencia** | Corrección que propone una regla (por ejemplo, mover un monto de base gravada a ISC). Tú decides si la aplicas. |
| **Excluir** | Sacar una fila del archivo que se va a generar, con un motivo. No se borra: se puede restaurar. |
| **Lupa** | Ventana con el detalle de un comprobante y su XML. |
| **Previo** | La revisión del periodo antes de generar: errores que bloquean, avisos y resumen de cambios. |
| **Trabajo** | Una tarea que corre en segundo plano (descargar, verificar credenciales, consultar RUC, generar). Se sigue en «Trabajos». |
| **Versión del archivo** | Cada archivo generado queda guardado con número, fecha, autor y huella SHA-256. |

## Ejercicios de calentamiento

1. ¿Por qué no debes probar ContApp hoy con las claves SOL reales de un cliente? Da las dos razones.
2. ¿Qué RUC y qué periodo usarás para probar?
3. Si solo tienes una hora, ¿qué módulos lees?

<details>
<summary>Soluciones</summary>

1. Porque (a) el sistema todavía no se conecta con SUNAT, así que no verías sus datos reales, y (b) en modo desarrollo la clave quedaría cifrada con una llave de pruebas cuya parte privada está en el repositorio.
2. El contribuyente de prueba `20700000002` y el periodo `202610` (octubre de 2026).
3. 01, 02, 05, 08 y 10.

</details>
