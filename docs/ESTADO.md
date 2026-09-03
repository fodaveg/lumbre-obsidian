# Estado

- **Versión**: 0.1.5 (publicada para BRAT).
- **Qué hay**: esqueleto del plugin, ajustes (origen + token), botón de prueba de conexión, gate
  `npm run check`, CI y workflow de release para BRAT con los tres assets sueltos.
- **Qué hay (lote A)**: cliente HTTP completo (`listTasks`, `getTask`, `getTasksByIds`, `listLists`,
  `createTask`, `mutate`, `batch`, `flush` compartido), cola durable de escrituras que releen antes de
  darse por materializadas, mapa nota ↔ tarea por ruta con listeners de rename y delete, y el almacén
  único de `data.json` que migra desde el formato anterior sin perder el token. Todo con tests; sin UI.
- **Qué hay (lote B, la primera interfaz)**:
  - Comando **Enviar como tarea** (paleta y menú contextual del editor, donde se llama «Enviar a
    Lumbre»): modal con título prefijado con la selección o la línea del cursor, lista, fecha o
    «Algún día», hora, prioridad, fecha límite, notas y subtareas. Encola un `create`, crea el
    vínculo en pendiente y drena. El Markdown de la nota no se toca.
  - Panel lateral **Tareas de esta nota** (`lumbre-note-tasks`, ribbon y comando): sigue a la nota
    activa, enseña las tareas vinculadas con checkbox, chip de estado y «Abrir en Lumbre»,
    «Desvincular» con confirmación en línea y «Reintentar» sobre las operaciones con error
    recuperable; buscador para vincular una tarea que ya existe; y, si la nota tiene `lumbre-list`,
    las tareas de esa lista agrupadas por sección.
  - Comandos **Vincular esta nota a una lista** y **Quitar el vínculo con la lista**: escriben o
    borran la propiedad `lumbre-list` del frontmatter con `processFrontMatter`. Es la ÚNICA
    escritura del plugin dentro de una nota.
  - Módulos puros con tests: `src/ui/draft-from-editor.ts`, `src/ui/link-chip-state.ts`,
    `src/ui/search-filter.ts`, `src/ui/task-sections.ts` y `src/lumbre/list-cache.ts`.
- **Qué hay (lote C, el bloque y la API)**:
  - Bloque de código ```` ```lumbre ```` (`registerMarkdownCodeBlockProcessor`), renderizado en vivo
    y sin tocar el Markdown: consulta en líneas `clave: valor` (`scope`, `list`, `section`, `days`,
    `tag`, `includeDone`, `limit`, `title`), cabecera con título o descripción y botón «Actualizar»,
    casilla que completa o reabre por la cola, punto de prioridad, fecha o «Algún día», deadline con
    icono, canceladas tachadas sin casilla, agrupación por sección cuando la consulta es de una
    lista, estado vacío y pie con «Datos de HH:MM» más el aviso de que se enseña la última lectura.
  - `src/blocks/query-parser.ts`: parser propio y tolerante, con la resolución contra el
    `lumbre-list` de la nota y el catálogo de listas, la clave de caché y el filtro en cliente.
  - `src/blocks/query-cache.ts`: una entrada por consulta, TTL de 30 s, peticiones en vuelo
    deduplicadas, suscriptores por bloque y `refreshAll()` de golpe cuando la cola materializa.
  - `src/api/lumbre-api.ts`: la API pública (`app.plugins.plugins.lumbre.api`), documentada en
    `docs/API.md`, con `version`, `isConnected`, `listTasks`, `getTask`, `listLists`, `createTask`,
    `completeTask`, `reopenTask`, `linksForNote`, `openInLumbre` y `on(...)`. Todo lo que muta pasa
    por la cola; además dispara `lumbre:tasks-changed` en el workspace.
- **Qué hay (lote D, el BRL, Soplo y los adjuntos)**:
  - Comando **Anotar en el BRL**: modal mínimo (un campo de texto prefijado con la selección y dos
    botones, «Nota» y «Pensamiento»). Encola un `createBrlEntry` por la cola durable, con su
    relectura propia (`GET /api/brl/<fecha>?format=json`, buscando el id que fijó el plugin), y
    avisa con un Notice al encolar.
  - Bloque de código ```` ```lumbre-brl ````: cuerpo opcional `date: today|YYYY-MM-DD`, el Markdown
    del registro pintado con `MarkdownRenderer.render`, pie con «Datos de HH:MM» y botón
    «Actualizar». Caché propia con el mismo TTL de 30 s (`BrlCache`), clave por día.
  - Comando **Insertar el BRL de hoy como texto**: pega el Markdown en el cursor. Foto fija.
  - Comando **Soplo con la selección** (paleta y menú contextual): manda la selección o el párrafo
    del cursor a `POST /api/agent`, que corre siempre en modo previsualización, y abre un modal con
    el texto original arriba y una casilla por acción del plan, todas marcadas. «Aplicar» manda solo
    lo marcado por `POST /api/batch` a través de la cola y vincula a la nota las tareas creadas.
  - Acción **Adjuntar fichero…** por tarea en el panel: `SuggestModal` con los ficheros no-Markdown
    del vault, lectura con `app.vault.readBinary` y subida directa por `POST /api/attachments`. El
    panel enseña el número de adjuntos cuando la API lo devuelve en la tarea.
  - Módulos puros con tests: `src/brl/brl-ops.ts`, `src/soplo/plan-to-ops.ts`,
    `src/attachments/upload.ts`. El cliente gana `brl`, `brlJson`, `agent` y `uploadAttachment`.
  - Deuda de tipos cerrada: `LumbreList.pinned` y `LumbreTask.attachmentCount`, con los JSDoc de
    `someday`/`time`/`rolloverCount` e `icon`/`color`/`parentListId` puestos al día (Lumbre los
    sirve desde su SHA `861cfb4d`; los valores por defecto cubren un servidor anterior).
- **Decisiones del lote D**:
  - Las mutaciones del plan de Soplo viajan **verbatim** (`BatchOperation` de tipo `mutateRaw`): el
    `kind` y el `payload` los escribió Lumbre y son lo que describía la línea que el usuario aprobó.
    Traducirlos a la `MutationOp` del plugin recortaría los campos que el plugin no modela, o sea
    aplicaría algo distinto de lo aprobado.
  - El plan y su preview se emparejan **por índice**, que es como los construye el servidor
    (`buildPreview` hace un `map` sobre el plan). Una acción sin su línea de preview se descarta:
    no se aplica lo que no se ha visto.
  - Las acciones de BRL y de hábitos del plan no se aplican: `POST /api/batch` solo entiende de
    tareas. Se cuentan y se dicen en el Notice, en vez de tragárselas.
  - Los adjuntos NO van por la cola. La cola persiste en `data.json`, que viaja por Obsidian Sync, y
    meter ahí los bytes de un fichero de 25 MB hincharía el fichero de datos del plugin.
  - `POST /api/attachments` va con `Content-Type: application/octet-stream` SIEMPRE y el mime real
    en `x-lumbre-content-type`: SvelteKit rechaza con 403, antes del handler, un POST cuyo
    `Content-Type` sea uno de los cuatro que trata como formulario, y `text/plain` es uno de ellos.
  - La falta de consentimiento de Soplo se detecta por el **403 de `POST /api/agent`**, no por
    `GET /api/agent/consent`: ese endpoint es solo por cookie de sesión y responde 401 a un token
    Bearer, así que un plugin no puede consultarlo. **Corregido en el lote E**: Lumbre acepta ahí el
    Bearer, se pregunta antes de mandar, y el 403 del POST se queda como red de seguridad para un
    servidor anterior al cambio.
  - `BrlCache` va aparte de `QueryCache` y comparte con ella la constante del TTL: lo que guardan es
    distinto (Markdown de un día contra `LumbreTask[]` de una consulta).
  - «Insertar el BRL de hoy» NO sirve una lectura vieja si la relectura falla, a diferencia del
    bloque: eso escribe en la nota, y un texto de hace media hora pegado en el fichero ya no se
    distingue del de ahora.
- **Qué hay (lote F, el registro de diagnóstico)**:
  - `src/diagnostics/logger.ts`: `Logger` con cuatro niveles, `child(module)` para etiquetar la
    pieza (`http`, `queue`, `links`, `cache`, `block`, `panel`, `modal`, `api`, `settings`, `vault`,
    `main`) y salida DOBLE: consola filtrada por el nivel de Ajustes, y buffer circular de 1000
    eventos SIEMPRE, con independencia del nivel.
  - `src/diagnostics/redact.ts`: sustituye el token (y cualquier secreto) por `«token»` en cadenas,
    claves y valores anidados; tapa el valor de las claves prohibidas (todo lo que acabe en
    `authorization`, `token`, `apikey`, `bearer`, `password` o `secret`); recorta las cadenas a 200
    caracteres y aguanta ciclos, arrays largos y valores no serializables.
  - `src/diagnostics/errors.ts`: `describeError` (`name`, `message`, `status?`, `reason?`), con
    stack solo cuando se pide, o sea solo en `debug`.
  - `src/diagnostics/report.ts`: `buildReport()`, el texto plano que se copia. Entorno, conexión,
    cola por estado con las 10 últimas operaciones, vínculos, cachés con la edad de la entrada más
    vieja y los últimos N eventos (300 por defecto).
  - `src/diagnostics/unhandled.ts`: `guarded(logger, acción, fn)` para los callbacks que el plugin
    registra, y `unhandledEvent` para los `error` y `unhandledrejection` de la ventana.
  - `src/diagnostics/log-files.ts`: los informes guardados (`logs/lumbre-<fecha>-<hora>.log`, los 10
    últimos) y el registro en vivo (`logs/lumbre-live.log`, rotación a 1 MB con una vuelta anterior).
  - `src/diagnostics/diagnostics-modal.ts` y el comando **Mostrar diagnóstico**.
  - Instrumentado: cliente (una línea por petición con método, ruta sin origen, status, ms y bytes;
    aviso a los 3 s y al pasar de 100 peticiones por minuto), cola (cada transición con `from → to`,
    intentos y motivo, y cada `flush`), vínculos, las dos cachés, los dos bloques, el panel, los
    modales, los ajustes y la API pública.
  - Ajustes: sección «Diagnóstico» con el nivel, «Copiar registro», «Guardar registro en el vault»,
    el interruptor del registro en fichero y un resumen de estado de dos líneas.
  - API pública: `api.diagnostics.report()` y `api.diagnostics.events(n)`.
- **Decisiones del lote F**:
  - El buffer se llena con TODO, también con los `debug`, aunque el nivel sea `info`. El nivel solo
    filtra la consola. Si filtrara el buffer, «Copiar registro» tras un fallo traería justo lo que
    no sirve: los eventos posteriores a subir el nivel, nunca los de antes.
  - El token vive además en memoria (`secrets` de `main.ts`) porque `redact` es SÍNCRONO y
    `tokenStore.get()` no. Es la única forma de COMPROBAR que un evento no lo lleva, en vez de
    confiar en que cada llamador se acuerde. El almacén del token va envuelto para que un cambio en
    los ajustes actualice esa copia.
  - Nada de lo que escribe el usuario entra en `info`: ni el título de una tarea (solo en `debug` y
    recortado a 80), ni el texto de una entrada del BRL, ni lo que se busca en el panel, ni el texto
    que se manda a Soplo. De ellos van el recuento y la longitud. Sí van las RUTAS de las notas y el
    texto de la consulta de un bloque: la ruta es lo que identifica un vínculo y la consulta es una
    instrucción al plugin, no contenido.
  - `guarded` NO relanza. Relanzar desde un handler de Obsidian no arregla nada y se lleva por
    delante lo que viniera detrás; lo que faltaba era el contexto, y eso es lo que apunta.
  - Los errores de la ventana se filtran por la marca `plugin:lumbre` del stack. Sin ella son de
    otro plugin y solo se apuntan en `debug`: la consola de Obsidian es de todos.
  - `PLUGIN_DATA_VERSION` sube a 2 por los dos ajustes nuevos (`logLevel`, `liveLog`). Un
    `data.json` de la 1 los estrena en su valor por defecto sin perder nada, y `PluginStore` guarda
    de qué versión venía para poder apuntarlo al arrancar.
  - El nombre del fichero de informe lleva la hora como `HHMMSS`, sin dos puntos: un `:` en un
    nombre dentro del vault mete a Obsidian Sync en bucle.
- **Qué hay (lote E, la foto semanal)**:
  - `src/review/weekly-snapshot.ts`: `buildWeeklySnapshot(deps, options)` compone el Markdown de la
    revisión con tres apartados. **Vencidas y arrastradas** (`scope: overdue` más lo que tenga
    `rolloverCount >= 3`), **Listas sin próxima acción** (listas con pendientes y ninguna con fecha,
    agrupado en cliente) y **Muestra de Algún día** (5 tareas, semilla del día). Sin red propia: el
    cliente entra por inyección. Módulo puro con tests.
  - Comando **Insertar la foto semanal**: pega ese texto en el cursor. Foto FIJA, como la del BRL.
  - API pública: `api.weeklySnapshot(options?)`, documentada en `docs/API.md` con el ejemplo de
    Templater.
  - `client.agentConsent()`: `GET /api/agent/consent` con el token Bearer, que Lumbre va a aceptar.
    Devuelve `granted | missing | unknown`. El modal de Soplo lo consulta ANTES de mandar el texto:
    con `missing` enseña el aviso con el enlace a `<origen>/settings` y no manda nada.
  - `LumbreTask.rolloverCount` pasa a OPCIONAL, como `attachmentCount`: ausente es "la fila cruda no
    lo traía", que es lo que hace posible distinguirlo de un cero de verdad.
- **Decisiones del lote E**:
  - `rolloverCount` ausente contra cero. Sin esa distinción, un Lumbre anterior al SHA `861cfb4d`
    haría que la foto dijera "0 arrastradas", que es una mentira con forma de dato. Ahora el
    apartado dice «arrastradas: este Lumbre no lo informa» cuando NINGUNA tarea viva trae el campo.
    Esto cambia el tipo público: `taskFromDraft` ya no pone `0` y `taskFromApi` solo lo copia si
    viene.
  - Las arrastradas se buscan en una lectura de `scope: all`, no en un scope propio: ningún scope
    del servidor filtra por `rolloverCount`, así que el filtro es de aquí. Son dos peticiones para
    ese apartado, no una.
  - Las listas se recorren ENTERAS, sin saltarse las de `taskCount: 0`: ese contador también sale en
    cero contra un servidor que no lo manda, y usarlo para ahorrar peticiones vaciaría el apartado
    justo en el caso que interesa.
  - El intervalo entre peticiones por lista sale de `REQUESTS_PER_MINUTE_WARN` del cliente
    (`60_000 / 100` = 600 ms), no de un número a ojo: el apartado gasta una petición por lista y el
    límite del servidor es 120/min.
  - La muestra de «Algún día» se ordena por el hash de `semilla + id` y se cortan las cinco
    primeras, en vez de barajar: así depende SOLO de la semilla y de los ids, no del orden de
    llegada. La semilla por defecto es el día local, así que la foto de la mañana y la de la tarde
    coinciden.
  - Con los TRES apartados en rojo, el comando no pega nada (lo que quedaría en la nota serían tres
    líneas de error). Con uno o dos sí pega: la línea dice cuál falló y el texto no miente.
  - `weeklySnapshot` NO va por la caché de consultas: una foto es de ahora, no de hace 30 segundos.
    Y `notes: 'none'` en todas sus lecturas, que las notas largas no hacen falta para esto.
  - `agentConsent()` trata el 401 como `unknown`, no como token malo: un Lumbre anterior al cambio
    responde 401 a un token VÁLIDO porque ese endpoint solo aceptaba la cookie de sesión. Esto
    corrige la decisión del lote D, que daba el endpoint por inconsultable desde el plugin; el 403
    del `POST /api/agent` sigue detectándose igual, y es lo que cubre a ese Lumbre anterior.
- **Qué falta**: la decisión de dónde vive el token; las tareas están en la lista `lumbre-obsidian`
  de Lumbre, no aquí.
- **Decisiones del lote B**: las listas se cachean en memoria cinco minutos (`ListCache`), no en
  `data.json`; las secciones de la lista de proyecto se agrupan en cliente por el `section` que ya
  trae cada tarea, sin usar `includeSections=1`, que el cliente todavía no soporta.
- **Decisiones del lote C**:
  - Nombrar una lista sin escribir `scope` significa la lista ENTERA (`scope: all`), no lo de hoy de
    esa lista. Vale igual para el `lumbre-list` de la nota.
  - La clave de caché se calcula sobre lo que se PIDE al servidor, no sobre lo escrito: dos bloques
    con el mismo `scope` y distinto `title` comparten una sola petición.
  - Con `tag`, el `limit` NO viaja al servidor (recortaría antes de filtrar) y se aplica en cliente.
  - La caché guarda las entradas aunque se queden sin bloques montados: en modo lectura un bloque se
    desmonta y se remonta con cada edición, y conservarlas es lo que evita la petición y el parpadeo.
  - El bloque no lleva «Abrir en Lumbre» por tarea: son filas densas y una lista de 200 tareas se
    llenaría de elementos enfocables. Para saltar a Lumbre están el panel y `api.openInLumbre(id)`.
  - `OperationQueue` gana un `onMaterialized`: es el único punto en que un cambio deja de ser una
    promesa, y de ahí cuelga la invalidación de la caché de los bloques.
