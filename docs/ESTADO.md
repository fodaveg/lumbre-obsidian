# Estado

- **Versión**: 0.1.2 (publicada para BRAT).
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
    Bearer, así que un plugin no puede consultarlo.
  - `BrlCache` va aparte de `QueryCache` y comparte con ella la constante del TTL: lo que guardan es
    distinto (Markdown de un día contra `LumbreTask[]` de una consulta).
  - «Insertar el BRL de hoy» NO sirve una lectura vieja si la relectura falla, a diferencia del
    bloque: eso escribe en la nota, y un texto de hace media hora pegado en el fichero ya no se
    distingue del de ahora.
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
