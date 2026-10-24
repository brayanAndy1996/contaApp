# ContApp — Requerimientos e historias de usuario (v0.1)

Fecha: 2026-10-24 · Base: [01-definiciones-base.md](01-definiciones-base.md), contapp.docx y videos del 2026-10-23.

**Prioridad (MoSCoW)**: **M** = Must (MVP) · **S** = Should (siguiente release) · **C** = Could (si hay tiempo) · **W** = Won't (por ahora)

**Release objetivo**: **R1** = MVP (SIRE compras/ventas + correcciones + archivo) · **R2** = buzones, aprendizaje, prorrata · **R3** = ajustes posteriores, facturación del SaaS

---

## 1. Actores

| Actor | Descripción |
|---|---|
| **Super-admin** | Equipo de ContApp. Gestiona planes, estudios y soporte. No ve datos contables de los estudios salvo con acceso de soporte autorizado. |
| **Dueño** | Quien contrata el plan del estudio. Control total del tenant. |
| **Administrador** | Gestiona usuarios, clientes y asignaciones. Ve todos los clientes. |
| **Contador** | Trabaja los RUCs asignados: descarga, clasifica, aprueba y genera. |
| **Asistente** | Apoya en los RUCs asignados: descarga y clasifica; no aprueba ni toca credenciales. |
| **Lectura** | Consulta propuestas, buzón y reportes de los RUCs asignados. |
| **Sistema (workers)** | Procesos en segundo plano: SIRE, SOL, buzones, reglas. |
| **SUNAT** | Sistema externo: API SIRE y portal SOL. |

---

## 2. Requerimientos funcionales

### M1 · Plataforma, planes y suscripción
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-001 | El super-admin puede crear, editar y desactivar planes con: precio mensual y anual, máx. RUCs, máx. usuarios, precio y tope de RUC adicional, frecuencia de buzón y features habilitadas. | M | R1 |
| RF-002 | Un visitante puede registrar un estudio (nombre, RUC del estudio opcional, correo del dueño) e iniciar una prueba de 14 días con el plan Prueba. | M | R1 |
| RF-003 | El sistema impide crear, importar o reactivar clientes si se supera el máximo de RUCs activos del plan (más los adicionales contratados). La validación es transaccional. | M | R1 |
| RF-004 | El sistema impide invitar usuarios por encima del máximo del plan. | M | R1 |
| RF-005 | El dueño puede cambiar de plan. Si baja y excede límites, no se borra nada: se bloquea agregar hasta regularizar y se muestra un aviso. | S | R3 |
| RF-006 | Al vencer la prueba o la suscripción, el tenant pasa a solo lectura (puede ver y exportar, no procesar). | S | R3 |
| RF-007 | Cobro en línea de la suscripción (pasarela de pagos) y emisión del comprobante del SaaS. | C | R3 |
| RF-008 | El super-admin ve un listado de estudios con plan, RUCs usados, usuarios, último uso y estado. | S | R2 |

### M2 · Autenticación y cuenta
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-010 | Inicio de sesión con correo y contraseña. | M | R1 |
| RF-011 | Recuperación de contraseña por correo con enlace de un solo uso y expiración. | M | R1 |
| RF-012 | Segundo factor (TOTP) opcional por usuario; obligatorio para Dueño y Administrador. | S | R2 |
| RF-013 | Si el usuario pertenece a varios estudios, elige con cuál trabajar tras iniciar sesión y puede cambiar sin volver a autenticarse. | M | R1 |
| RF-014 | Cierre de sesión y revocación de sesiones activas desde el perfil. | S | R2 |
| RF-015 | Bloqueo temporal tras 5 intentos fallidos de inicio de sesión. | M | R1 |

### M3 · Usuarios, roles, permisos y asignación
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-020 | Dueño/Administrador invita usuarios por correo asignándoles un rol. | M | R1 |
| RF-021 | El sistema provee roles predefinidos: Dueño, Administrador, Contador, Asistente, Lectura (no editables). | M | R1 |
| RF-022 | El estudio puede crear roles personalizados combinando permisos atómicos. | S | R2 |
| RF-023 | Cada rol tiene alcance **global** (todos los clientes) o **asignado** (solo clientes asignados). | M | R1 |
| RF-024 | Un usuario con `clientes.asignar` puede asignar uno o varios usuarios a un cliente como **responsable** (exactamente uno) o **colaborador**. | M | R1 |
| RF-025 | Asignación masiva: varios clientes a un usuario y viceversa. | S | R1 |
| RF-026 | Todas las pantallas, búsquedas, exportaciones y notificaciones se filtran por los clientes visibles del usuario. | M | R1 |
| RF-027 | Desactivar un usuario revoca su acceso inmediatamente sin borrar su historial; sus clientes como responsable quedan marcados "sin responsable". | M | R1 |
| RF-028 | Debe existir siempre al menos un Dueño activo en el tenant. | M | R1 |

### M4 · Clientes (RUC) y credenciales
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-030 | Crear cliente con RUC; el sistema valida el dígito verificador y completa razón social, estado y condición del contribuyente. | M | R1 |
| RF-031 | Importar clientes desde Excel/CSV (RUC, usuario SOL, clave SOL, client_id, client_secret, responsable). Muestra vista previa, errores por fila y cuántas filas exceden el plan antes de confirmar. | M | R1 |
| RF-032 | Descargar plantilla Excel de importación. | M | R1 |
| RF-033 | Registrar o actualizar credenciales SOL y API SIRE. Son **solo escritura**: nunca se muestran ni se exportan. | M | R1 |
| RF-034 | Mostrar por cliente el estado de cada credencial: no configurada / configurada / verificada (fecha) / inválida (motivo). | M | R1 |
| RF-035 | Botón "Verificar credenciales" que encola una prueba de login SOL y de token SIRE. | M | R1 |
| RF-036 | Datos fiscales por cliente: régimen, zona (ej. Amazonía/selva), si tiene ventas exoneradas o mixtas, moneda habitual. Alimentan el modo estándar de clasificación. | M | R1 |
| RF-037 | Archivar y reactivar clientes. Un archivado libera el cupo y queda en solo lectura. | M | R1 |
| RF-038 | Eliminar definitivamente un cliente y todos sus datos (derecho de cancelación). Requiere confirmación del Dueño. | S | R2 |
| RF-039 | Listado de clientes con filtros: responsable, estado de credenciales, periodo pendiente, mensajes sin leer. | M | R1 |

### M5 · Integración SUNAT y cola de trabajos
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-040 | Toda interacción con SUNAT se ejecuta como trabajo en cola, nunca en la petición web. | M | R1 |
| RF-041 | La cola aplica: concurrencia global máxima, concurrencia máxima por tenant, espera mínima entre llamadas al mismo RUC y prioridad (acción del usuario > programada). | M | R1 |
| RF-042 | El usuario ve el estado de sus trabajos en tiempo real (en cola, ejecutando, posición, completado, error) y puede cancelar los que aún no empiezan. | M | R1 |
| RF-043 | Ante error transitorio (timeout, 5xx) se reintenta con backoff exponencial hasta 3 veces. | M | R1 |
| RF-044 | Ante credencial inválida no se reintenta: se marca el cliente y se notifica al responsable. | M | R1 |
| RF-045 | Obtención y renovación automática del token SIRE por RUC. | M | R1 |
| RF-046 | Listar periodos SIRE del RUC con su estado (pendiente, presentado, con ajustes). | M | R1 |

### M6 · Registro de Ventas (RVIE)
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-050 | Descargar la propuesta de ventas del periodo desde la API SIRE. | M | R1 |
| RF-051 | Importar la propuesta desde archivo TXT/Excel de SUNAT como alternativa a la API. | M | R1 |
| RF-052 | Mostrar las ventas en una grilla con paginación configurable (10/25/50/todas), búsqueda y filtros por tipo, serie y rango de montos. | M | R1 |
| RF-053 | **Auditoría de correlatividad**: ordenar por tipo y serie, y alertar saltos de numeración (ej. falta la 291 entre la 290 y la 292), mostrando "Numeración completa" cuando no hay huecos. | M | R1 |
| RF-054 | Cruzar la propuesta con la consulta de comprobantes emitidos en SOL para detectar comprobantes (incluidas notas de crédito) que el SIRE no trajo. | S | R2 |
| RF-055 | Agregar manualmente una venta faltante (formulario o XML). | M | R1 |
| RF-056 | Resumen del periodo por tipo de comprobante: cantidad, base, IGV, total. | M | R1 |

### M7 · Registro de Compras (RCE) y clasificación
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-060 | Descargar la propuesta de compras del periodo desde la API SIRE o importarla desde archivo. | M | R1 |
| RF-061 | Grilla de compras con: proveedor, comprobante, BI/IGV por columna (DG, DGNG, DNG), valor no gravado, ISC, ICBPER, otros tributos, total, moneda, indicador de regla disparada y lupa 🔍. | M | R1 |
| RF-062 | Cambiar la clasificación DG / DGNG / DNG de una fila; el sistema mueve automáticamente los montos a la columna correspondiente. | M | R1 |
| RF-063 | Clasificación masiva: seleccionar varias filas (o filtrar por proveedor) y asignar destino. | M | R1 |
| RF-064 | **Edición tipo Excel**: editar cualquier monto de la fila con recálculo del total y validación de cuadre en vivo. | M | R1 |
| RF-065 | Deshacer / rehacer cambios dentro de la sesión de trabajo del periodo. | S | R1 |
| RF-066 | Excluir una compra ("No deducible") con motivo opcional; queda visible en una sección de excluidas y puede restaurarse. | M | R1 |
| RF-067 | Agregar una compra no propuesta por el SIRE (formulario o subiendo XML que se interpreta automáticamente). | M | R1 |
| RF-068 | Separar visualmente "compras con IGV" y "compras sin IGV" (no generan crédito fiscal). | M | R1 |
| RF-069 | Resumen por casillero (BI y IGV en DG, DGNG, DNG, no gravadas, ISC, otros) con diferencia entre la propuesta original y la corregida. | M | R1 |
| RF-070 | Indicador "proveedor nuevo" cuando el RUC del proveedor nunca apareció en ese cliente. | M | R1 |
| RF-071 | Al marcar el periodo como revisado, se bloquea la edición salvo para quien tenga `sire.aprobar_generar`. | S | R1 |

### M8 · Motor de correcciones automáticas
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-080 | Al cargar una propuesta, el sistema evalúa todas las reglas y marca cada fila con las reglas disparadas y la corrección sugerida, **sin aplicarla** hasta que el usuario acepte (individual o masivamente). | M | R1 |
| RF-081 | **R-ISC**: detectar base gravada > 0 con IGV = 0, o proveedor marcado como emisor de ISC, y sugerir mover el monto a ISC. | M | R1 |
| RF-082 | **R-MIX**: detectar IGV que no cuadra con 18 % ni 10 % de la base (con tolerancia de ±0.01 por línea) y sugerir `gravado ≈ IGV / tasa` como rango (el IGV viene redondeado) y `no gravado = base − gravado`; el monto exacto se toma del XML o lo confirma el contador. | M | R1 |
| RF-083 | **R-RED**: detectar que la suma de componentes ≠ total o que hay diferencias por tipo de cambio, y sugerir el redondeo correcto. | M | R1 |
| RF-084 | **R-ICB**: detectar ICBPER en columna incorrecta (requiere XML). | S | R2 |
| RF-085 | **R-NEW**: proveedor nuevo → pedir clasificación. | M | R1 |
| RF-086 | **R-HIS**: proveedor con regla aprendida → aplicar clasificación del historial. | S | R2 |
| RF-087 | Catálogo global de proveedores con "error típico" (ej. emisor de ISC) mantenido por el super-admin y alimentado por correcciones confirmadas de los estudios (de forma anónima). | S | R2 |
| RF-088 | **Prevalidación SUNAT**: antes de generar el archivo, validar cada fila con las reglas de estructura y cuadre de SUNAT. Si hay errores, no se permite generar y se listan las filas a corregir. | M | R1 |
| RF-089 | Cada regla tiene código, descripción en lenguaje simple y se puede activar o desactivar por estudio. | S | R2 |

### M9 · Modal de detalle del comprobante (🔍)
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-090 | Cada fila de compras y ventas tiene un botón lupa que abre un modal con el detalle del comprobante. | M | R1 |
| RF-091 | El modal muestra la cabecera: emisor, RUC, tipo, serie-número, fecha, moneda, tipo de cambio y origen (portal SUNAT "E…" / sistema propio "F…"). | M | R1 |
| RF-092 | El modal muestra los ítems leídos del XML en lenguaje humano: descripción, cantidad, unidad, precio unitario, valor, tipo de afectación, IGV, ISC e ICBPER por línea. | M | R1 |
| RF-093 | El modal compara SIRE vs XML por columna y resalta las diferencias con la regla y la explicación. | M | R1 |
| RF-094 | El modal muestra la sugerencia del sistema y el historial de clasificación del proveedor para ese cliente. | M | R1 |
| RF-095 | Acciones desde el modal: aceptar sugerencia, editar montos, cambiar clasificación, excluir (no deducible), "recordar para este proveedor", ver/descargar XML y PDF. | M | R1 |
| RF-096 | Navegación anterior/siguiente sin cerrar el modal y atajos de teclado (← → Enter Esc). | S | R1 |
| RF-097 | Obtener el XML automáticamente mediante un **proveedor de XML intercambiable** (`XmlProvider`). En R1 se usa el **proveedor simulado**; el real (fuente/API que entregará el equipo) se conecta después sin cambiar el resto del sistema. | M | R1 |
| RF-097a | **Proveedor simulado** (`MockXmlProvider`): (1) si existe un XML real en la carpeta de fixtures para ese comprobante (`{ruc_emisor}-{tipo}-{serie}-{numero}.xml`), lo devuelve; (2) si no, genera un XML UBL 2.1 sintético coherente con la fila del SIRE. Puede inyectar los casos de prueba (ISC, mixta, ICBPER, redondeo) y errores configurables (no encontrado, timeout, credencial inválida) con latencia simulada. | M | R1 |
| RF-097b | El proveedor activo se elige por configuración (`XML_PROVIDER=mock|real`) y la UI muestra un distintivo "XML simulado" cuando proviene del simulador. | M | R1 |
| RF-098 | Si el XML no está disponible: subir XML manualmente o reintentar la descarga. | M | R1 |
| RF-099 | El XML obtenido se guarda una sola vez por comprobante y se reutiliza. | M | R1 |

> La fuente y la API reales de descarga de XML las entregará el equipo más adelante. Hasta entonces todo el flujo (cola, caché, modal, reglas) se construye y prueba contra `MockXmlProvider`. Conectar el real = implementar la misma interfaz.

### M10 · Generación de archivos
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-100 | Generar el archivo TXT de **reemplazo** de la propuesta (compras y ventas) con la estructura vigente de SUNAT. | M | R1 |
| RF-101 | Empaquetar automáticamente el TXT en ZIP con el nombre que exige SUNAT. | M | R1 |
| RF-102 | Mostrar antes de generar un resumen de cambios: filas modificadas, excluidas y agregadas, y el impacto en IGV. | M | R1 |
| RF-103 | Guardar cada archivo generado con versión, usuario, fecha y hash; poder descargar versiones anteriores. | M | R1 |
| RF-104 | Enviar el archivo directamente a SUNAT por la API SIRE y hacer seguimiento del ticket hasta su estado final (procesado / procesado con errores) mostrando los errores devueltos. | S | R2 |
| RF-105 | Exportar la grilla del periodo a Excel. | M | R1 |

### M11 · Aprendizaje (Smart Mapping)
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-110 | Al guardar una clasificación manual, el sistema ofrece "Recordar para este proveedor en este cliente". | S | R2 |
| RF-111 | Las reglas aprendidas se aplican como sugerencia al cargar nuevos periodos y se marcan como "según historial". | S | R2 |
| RF-112 | Importar periodos anteriores ya validados para generar reglas iniciales (modo histórico). | S | R2 |
| RF-113 | Modo estándar para clientes nuevos: sugerencias por datos fiscales del cliente (ej. zona selva con ventas exoneradas → DNG por defecto). | S | R2 |
| RF-114 | Pantalla de reglas por cliente: ver, editar, desactivar y eliminar; con contador de veces aplicada y aceptada. | S | R2 |
| RF-115 | Las reglas aprendidas pertenecen al cliente (y por ende al tenant); nunca se comparten entre estudios. | M | R2 |
| RF-116 | **Detección de posibles gastos no deducibles sin IA**, por reglas sobre la glosa del XML (ver detalle abajo). Solo sugiere; la decisión es del contador. | S | R2 |
| RF-117 | Diccionario de palabras clave por categoría (ropa/calzado, juguetes, entretenimiento, alimentos de consumo personal, cuidado personal…) mantenido por el super-admin; cada estudio puede agregar palabras propias o desactivar las globales. | S | R2 |
| RF-118 | Cuando el contador excluye una compra como no deducible, el sistema ofrece "Aprender estas palabras" para agregar términos de la glosa al diccionario del estudio. | C | R2 |

**Cómo funciona RF-116 (determinístico, sin IA)**

Cada compra recibe un **puntaje de sospecha** sumando señales. Si supera un umbral configurable se marca como "Posible gasto no deducible" con la explicación de las señales que se activaron.

| Señal | Ejemplo | Peso |
|---|---|---|
| Palabra clave de consumo personal en la glosa | "zapatilla", "polo", "juguete", "perfume" | +3 por ítem coincidente |
| El rubro del proveedor (CIIU de su ficha RUC) no tiene relación con la actividad del cliente | Cliente ferretería que compra en una tienda de ropa | +3 |
| La categoría de la glosa no está en las categorías permitidas para el giro del cliente | Cliente transportista con compra de "útiles escolares" | +2 |
| Compra en fin de semana o feriado a un retail o restaurante | Sábado, supermercado | +1 |
| El cliente nunca compró a ese proveedor o categoría | Proveedor nuevo | +1 |
| Historial: el mismo proveedor ya fue excluido antes en este cliente | Excluido 3 veces | +4 |
| Historial: el mismo proveedor siempre fue aceptado | Aceptado 6 veces | −4 |

- La normalización del texto (minúsculas, sin tildes, singular/plural, abreviaturas comunes como "ZAPAT.") se hace con reglas simples, sin modelos.
- Matriz **giro del cliente → categorías permitidas** (ej. ferretería: herramientas, materiales, transporte, servicios básicos). Viene una matriz base por sección CIIU y el estudio la ajusta por cliente.
- **IA opcional a futuro (W)**: si algún día se quiere, se enchufa como una señal más del puntaje, sin cambiar el flujo.

### M12 · Buzones electrónicos SOL
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-120 | Revisar los buzones SOL de todos los clientes activos con credenciales válidas, según la frecuencia del plan y bajo demanda. | S | R2 |
| RF-121 | Bandeja unificada con: cliente, buzón, asunto, fecha, tipo (notificación, resolución, valor, coactiva…), leído/no leído en SUNAT. | S | R2 |
| RF-122 | Resaltar mensajes críticos (cobranza coactiva, resoluciones de determinación/multa, requerimientos de fiscalización). | S | R2 |
| RF-123 | Ver el contenido y descargar los adjuntos del mensaje dentro de la app. | S | R2 |
| RF-124 | Marcar como atendido internamente (independiente del leído de SUNAT) con comentario y usuario. | S | R2 |
| RF-125 | Indicador por cliente de mensajes nuevos en el listado de clientes. | S | R2 |
| RF-126 | La revisión del buzón no debe marcar como leído el mensaje en SUNAT salvo que el usuario abra el contenido. | S | R2 |

### M13 · Prorrata e IGV estimado
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-130 | Obtener de SOL los montos declarados (PDT 621) de los últimos 12 meses del cliente. | S | R2 |
| RF-131 | Calcular el coeficiente de prorrata: ventas gravadas / ventas totales (gravadas + no gravadas) de los 12 meses anteriores, según la norma vigente. | S | R2 |
| RF-132 | Mostrar el detalle mes a mes, el gráfico y el origen de cada monto (declarado / SIRE / manual). | S | R2 |
| RF-133 | Permitir ingresar o corregir manualmente un mes faltante. | S | R2 |
| RF-134 | Calcular el IGV estimado del mes: IGV ventas − crédito DG − (crédito DGNG × prorrata) y mostrar si hay saldo a favor o a pagar. | S | R2 |
| RF-135 | Comparar la prorrata calculada con la que usó el contador en su declaración y alertar diferencias. | C | R2 |

### M14 · Ajustes posteriores
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-140 | Seleccionar un periodo ya presentado y cargar su registro vigente. | S | R3 |
| RF-141 | Modificar, agregar o anular comprobantes del periodo cerrado con las mismas herramientas de la grilla, la lupa y el motor de reglas. | S | R3 |
| RF-142 | Reclasificación masiva retroactiva (ej. pasar compras de DG a DNG en todos los meses del año para un cliente de la selva). | S | R3 |
| RF-143 | Generar los archivos de ajustes posteriores según los anexos vigentes de SUNAT, con prevalidación. | S | R3 |
| RF-144 | Seguimiento del ticket del ajuste hasta su estado final. | S | R3 |

### M15 · Auditoría
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-150 | Registrar toda acción relevante: inicio de sesión, cambios de rol o asignación, alta/baja de clientes, cambio de credenciales, **cada descifrado de credenciales**, cambios en filas (antes → después), exclusiones, archivos generados y envíos a SUNAT. | M | R1 |
| RF-151 | Consultar la auditoría filtrando por usuario, cliente, acción y fechas. | S | R2 |
| RF-152 | La auditoría es de solo agregado (no se edita ni borra desde la app). | M | R1 |

### M16 · Notificaciones
| ID | Requerimiento | Prio | Rel |
|---|---|---|---|
| RF-160 | Notificaciones dentro de la app: trabajo terminado, credencial inválida, mensaje crítico de buzón, límite del plan cercano. | M | R1 |
| RF-161 | Notificaciones por correo configurables por usuario. | S | R2 |
| RF-162 | Resumen diario por correo con mensajes de buzón nuevos y periodos pendientes de los clientes asignados. | C | R2 |

---

## 3. Requerimientos no funcionales

### Seguridad
| ID | Requerimiento |
|---|---|
| RNF-001 | Aislamiento multitenant con `tenant_id` en todas las tablas de negocio y **Row Level Security** en PostgreSQL. Ninguna consulta puede devolver datos de otro tenant aunque el código omita el filtro (verificado con pruebas automáticas). |
| RNF-002 | Credenciales cifradas con envelope encryption: KEK fuera de la BD (`.env` en local, KMS/Vault en nube), DEK por tenant, AES-256-GCM con nonce único y AAD `tenant_id\|cliente_id\|tipo`. |
| RNF-003 | Solo el proceso worker puede descifrar credenciales; el backend no tiene acceso a la llave para descifrar. |
| RNF-004 | Ningún secreto aparece en logs, mensajes de error, respuestas de API, exportaciones ni trazas. |
| RNF-005 | Contraseñas de usuario con Argon2id. |
| RNF-006 | HTTPS obligatorio fuera de local; cookies de sesión `HttpOnly`, `Secure`, `SameSite=Lax`; protección CSRF. |
| RNF-007 | Autorización verificada en el backend en cada endpoint (rol + permiso + cliente visible); el frontend solo oculta. |
| RNF-008 | Archivos subidos (Excel, XML): límite de tamaño, validación de tipo, parseo seguro de XML (sin entidades externas) y se descarta el Excel de credenciales tras procesarlo. |
| RNF-009 | Rate limiting en login y endpoints públicos. |
| RNF-010 | Dependencias revisadas automáticamente (auditoría de vulnerabilidades en CI). |

### Privacidad y cumplimiento
| ID | Requerimiento |
|---|---|
| RNF-020 | Cumplimiento de la Ley 29733: términos de servicio, política de privacidad, consentimiento para custodiar credenciales SOL y borrado total a solicitud. |
| RNF-021 | Retención: datos tributarios conservados mientras el cliente esté activo y al menos 5 años (plazo de prescripción tributaria) salvo solicitud de borrado; auditoría conservada 5 años. |
| RNF-022 | El acceso de soporte del super-admin a datos de un tenant requiere autorización explícita del Dueño, es temporal y queda auditado. |

### Rendimiento y capacidad
| ID | Requerimiento |
|---|---|
| RNF-030 | Soportar 1,000 RUCs activos por tenant y 100 tenants en el entorno inicial sin degradación. |
| RNF-031 | Grilla de un periodo con hasta 5,000 comprobantes: carga inicial < 2 s y edición de celda con recálculo < 100 ms (virtualización de filas). |
| RNF-032 | Apertura del modal de detalle con XML ya guardado < 500 ms. |
| RNF-033 | Evaluación del motor de reglas sobre 5,000 comprobantes < 3 s. |
| RNF-034 | API: p95 < 300 ms en operaciones que no tocan SUNAT. |
| RNF-035 | Generación del TXT/ZIP de un periodo < 5 s. |

### Integración con SUNAT
| ID | Requerimiento |
|---|---|
| RNF-040 | Límites configurables (sin redeploy): concurrencia global, concurrencia por tenant, espera entre llamadas por RUC, reintentos. |
| RNF-041 | Reparto justo entre tenants: ningún tenant puede ocupar más del X % de los workers mientras otros esperan. |
| RNF-042 | Los adaptadores SUNAT (API SIRE, scraping SOL) están aislados detrás de interfaces, para cambiarlos cuando SUNAT modifique su portal sin tocar la lógica de negocio. |
| RNF-043 | Las estructuras de archivos SUNAT (versiones de TXT, anexos) se modelan versionadas para soportar cambios normativos. |
| RNF-044 | Monitoreo de la tasa de fallos por adaptador con alerta cuando supere el umbral (detecta cambios en el portal SOL). |

### Exactitud de datos
| ID | Requerimiento |
|---|---|
| RNF-050 | Montos con aritmética decimal exacta (`decimal.js` / `NUMERIC` en BD). Prohibido usar punto flotante para dinero. |
| RNF-051 | Redondeo a 2 decimales con la misma regla que SUNAT, en un único módulo compartido y probado. |
| RNF-052 | Ningún cambio altera la propuesta original: se guarda el original y las versiones corregidas por separado. |
| RNF-053 | Motor de reglas y generador de archivos con cobertura de pruebas ≥ 90 %, incluyendo los casos reales documentados (San Juan ISC, mixta 21.48/1.61, redondeo en USD, salto de boleta 291). |

### Disponibilidad y respaldo
| ID | Requerimiento |
|---|---|
| RNF-060 | Disponibilidad objetivo 99.5 % mensual (en nube). |
| RNF-061 | Respaldo diario de la BD con retención de 30 días y prueba de restauración mensual. RPO ≤ 24 h, RTO ≤ 4 h. |
| RNF-062 | Si SUNAT no responde, la app sigue funcionando con los datos ya descargados. |

### Usabilidad
| ID | Requerimiento |
|---|---|
| RNF-070 | Interfaz en español peruano, con términos contables de SUNAT (DG, DGNG, DNG, RVIE, RCE, PDT 621). |
| RNF-071 | Uso principal en escritorio (≥ 1366 px); consulta de buzones usable en móvil. |
| RNF-072 | La grilla de compras se opera con teclado como una hoja de cálculo. |
| RNF-073 | Toda corrección sugerida explica el porqué en una frase entendible. |
| RNF-074 | Onboarding guiado en los primeros pasos (crear estudio → cargar clientes → credenciales → primer periodo). |

### Mantenibilidad y operación
| ID | Requerimiento |
|---|---|
| RNF-080 | Monorepo TypeScript (Next.js, NestJS, workers, paquete `shared` con esquemas zod). |
| RNF-081 | Entorno local reproducible con un comando (Postgres, Redis, Mailpit). |
| RNF-082 | Migraciones de BD versionadas; las políticas RLS forman parte de las migraciones. |
| RNF-083 | Logs estructurados con `tenant_id`, `user_id` y `job_id`, sin datos sensibles. |
| RNF-084 | CI con lint, tipos, pruebas unitarias, de integración (incluida la prueba de aislamiento RLS) y build. |
| RNF-085 | El paso de local a nube solo requiere configuración (KMS, almacenamiento S3, SMTP), no cambios de código. |

---

## 4. Historias de usuario

Formato: *Como [rol], quiero [acción], para [beneficio].* Criterios en formato Dado / Cuando / Entonces. Estimación en puntos (Fibonacci).

### Épica E1 · Estudio, planes y acceso

**HU-01 · Registrar mi estudio** — M · R1 · 3 pts · RF-002
Como **dueño de un estudio**, quiero registrarme y empezar una prueba gratis, para evaluar la herramienta sin pagar.
- Dado un correo no registrado, cuando completo el formulario, entonces se crea el estudio con plan Prueba (14 días, 5 RUCs) y quedo como Dueño.
- Dado que confirmé mi correo, cuando inicio sesión, entonces veo el onboarding de primeros pasos.

**HU-02 · Respetar el límite de RUCs del plan** — M · R1 · 3 pts · RF-003
Como **dueño**, quiero que el sistema me avise cuando llego al límite de RUCs, para saber cuándo subir de plan.
- Dado un plan de 30 RUCs con 30 activos, cuando intento crear uno nuevo, entonces se bloquea y se me ofrece archivar uno o subir de plan.
- Dado un Excel con 50 filas y 10 cupos libres, cuando lo importo, entonces la vista previa indica que solo entran 10 y cuáles quedan fuera.
- Dado que archivo un cliente, entonces el cupo se libera inmediatamente.

**HU-03 · Invitar a mi equipo** — M · R1 · 3 pts · RF-020, RF-004
Como **administrador**, quiero invitar a contadores y asistentes con un rol, para repartir el trabajo.
- Dado un correo y un rol, cuando envío la invitación, entonces el invitado recibe un enlace que expira en 72 h.
- Dado que alcancé el máximo de usuarios del plan, cuando intento invitar, entonces se bloquea con un mensaje claro.

**HU-04 · Trabajar en varios estudios** — M · R1 · 2 pts · RF-013
Como **asistente que trabaja para dos estudios**, quiero elegir el estudio al entrar, para no mezclar sus clientes.
- Dado que pertenezco a dos estudios, cuando inicio sesión, entonces elijo uno y solo veo sus datos.
- Cuando cambio de estudio desde el menú, entonces no se me pide contraseña otra vez.

**HU-05 · Roles personalizados** — S · R2 · 5 pts · RF-022
Como **dueño**, quiero crear un rol "Practicante" con permisos específicos, para limitar lo que puede hacer.
- Dado un conjunto de permisos marcados, cuando guardo el rol, entonces puedo asignarlo a usuarios.
- Un rol personalizado nunca puede incluir `plan.gestionar`.

### Épica E2 · Clientes, asignaciones y credenciales

**HU-06 · Importar mis clientes desde Excel** — M · R1 · 5 pts · RF-031, RF-032
Como **administrador**, quiero subir un Excel con todos mis clientes y sus claves, para no registrarlos uno por uno.
- Dado el Excel de la plantilla, cuando lo subo, entonces veo una vista previa con filas válidas, errores por fila (RUC inválido, duplicado, columnas faltantes) y cupo restante.
- Cuando confirmo, entonces se crean los clientes, las credenciales quedan cifradas y el archivo se descarta.
- Las claves nunca se muestran en la vista previa (se ven como ••••).

**HU-07 · Asignar clientes a mi equipo** — M · R1 · 3 pts · RF-024, RF-025
Como **administrador**, quiero asignar a cada cliente un responsable y colaboradores, para que cada uno vea solo lo suyo.
- Dado un cliente, cuando elijo un responsable, entonces cualquier responsable anterior pasa a colaborador o se retira (a mi elección).
- Dados 20 clientes seleccionados, cuando los asigno a una asistente, entonces ella los ve al recargar.

**HU-08 · Ver solo mis clientes asignados** — M · R1 · 3 pts · RF-026
Como **asistente**, quiero ver solo los clientes que me asignaron, para enfocarme en mi trabajo.
- Dado que tengo 15 clientes asignados de 120, cuando abro el listado, la bandeja de buzón o una búsqueda, entonces solo aparecen esos 15.
- Si intento abrir por URL un cliente no asignado, entonces recibo "No encontrado" (no se revela su existencia).

**HU-09 · Registrar credenciales de forma segura** — M · R1 · 3 pts · RF-033, RF-034, RF-035
Como **contador**, quiero guardar la clave SOL y las credenciales API de un cliente y comprobar que funcionan, para que el sistema trabaje por mí.
- Cuando guardo las credenciales, entonces el formulario se vacía y el estado pasa a "Configurada".
- Cuando presiono "Verificar", entonces se encola una prueba y el estado pasa a "Verificada (fecha)" o "Inválida (motivo)".
- No existe ninguna pantalla ni API que devuelva la clave guardada.

**HU-10 · Enterarme si una clave dejó de funcionar** — M · R1 · 2 pts · RF-044, RF-160
Como **contador responsable**, quiero que me avisen si la clave SOL de un cliente es inválida, para pedirle la nueva antes del vencimiento.
- Dado un login fallido por clave incorrecta, entonces el cliente queda "Credencial inválida", recibo una notificación y el sistema no vuelve a intentar hasta que se actualice la clave.

### Épica E3 · Propuesta SIRE de ventas

**HU-11 · Descargar la propuesta de ventas** — M · R1 · 5 pts · RF-050, RF-042
Como **contador**, quiero descargar la propuesta de ventas del periodo con un clic, para revisarla sin entrar a SUNAT.
- Dado un cliente con credenciales API válidas, cuando elijo periodo y presiono "Descargar", entonces veo el trabajo en cola con su posición y, al terminar, la grilla de ventas.
- Si SUNAT no responde, entonces se reintenta hasta 3 veces y luego se muestra el error con opción de reintentar.

**HU-12 · Detectar comprobantes faltantes en ventas** — M · R1 · 3 pts · RF-053
Como **contador**, quiero que el sistema detecte saltos de numeración, para no declarar con una boleta faltante.
- Dadas las boletas B001-290 y B001-292, entonces se muestra la alerta "Falta B001-291".
- Dada una serie sin saltos, entonces se muestra "Numeración completa" para esa serie.
- Puedo marcar un salto como justificado (ej. comprobante anulado) con un comentario.

**HU-13 · Cruzar con los comprobantes emitidos en SOL** — S · R2 · 8 pts · RF-054
Como **contador**, quiero comparar la propuesta con lo emitido en SOL, para encontrar ventas o notas de crédito que el SIRE no trajo.
- Cuando ejecuto el cruce, entonces veo los comprobantes que están en SOL y no en la propuesta, con un botón para agregarlos.

### Épica E4 · Propuesta SIRE de compras y clasificación

**HU-14 · Revisar las compras en una grilla** — M · R1 · 8 pts · RF-060, RF-061, RF-068, RF-069
Como **contador**, quiero ver las compras del periodo con sus columnas por casillero y alertas, para revisarlas rápido.
- Al cargar el periodo veo: compras con IGV, compras sin IGV, filas con reglas disparadas resaltadas y el resumen por casillero.
- Puedo filtrar por "con alertas", "proveedor nuevo", "excluidas" y buscar por RUC, razón social o serie-número.

**HU-15 · Clasificar compras en DG, DGNG o DNG** — M · R1 · 3 pts · RF-062, RF-063
Como **contador**, quiero cambiar el destino de una o varias compras, para que el crédito fiscal quede bien.
- Cuando cambio una fila de DG a DNG, entonces la base y el IGV se mueven a las columnas 3 y el resumen se actualiza.
- Dadas 12 filas seleccionadas, cuando elijo "DNG", entonces todas cambian en una sola acción que se puede deshacer.

**HU-16 · Editar montos como en Excel** — M · R1 · 5 pts · RF-064, RF-065
Como **contador**, quiero editar cualquier celda de una compra, para corregir lo que el SIRE trajo mal.
- Cuando edito la base gravada, entonces el total se recalcula y, si el IGV deja de cuadrar, la celda se marca en rojo con la explicación.
- Puedo moverme con el teclado (Tab, Enter, flechas) y deshacer con Ctrl+Z.

**HU-17 · Excluir una compra no deducible** — M · R1 · 2 pts · RF-066
Como **contador**, quiero excluir una factura que es gasto personal, para que no entre al registro.
- Cuando marco "No deducible" con un motivo, entonces la fila pasa a la sección de excluidas y sale de los totales.
- Puedo restaurarla mientras el periodo no esté generado.

**HU-18 · Agregar una compra que el SIRE no trajo** — M · R1 · 5 pts · RF-067
Como **contador**, quiero agregar una compra subiendo su XML, para incluirla en el reemplazo.
- Cuando subo el XML, entonces los campos se llenan automáticamente y solo confirmo la clasificación.
- Si el comprobante ya existe en la propuesta, entonces se me avisa del duplicado.

**HU-19 · Ver proveedores nuevos** — M · R1 · 2 pts · RF-070, RF-085
Como **contador**, quiero ver marcados los proveedores que el cliente nunca tuvo, para decidir con criterio dónde van.
- Dado un RUC proveedor sin historial en el cliente, entonces la fila muestra la etiqueta "Proveedor nuevo" y queda pendiente de clasificar.

### Épica E5 · Detalle del comprobante (lupa)

**HU-20 · Ver la factura de una fila** — M · R1 · 8 pts · RF-090 a RF-096
Como **contador**, quiero presionar la lupa de una fila y ver la factura completa, para decidir sin buscarla en SUNAT.
- Cuando presiono 🔍, entonces se abre un modal con la cabecera, los ítems en lenguaje humano y los totales por tributo.
- El modal muestra lado a lado los montos del SIRE y los del XML, con las diferencias resaltadas y la regla que las explica.
- Desde el modal puedo aceptar la sugerencia, editar, cambiar la clasificación, excluir o "recordar para este proveedor", y el cambio se refleja en la grilla al cerrar.
- Con ← y → paso a la fila anterior o siguiente sin cerrar el modal.

**HU-21 · Obtener el XML automáticamente** — M · R1 · 8 pts · RF-097, RF-097a, RF-097b, RF-099
Como **contador**, quiero que el sistema descargue solo el XML de cada compra, para no hacerlo factura por factura.
- Al cargar el periodo, el sistema encola la descarga de los XML de las filas con alertas primero y luego del resto.
- Un XML ya descargado no se vuelve a pedir.
- Con `XML_PROVIDER=mock`, los XML vienen del simulador (fixtures o sintéticos) y el modal muestra "XML simulado".
- El simulador puede forzar errores (no encontrado, timeout) y la UI los maneja igual que con el proveedor real.
- *Fuera de alcance de esta historia*: el proveedor real, que será una historia aparte cuando se entregue la fuente/API.

**HU-22 · Subir el XML a mano** — M · R1 · 2 pts · RF-098
Como **contador**, quiero arrastrar el XML al modal cuando no se pudo descargar, para revisar la factura igual.
- Cuando suelto un XML válido del mismo comprobante, entonces el modal se completa con su detalle.
- Si el XML es de otro comprobante, entonces se rechaza indicando la diferencia (RUC, serie o número).

### Épica E6 · Motor de correcciones

**HU-23 · Corregir el ISC mal ubicado** — M · R1 · 5 pts · RF-081
Como **contador**, quiero que el sistema detecte compras con ISC enviadas como gravadas, para no perder tiempo revisando cada cerveza.
- Dada una compra a Cervecería San Juan con base 770 en DG e IGV 0, entonces se sugiere mover 770 a ISC con la explicación "Base gravada con IGV 0: el XML indica ISC".
- Cuando acepto la sugerencia (una o todas las de la regla), entonces los montos se mueven y el resumen se actualiza.

**HU-24 · Separar facturas mixtas** — M · R1 · 5 pts · RF-082
Como **contador**, quiero que el sistema separe la parte gravada de la no gravada cuando el IGV no cuadra, para que SUNAT no rechace el archivo.
- Dada base 21.48 e IGV 1.61 sin XML, entonces se sugiere gravado ≈ 8.94 (rango 8.92–8.97 por redondeo del IGV) y se pide confirmación, con la explicación "1.61 no es 18 % ni 10 % de 21.48".
- Con XML disponible, entonces se sugiere exactamente gravado 8.97 y no gravado 12.51.
- Si existe XML, la sugerencia se confirma o ajusta con sus montos por línea.

**HU-25 · Evitar archivos "procesados con errores"** — M · R1 · 8 pts · RF-083, RF-088
Como **contador**, quiero que el sistema valide el archivo antes de generarlo, para que SUNAT no lo rechace.
- Dada una factura en dólares cuya suma de partes difiere del total por redondeo, entonces se marca y se sugiere el monto corregido.
- Si alguna fila no pasa la prevalidación, el botón "Generar" queda deshabilitado y se listan las filas con error y un enlace a cada una.

### Épica E7 · Generación y envío

**HU-26 · Generar el archivo de reemplazo** — M · R1 · 5 pts · RF-100 a RF-103
Como **contador**, quiero generar el TXT y el ZIP del reemplazo con un clic, para subirlo a SUNAT sin armarlo a mano.
- Antes de generar veo el resumen: N filas modificadas, N excluidas, N agregadas e impacto en IGV.
- Al generar obtengo el ZIP con el nombre exigido por SUNAT y queda guardado como versión.
- Solo usuarios con `sire.aprobar_generar` ven el botón.

**HU-27 · Enviar a SUNAT y seguir el ticket** — S · R2 · 8 pts · RF-104
Como **contador**, quiero enviar el reemplazo desde la app y ver si SUNAT lo aceptó, para no tener que entrar a revisar el ticket.
- Cuando envío, entonces veo el número de ticket y su estado se actualiza solo hasta "Procesado" o "Procesado con errores" con el detalle de errores.

### Épica E8 · Aprendizaje

**HU-28 · Que el sistema recuerde mi criterio** — S · R2 · 5 pts · RF-110, RF-111
Como **contador**, quiero que el sistema recuerde dónde clasifiqué a un proveedor, para no repetirlo cada mes.
- Cuando cambio la clasificación de un proveedor, entonces se me pregunta "¿Recordar para este proveedor en este cliente?".
- En el periodo siguiente, las compras de ese proveedor llegan ya clasificadas con la etiqueta "Según historial" y puedo cambiarlas.

**HU-29 · Arrancar con el historial del cliente** — S · R2 · 5 pts · RF-112
Como **contador**, quiero importar los meses anteriores ya presentados, para que el sistema aprenda desde el primer día.
- Cuando importo 6 periodos, entonces se generan reglas por proveedor con su frecuencia y puedo revisarlas antes de activarlas.

**HU-30 · Configurar a un cliente de la selva** — S · R2 · 2 pts · RF-036, RF-113
Como **contador**, quiero indicar que un cliente está en zona exonerada, para que sus compras se sugieran en DNG por defecto.
- Dado un cliente marcado "Amazonía, ventas exoneradas", cuando cargo su periodo, entonces las compras sin regla previa se sugieren en DNG.

**HU-31 · Administrar las reglas aprendidas** — S · R2 · 3 pts · RF-114
Como **contador responsable**, quiero ver y editar las reglas de mi cliente, para corregir una que aprendió mal.
- Veo por regla: proveedor, destino, veces aplicada y aceptada; puedo editarla, desactivarla o borrarla.

**HU-41 · Detectar posibles gastos personales** — S · R2 · 5 pts · RF-116, RF-117
Como **contador**, quiero que el sistema me marque compras que parecen gastos personales, para revisarlas antes de que entren al registro.
- Dado un cliente ferretería y una compra con glosa "ZAPATILLA URBANA T42", entonces la fila se marca "Posible gasto no deducible" con las señales: "palabra clave: zapatilla" y "rubro del proveedor no relacionado".
- Dado un proveedor que el contador aceptó en los últimos 6 meses, entonces su puntaje baja y no se marca.
- El sistema nunca excluye solo: la acción final siempre es del contador.

**HU-42 · Enseñarle palabras nuevas** — C · R2 · 2 pts · RF-118
Como **contador**, quiero que al excluir una compra el sistema me ofrezca aprender sus palabras, para que detecte casos parecidos en adelante.
- Cuando excluyo una compra, entonces se me proponen los términos de su glosa y elijo cuáles agregar al diccionario del estudio.

### Épica E9 · Buzones

**HU-32 · Ver todos los buzones en una bandeja** — S · R2 · 13 pts · RF-120, RF-121, RF-125
Como **contador**, quiero ver en una sola pantalla los mensajes de los buzones de todos mis clientes, para no entrar a SOL uno por uno.
- La bandeja lista los mensajes ordenados por fecha con cliente, asunto, tipo y estado, filtrable por cliente, tipo y no atendidos.
- El listado de clientes muestra cuántos mensajes nuevos tiene cada uno.

**HU-33 · Enterarme al toque de una coactiva** — S · R2 · 3 pts · RF-122, RF-160
Como **contador responsable**, quiero una alerta inmediata cuando llega una resolución de cobranza coactiva, para actuar a tiempo.
- Dado un mensaje clasificado como crítico, entonces aparece resaltado en rojo y recibo una notificación en la app (y por correo si lo activé).

**HU-34 · Marcar un mensaje como atendido** — S · R2 · 2 pts · RF-124
Como **asistente**, quiero marcar un mensaje como atendido con un comentario, para que el equipo sepa que ya se gestionó.
- Cuando lo marco, entonces queda con mi nombre, fecha y comentario, y sale del filtro "no atendidos".

### Épica E10 · Prorrata e IGV

**HU-35 · Calcular la prorrata automáticamente** — S · R2 · 8 pts · RF-130 a RF-133
Como **contador**, quiero que el sistema calcule la prorrata con lo declarado en los últimos 12 meses, para no armarla en Excel.
- Al abrir la prorrata de octubre 2026, entonces veo los meses de octubre 2025 a septiembre 2026 con ventas gravadas y no gravadas, el origen de cada monto y el coeficiente resultante.
- Si falta un mes, entonces puedo ingresarlo a mano y queda marcado como "manual".

**HU-36 · Ver el IGV estimado del mes** — S · R2 · 3 pts · RF-134
Como **contador**, quiero ver el IGV a pagar o saldo a favor estimado, para anticipárselo al cliente.
- Se muestra: IGV de ventas − crédito DG − (crédito DGNG × prorrata) = resultado, con el detalle de cada componente.

### Épica E11 · Ajustes posteriores

**HU-37 · Corregir un periodo ya presentado** — S · R3 · 13 pts · RF-140, RF-141, RF-143
Como **contador**, quiero modificar un periodo cerrado y generar el archivo de ajuste, para corregir antes del plazo de SUNAT.
- Cuando abro un periodo presentado, entonces trabajo con la misma grilla, lupa y reglas, y genero el archivo de ajustes posteriores con prevalidación.

**HU-38 · Reclasificar meses anteriores en bloque** — S · R3 · 8 pts · RF-142
Como **contador**, quiero mover a DNG las compras de todo el año de un cliente de la selva, para corregir de una vez lo que el contador anterior dejó en DG.
- Dado un rango de periodos y un criterio (proveedor, clasificación actual), cuando aplico el cambio, entonces se generan los ajustes de cada periodo afectado con su resumen de impacto.

### Épica E12 · Auditoría y seguridad

**HU-39 · Saber quién cambió qué** — S · R2 · 3 pts · RF-150, RF-151
Como **dueño**, quiero ver el historial de cambios de un cliente, para saber quién modificó una compra o una credencial.
- Filtrando por cliente veo cada acción con usuario, fecha y valor anterior → nuevo, incluido cada uso de las credenciales por el sistema.

**HU-40 · Aislamiento entre estudios** — M · R1 · 5 pts · RNF-001
Como **dueño**, quiero la garantía de que ningún otro estudio puede ver mis clientes, para confiar mis claves SOL al sistema.
- Existe una prueba automática que, con dos tenants, intenta leer datos cruzados por API y por consulta directa con la sesión del otro tenant, y falla el build si devuelve algo.

---

## 5. Resumen del MVP (R1)

| Épica | Historias | Puntos |
|---|---|---|
| E1 Estudio y acceso | HU-01 a HU-04 | 11 |
| E2 Clientes y credenciales | HU-06 a HU-10 | 16 |
| E3 Ventas | HU-11, HU-12 | 8 |
| E4 Compras | HU-14 a HU-19 | 25 |
| E5 Lupa / XML | HU-20 a HU-22 | 18 |
| E6 Correcciones | HU-23 a HU-25 | 18 |
| E7 Generación | HU-26 | 5 |
| E12 Aislamiento | HU-40 | 5 |
| **Total R1** | **25 historias** | **106 pts** |

**Dependencia externa**: la fuente/API real de descarga de XML la entrega el equipo después. El MVP se construye y prueba con el simulador (RF-097a); conectar el proveedor real será una historia nueva acotada a implementar `XmlProvider`.
