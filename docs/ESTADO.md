# Estado

- **Versión**: 0.1.1 (publicada para BRAT).
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
- **Qué falta**: la API pública para Dataview y js-engine, y la decisión de dónde vive el token; las
  tareas están en la lista `lumbre-obsidian` de Lumbre, no aquí.
- **Decisiones de este lote**: las listas se cachean en memoria cinco minutos (`ListCache`), no en
  `data.json`; las secciones de la lista de proyecto se agrupan en cliente por el `section` que ya
  trae cada tarea, sin usar `includeSections=1`, que el cliente todavía no soporta.
