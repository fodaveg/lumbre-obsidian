# Puntos de entrada

*Última actualización: 2026-09-18*

Todo se registra en `LumbrePlugin.onload` (`src/main.ts`). Los comandos van envueltos en
`this.command(id, fn)`, que apunta un evento `info` y usa `guarded` para que una excepción no se
escape sin registro. Los callbacks de Obsidian (procesadores de bloque, eventos del vault, ribbon)
van con `guarded(logger, acción, fn)` de `src/diagnostics/unhandled.ts`.

## Comandos de la paleta (`registerCommands`, `src/main.ts`)

Los 15, en el orden REAL en que los registra `registerCommands`:

| id | Nombre en la paleta (Obsidian antepone «Lumbre:») | Tipo | Qué hace |
|---|---|---|---|
| `send-task` | Enviar como tarea | `editorCallback` | `openSendModal` → `sendDraft` → cola `create` |
| `send-lines-as-tasks` | Enviar como tareas | `editorCallback` | `sendSelectionAsTasks`: una `create` por línea de la selección, en lotes de `POST /api/batch` (`src/send-lines/send-lines-flow.ts`) |
| `open-note-tasks` | Abrir las tareas de esta nota | `callback` | `openNoteTasksView` (hoja derecha) |
| `link-note-to-list` | Vincular esta nota a una lista | `checkCallback` (nota activa) | `ListSuggestModal` → `applyListLink`: escribe `lumbre-list` y encola `listLink` |
| `unlink-note-from-list` | Quitar el vínculo con la lista | `checkCallback` (nota con `lumbre-list`) | borra la propiedad y encola `unlink` con la url guardada |
| `create-list-from-note` | Crear una lista con el nombre de esta nota y vincularla | `checkCallback` (nota activa) | `createListFromNoteCommand` (`src/lists/create-list-from-note.ts`): crea la lista por `enqueueMutation` y, confirmada, la vincula como `link-note-to-list` |
| `brl-entry` | Anotar en el BRL | `editorCallback` | `BrlEntryModal` → `sendBrlEntry` → cola `brl` |
| `insert-brl-today` | Insertar el BRL de hoy como texto | `editorCallback` | `insertBrlToday`: foto fija, no pega si la lectura falla |
| `insert-weekly-snapshot` | Insertar la foto semanal | `editorCallback` | `insertWeeklySnapshot`: foto fija, no pega si fallan los tres apartados |
| `save-note-to-task` | Guardar esta nota en la tarea | `editorCallback` | `saveNoteToTask` → `SaveNoteModal` → cola `notes` |
| `save-note-to-list` | Guardar esta nota como notas de la lista | `checkCallback` (nota con `lumbre-list`) | `saveNoteToList` (`src/lists/list-notes-flow.ts`): reutiliza `note-snapshot.ts` y encola `setListNotes` por `enqueueMutation` |
| `register-habit` | Registrar hábito | `callback` | `RegisterHabitModal` → `registerHabitEntry` (`src/habits/register-habit-flow.ts`): `habitId` = el nombre tal cual, `enqueueMutation` con `check: 'none'` |
| `soplo-selection` | Soplo con la selección | `editorCallback` | `openSoploModal(file, soploSource(editor))` |
| `export-to-vault` | Guardar una copia de exportación en el vault | `callback` | `runExportToVault` → `GET /api/export` → `vault.create/modify` |
| `show-diagnostics` | Mostrar diagnóstico | `callback` | `DiagnosticsModal` |

Menú contextual del editor (`workspace.on('editor-menu')`): «Enviar a Lumbre» y «Soplo con la
selección».

Ribbon: icono `flame` (`NOTE_TASKS_ICON`) que abre el panel.

## Menú contextual del explorador

`workspace.on('file-menu')` sobre cualquier `TFile` (una carpeta no lleva ninguna entrada).
`fileMenuItems` (`src/file-menu/file-menu-items.ts`, puro) decide qué entradas le tocan al
fichero por su extensión:

- **Vincular a una lista**: solo sobre un `.md` (`linkToList`). Reutiliza `linkNoteToList`
  (`main.ts`), la misma acción que el comando `link-note-to-list`.
- **Adjuntar a una tarea de Lumbre**: sobre CUALQUIER fichero, incluida una nota (`attachToTask`).
  `attachFileFromMenu` abre el selector de tarea y sube por `client.uploadAttachment`; el tope de
  25 MB lo comprueba `attachments/upload.ts` al elegir la tarea.

## Barra de estado

`src/status-bar/status-bar.ts` (puro) + `main.ts` (`addStatusBarItem`). Solo en escritorio:
Obsidian no la pinta en móvil, así que `main.ts` no la registra con `Platform.isMobile`. Prioridad
de lo que se enseña, de más a menos urgente: token rechazado, sin conexión, operaciones con error
(rechazadas o agotadas, no se arreglan solas), operaciones pendientes. Con todo en orden el texto
queda vacío y el elemento no ocupa sitio. Se repinta con el mismo canal que panel y bloques
(`notifyDataChange`) y con `online`/`offline`; el clic abre `DiagnosticsModal`.

## Protocolo `obsidian://lumbre/*`

`src/protocol/protocol-router.ts` (puro) + `registerProtocolHandlers` (`main.ts`), para disparar
el plugin desde Atajos de iOS sin pasar por la paleta. `registerObsidianProtocolHandler` no admite
comodines, así que se registran tres acciones EXACTAS:

- `lumbre/send` (`obsidian://lumbre/send?title=…`): abre `SendTaskModal` con el título ya puesto.
  El título es texto EXTERNO: `parseSendTitle` lo recorta a `MAX_TITLE_LENGTH` antes de que llegue
  a ninguna parte, y solo se apunta en `debug` recortado a 80 (`shortTitle`).
- `lumbre/open` (`obsidian://lumbre/open`): abre el panel de tareas.
- `lumbre` a secas: la ruta de un Atajo viejo o mal escrito. Cae en `unknown` por
  `routeForAction`; `main.ts` la apunta y la ignora, nunca lanza.

## Ficha de referencia a tarea

`registerMarkdownPostProcessor` monta `RefChipRenderer` (`src/blocks/ref-chip-postprocessor.ts`)
sobre el enlace interno SIN RESOLVER que pinta Obsidian para `[[task:ID|Etiqueta]]` (lo que copia
la app de Lumbre al portapapeles; `list:ID` se deja fuera). Añade estado y fecha a continuación
(`ref-chip-format.ts`, leído en lote por `RefTaskCache`, `ref-chip-cache.ts`, TTL 30 s) e
intercepta el clic para abrir la tarea en Lumbre en vez de dejar que Obsidian intente crear el
fichero. Nunca escribe en la nota; solo lee.

## Menú por tarea

`src/ui/task-menu.ts` (`mountTaskMenu`) monta el mismo menú corto en el panel y en el bloque
```lumbre```: botón «⋯» en la fila (para móvil, sin clic derecho fiable) más el clic derecho sobre
la fila entera. Qué entradas salen lo decide `task-menu-items.ts` (puro); qué se manda,
`task-menu-ops.ts`. Reglas de exclusión, cada una tapa un modo de fallo medido contra el repo de
Lumbre:

- **Archivada**: ningún menú.
- **Cancelada**: solo «Restaurar».
- **Recurrente** (`recurrence` o `seriesId` presentes): sin reprogramar, porque el id visible es
  la semilla de la serie entera desde el 16 sep 2026.
- **Subtarea** (`parentId` no nulo): sin mover de lista, sin sección, sin subtareas propias.
- **Sin lista**: sin «Mover a otra sección».

## Bloques de código

| Lenguaje | Constante | Clase | Caché |
|---|---|---|---|
| ```` ```lumbre ```` | `LUMBRE_BLOCK_LANGUAGE` (`src/blocks/task-block.ts`) | `LumbreTaskBlock` | `QueryCache` |
| ```` ```lumbre-brl ```` | `LUMBRE_BRL_BLOCK_LANGUAGE` (`src/blocks/brl-block.ts`) | `LumbreBrlBlock` | `BrlCache` |

Registro con `registerMarkdownCodeBlockProcessor`; el procesador hace `ctx.addChild(new ...Block(el,
source, ctx.sourcePath, host))`. El host (`taskBlockHost()` / `brlBlockHost()` en `main.ts`) se crea
por bloque pero comparte las instancias del plugin.

Ciclo de `LumbreTaskBlock`: `onload` → `parseQuery` (si falla: pinta el error, no se suscribe) →
`host.onDataChange(render)` → `start()`: `lists.get()` solo si la consulta o la nota nombran una
lista → `resolveQuery` → `cache.subscribe` → `cache.peek` → render → `cache.get`. `onunload`
suelta las dos suscripciones. La entrada de caché sobrevive 10 min sin suscriptores
(`IDLE_ENTRY_TTL_MS`) porque en modo lectura el bloque se remonta con cada edición.

## Vista lateral

`NoteTasksView extends ItemView` (`src/ui/note-tasks-view.ts`), tipo `lumbre-note-tasks`
(`NOTE_TASKS_VIEW_TYPE`), registrada con `registerView`. Se abre en la hoja derecha. Escucha
`host.onDataChange`, `active-leaf-change`, `file-open`, `metadataCache.changed` y `online/offline`.
Pinta: cabecera con estado de red, aviso de token, tareas vinculadas (`LinkStore.linksForNote`),
buscador (`searchTasks`, una sola lectura `scope: all` filtrada en cliente) y, si la nota tiene
`lumbre-list`, la lista agrupada por sección. El botón «Reintentar» del error llama a
`client.unlockReads('panel')`.

## Eventos del vault

`vault.on('rename' | 'delete' | 'create')` y `workspace.on('editor-menu')`. Detalle en
[vault-events.md](./vault-events.md).

## Temporizadores (`registerInterval`, todos a 60 s)

| Arranque | Módulo | Guardas | Efecto |
|---|---|---|---|
| `startQueueDrain` | `src/lumbre/queue-drain.ts` | online y `queue.actionable()` no vacío | `queue.flush()` |
| `startChangeFeedPoll` | `src/lumbre/change-feed.ts` | hay suscriptores o panel abierto, online, pestaña visible, pestillo suelto | `ChangeFeed.poll()` → refrescos |
| `sweepOrphanedNoteListLinks` | `main.ts` | huérfanos pasados de `ORPHAN_GRACE_MS` (30 s) y nota aún ausente | encola `listLink unlink` |
| `sweepOrphanedTaskLinks` + `backfillTaskLinks` | `main.ts` | ídem; backfill de 40 por pasada (`TASK_LINK_BACKFILL_BATCH`) | encola `taskLink unlink` / `link` |

Además: `window` `online` → `flushIfConnected`; `window` `error` y `unhandledrejection` →
`unhandledEvent` filtrado por la marca `plugin:lumbre` del stack.

## API pública

`app.plugins.plugins.lumbre.api` (`src/api/lumbre-api.ts`, contrato en `docs/API.md`). Mutan solo
`createTask`, `completeTask` y `reopenTask`, todas por la cola. `listTasks` va por `QueryCache`;
`weeklySnapshot` y `exportToVault` delegan en `main.ts`. Emite `lumbre:tasks-changed` en el
workspace (`TASKS_CHANGED_EVENT`) y ofrece `on('tasks-changed' | 'connection-changed')`.

Desajuste conocido entre código y `docs/API.md` (medido el 18 sep 2026, corrige el que constaba
aquí el 14 sep 2026): `LumbreQueryInput` YA declara `notes`, `context` y `title`, más `priority`,
`deadline`, `sort` y `group`. Sigue sin comprobar: la doc de `weeklySnapshot` dice «una petición
por lista» pero ese es solo el camino de repliegue cuando el pool `scope: all` falla o llega
recortado.

## Flujo representativo: Soplo

1. `openSoploModal` recorta el texto a `MAX_AGENT_PROMPT_LENGTH` (4000) y abre `SoploModal`.
2. `SoploModal.ask()` consulta `client.agentConsent()`; con `missing` el texto no sale del
   dispositivo. Luego `client.agent(prompt)` (`POST /api/agent`, siempre previsualización).
3. Se pinta `plan.preview` con una casilla por ítem, todas marcadas.
4. «Aplicar» → `applySoploPlan` → `planToBatches(plan.plan, checked)` (`src/soplo/plan-to-ops.ts`):
   por índice, `add` → `create` con `clientTaskId` = id del plan, `mutation` → `mutateRaw` verbatim,
   `brl` y `habit` se cuentan como saltados, lotes de `MAX_BATCH_OPS` (200).
5. Un `queue.enqueueBatch` por lote, vínculos locales en `pending_local`, `flush`,
   `reportSoploOutcome` traduce `failedItems` a posiciones del plan entero.
6. Si `apply` lanza, `runApply` (`src/soplo/apply-flow.ts`) devuelve el fallo y «Reintentar»
   vuelve a aplicar sin remandar el texto a Soplo.
