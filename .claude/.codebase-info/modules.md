# Módulos por carpeta de `src/`

*Última actualización: 2026-09-14*

Convención: cada carpeta separa lo PURO (sin `obsidian`, testeado con Vitest sin mock) de la
pieza de UI que lo consume. Los tests van junto al módulo (`x.test.ts`). Solo importan `obsidian`
los ficheros marcados con «UI».

### `src/main.ts`
- **Qué es:** `LumbrePlugin`, 2000 líneas de cableado. Construye todo en `onload`, registra
  comandos, bloques, vista, eventos, temporizadores; contiene los flujos de usuario
  (`sendDraft`, `sendBrlEntry`, `applySoploPlan`, `uploadAttachment`, `writeExportToVault`,
  `saveNoteToTask`, `linkNoteToList`, barridos) y los hosts (`taskBlockHost`, `brlBlockHost`,
  `noteTasksHost`).
- **Bus interno:** `dataListeners` + `notifyDataChange()`: repinta panel y bloques sin red.
- **Test:** `main.test.ts` solo cubre que `onunload` no lanza tras un `onload` fallido.

### `src/lumbre/` (dominio, sin `obsidian`)
| Fichero | Exports clave | Consumidores |
|---|---|---|
| `client.ts` | `LumbreClient`, `LumbreResult`, `FailureReason`, `MutationOp`, `BatchOperation`, `AgentPlan`, constantes de cupo (`TASKS_RATE_LIMIT` 120, `MUTATIONS_RATE_LIMIT` 60, `AGENT_RATE_LIMIT` 30, `EXPORT_RATE_LIMIT` 10…), `MAX_BATCH_OPS` 200, `MAX_TASKS_LIMIT` 500, `MAX_ATTACHMENT_BYTES` 25 MB, `MAX_AGENT_PROMPT_LENGTH` 4000, `translateOp`, `describeFailure` | todos los que hacen red |
| `queue.ts` | `OperationQueue`, `QueuedOperation` (7 kinds), `OperationState`, `pruneQueue`, `describeFailedItems`, `MAX_ATTEMPTS` 5 | `main.ts`, panel, API, `operation-actions` |
| `queue-drain.ts` | `startQueueDrain`, `drainQueueOnce`, `QUEUE_DRAIN_INTERVAL_MS` 60 s | `main.ts` |
| `change-feed.ts` | `ChangeFeed`, `startChangeFeedPoll`, `pollChangeFeedOnce`, `CHANGE_FEED_INTERVAL_MS` 60 s, `CHANGE_FEED_MAX_PAGES` 20 | `main.ts` |
| `list-cache.ts` | `ListCache` (`get`, `refFor`, `nameFor` por id o nombre normalizado), `DEFAULT_LIST_TTL_MS` 5 min | `main.ts`, bloque, panel, API |
| `types.ts` | `LumbreTask`, `LumbreList`, `TaskDraft`, `taskFromApi`, `taskFromDraft`, `draftToIngestBody`, `taskDeepLinks`, `DEFAULT_WEB_ORIGIN` | transversal |

Notas: `task.list` se construye desde `row.somedayListId` + `row.list` (`types.ts`, `refFrom`).
`rolloverCount`, `attachmentCount`, `updatedAt` son opcionales: ausente significa «el servidor no
lo trae», distinto de cero.

### `src/blocks/`
| Fichero | Exports clave | Notas |
|---|---|---|
| `query-parser.ts` (puro) | `parseQuery`, `resolveQuery`, `queryParams`, `queryKey`, `applyClientFilters`, `describeQuery`, `QUERY_SCOPES` | `limit` viaja siempre (500 por defecto); con `tag` el recorte es en cliente; `context: full` fuerza `notes: full`; `context` entra en `queryKey` aunque no viaje |
| `query-cache.ts` (puro) | `QueryCache` (`subscribe`, `peek`, `get`, `refreshAll`, `refreshSoon`, `hasSubscribers`, `stats`), `DEFAULT_QUERY_TTL_MS` 30 s, `REFRESH_COALESCE_MS` 250, `IDLE_ENTRY_TTL_MS` 10 min, `SUBTASK_CACHE_TTL_MS` 2 min | dedupe por `inFlight`; en fallo conserva la última lectura y anota `error`; subtareas de `context: full` solo para las 20 primeras (`CONTEXT_SUBTASK_TASK_CAP`) |
| `task-context.ts` (puro) | `noteExcerpt`, `contextStateLabel`, `subtaskGlyph`, `subtaskItems`, `CONTEXT_SUBTASK_TASK_CAP` 20 | subtareas con `✓`/`○`, nunca casilla |
| `block-footer.ts` (puro) | `staleNote`, `partialNote`, `contextSubtasksLimitedNote` | también lo usa el panel |
| `block-log.ts` (puro) | `logInvalidBlock` | el cuerpo del bloque solo en `debug` |
| `task-block.ts` (UI) | `LumbreTaskBlock`, `TaskBlockHost`, `LUMBRE_BLOCK_LANGUAGE` | usa `createFragment` global de Obsidian |
| `brl-cache.ts` (puro) | `BrlCache` | clave por día; sin `refreshSoon` ni `hasSubscribers`; 403 → «add-on BRL desactivado» |
| `brl-block.ts` (UI) | `LumbreBrlBlock`, `BrlBlockHost`, `LUMBRE_BRL_BLOCK_LANGUAGE` | pinta con `MarkdownRenderer.render` |

### `src/links/`
| Fichero | Exports clave | Notas |
|---|---|---|
| `link-store.ts` (puro) | `LinkStore` (`link`, `unlink`, `setDeepLink`, `refresh`, `renamePath`, `markDeleted`, `markCreated`, `linksForNote`, `notesForTask`, `entriesUnder`), `LumbreTaskLink`, `movedPath`, `renameTaskLinkChanges`, `taskLinksPastGrace`, `MANY_LINKS_WARNING` 50 | guarda una caché de la tarea y su `syncState`; `deepLink` opcional |
| `note-list-link-store.ts` (puro, cero imports) | `NoteListLinkStore`, `ORPHAN_GRACE_MS` 30 s, `orphansPastGrace`, `renameListLinkChanges`, `applyRenameListLinks` | una entrada por ruta; guarda la url exacta enviada |
| `note-list.ts` (UI, tipos) | `NOTE_LIST_PROPERTY`, `readNoteListId`, `writeNoteListId` | única escritura en la nota |
| `deep-link.ts` (puro) | `buildObsidianDeepLink`, `noteLinkLabel`, `notePathWithoutExtension` | `encodeURIComponent`, no `URLSearchParams` |

### `src/ui/`
| Fichero | Exports clave | Notas |
|---|---|---|
| `note-tasks-view.ts` (UI) | `NoteTasksView`, `NoteTasksHost`, `NOTE_TASKS_VIEW_TYPE`, `NOTE_TASKS_ICON` | 724 líneas; declara su host para no importar `main.ts` |
| `send-modal.ts` (UI) | `SendTaskModal`, `splitSubtasks` | `splitSubtasks` sin test propio |
| `list-suggest-modal.ts` (UI) | `ListSuggestModal` | |
| `draft-from-editor.ts` (puro) | `draftFromEditor`, `stripListMarker`, `MAX_TITLE_LENGTH` 300, `MAX_EXCERPT_LENGTH` 240 | |
| `link-chip-state.ts` (puro) | `linkChipState`, `pendingOperationFor` (la más reciente) | lo usan panel y bloque |
| `open-in-lumbre.ts` (usa `Platform`) | `openTaskInLumbre` | `lumbre://` solo en macOS escritorio, repliegue a web |
| `operation-actions.ts` (puro) | `operationActions`, `isStuck` | «Reintentar» y «Descartar» |
| `search-filter.ts` (puro) | `normalizeForSearch` (NFD, sin diacríticos, ñ → n), `filterTasks` | el módulo más reutilizado (6 consumidores) |
| `task-search.ts` (puro) | `searchTasks` | una lectura `scope: all`, límite 500, marca `partial` |
| `task-sections.ts` (puro) | `groupBySection`, `UNSECTIONED_NAME` | «Sin sección» primero |
| `task-state-labels.ts` (puro) | `taskStateLabels` | chips «Cancelada», «Archivada» |

### `src/soplo/`
- `plan-to-ops.ts` (puro): `planToBatches` → `planToOps` por índice; `add` → `create` con
  `clientTaskId` = id del plan; `mutation` → `mutateRaw` verbatim; `brl`/`habit` → saltados;
  lotes de 200.
- `apply-flow.ts` (puro): `runApply` nunca lanza; devuelve `ApplyOutcome`.
- `soplo-modal.ts` (UI): `SoploModal`, `SOPLO_SETTINGS_PATH`. Consulta consentimiento antes de
  mandar; pinta `plan.preview`; Enter aplica salvo dentro de un input.

### `src/brl/`
- `brl-ops.ts` (puro): `brlCreateOp`, `brlEntryText` (marcador `-` nota / `=` pensamiento),
  `parseBrlQuery`, `parseBrlDate` (`today`, `hoy`, `YYYY-MM-DD`), `BRL_TODAY`,
  `MAX_BRL_ENTRY_LENGTH` 2000. `brlEntryPresent` está exportado pero solo lo usa su test.
- `brl-modal.ts` (UI): `BrlEntryModal`, Ctrl/Cmd+Enter envía como nota.

### `src/notes/`
- `note-snapshot.ts` (puro): `composeSnapshot`, `snapshotHeader`, `countSnapshots`,
  `MAX_NOTES_LEN` 10 000 (tope medido en Lumbre, que recorta en silencio), `TRUNCATION_MARK`.
  Siempre AÑADE debajo de lo existente porque `update` reemplaza `notes` entero.
- `save-note-modal.ts` (UI): confirmación con tarea, ámbito, caracteres, fotos anteriores y
  oferta de recorte.
- `note-task-suggest-modal.ts` (UI): elegir tarea cuando la nota tiene varias vinculadas.

### `src/review/weekly-snapshot.ts` (puro)
`collectWeeklySnapshot(deps, options)` es la entrada viva (`buildWeeklySnapshot` solo lo usa su
test). Un pool `scope: all, limit: 500` compartido; «Vencidas y arrastradas» (`ROLLOVER_THRESHOLD`
3), «Listas sin próxima acción» agrupando por id de lista en memoria con repliegue a una petición
por lista a 600 ms (`LIST_REQUEST_INTERVAL_MS`), «Muestra de Algún día» (5, hash FNV-1a con
semilla = día local). Líneas con `- `, nunca `- [ ]`.

### `src/attachments/`
- `upload.ts` (puro): `checkUploadSize`, `mimeForExtension`, `formatBytes`, `DEFAULT_MIME`.
  `uploadRequest` está exportado pero la petición real la monta `client.uploadAttachment`
  (código duplicado; su test no protege el camino vivo).
- `file-suggest-modal.ts` (UI): ficheros no `.md`, por `mtime` descendente, marca los que no caben.

### `src/api/lumbre-api.ts` (puro)
`LumbreApi`, `TASKS_CHANGED_EVENT`. Ver [entry-points.md](./entry-points.md).

### `src/export/export-path.ts` (puro)
`exportFileName` (fecha LOCAL, sin `:`), `exportFilePath`.

### `src/diagnostics/`
| Fichero | Exports clave | Notas |
|---|---|---|
| `logger.ts` | `Logger` (`create`, `child`, `event`, `recent`, `onEvent`, `setLevel`, `enabled`), `LogModule` (11 módulos), `formatEvent`, `shortTitle` (80), `LOG_BUFFER_SIZE` 1000 | consola filtrada por nivel; buffer siempre lleno; nunca lanza (cuenta `dropped`) |
| `redact.ts` | `redact`, `stripSecrets`, `REDACTED`, `MIN_SECRET_LENGTH` 6 | claves prohibidas por sufijo; cadenas a 200; profundidad 6; arrays a 50 |
| `errors.ts` | `describeError` | stack solo si se pide (debug) |
| `unhandled.ts` | `guarded` (no relanza), `unhandledEvent`, `PLUGIN_STACK_MARK` | filtra por `plugin:lumbre` |
| `report.ts` | `buildReport`, `DEFAULT_REPORT_EVENTS` 300, `CacheStats` | vuelve a pasar por `stripSecrets` al final |
| `log-files.ts` | `LiveLog`, `saveReport`, `logsFolder`, `MAX_REPORT_FILES` 10, `LIVE_LOG_MAX_BYTES` 1 MiB | escrituras encadenadas en serie |
| `diagnostics-modal.ts` (UI) | `DiagnosticsModal` | 100 eventos en un solo `setText` |

### `src/storage/plugin-store.ts` (puro)
`PluginStore`, `PLUGIN_DATA_VERSION` 5, `DeviceIdStore`. Ver [storage.md](./storage.md).

### `src/settings.ts` (UI) y `src/token-store.ts`
`LumbreSettings`, `DEFAULT_SETTINGS`, `LumbreSettingTab`, `LumbreSettingsHost` (campo `config`),
`normalizeOrigin`, `normalizeExportFolder`. `TokenStore` / `PluginDataTokenStore`.

### `src/test/`
`obsidian-mock.ts` (alias de `obsidian` en Vitest) y `fake-dom.ts` (DOM mínimo sin jsdom). Ver
[patterns.md](./patterns.md).
