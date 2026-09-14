# Arranque

*Última actualización: 2026-09-14*

## Requisitos
- Node `^22.20.0 || >=24.12.0` (`engine-strict` activado).
- Un vault de Obsidian ≥ 1.11.4 para probar; para BRAT, la release en GitHub.
- Un token personal de Lumbre (se pega en Ajustes; nunca en el repo).

## Puesta en marcha
```sh
npm install
npm run dev                                  # esbuild watch, sourcemap inline
OBSIDIAN_VAULT=/ruta/al/vault npm run install:dev   # copia main.js, manifest.json, styles.css
npm run check                                # gate: lint + tests + verify-release + build
```

## Comandos

| Comando | Para qué |
|---|---|
| `npm run check` | el gate; si está en rojo no se cierra nada |
| `npm test` | `vitest run` |
| `npm run lint` | ESLint |
| `npm run build` | `tsc --noEmit` + esbuild producción |
| `npm run verify:release` | versión coherente en manifest, package y versions |
| `npm version patch` + `git push --follow-tags` | publicar (tag sin `v`; el workflow crea la release) |

## Tareas frecuentes

**Añadir un `kind` a la cola.** `src/lumbre/queue.ts`: tipo `XQueuedOperation`, unión
`QueuedOperation`, `enqueueX`, rama en `send`, rama en `reread` (qué relectura lo confirma), y si
puede recibir un 404 legítimo revisar `PERMANENT_REASONS`. Añadir el método al `Pick<LumbreClient>`
de `OperationQueueOptions` y a `fakeClient()` de `queue.test.ts`. Decidir si `outcomeOf` debe
interpretarlo (hoy solo `status` y `notes`).

**Añadir un endpoint al cliente.** `src/lumbre/client.ts`: método sobre `send`/`request`; si es
lectura, envolver en `gated`; añadir su cupo a `RATE_LIMITS` con la constante medida en el repo de
Lumbre; test con `recordingClient` en `client.test.ts`.

**Añadir una clave al bloque ```lumbre```.** `src/blocks/query-parser.ts` (`applyKey`,
`ParsedQuery`, `ResolvedQuery`, `queryParams`, `queryKey` si cambia lo que se pide o cómo se cachea,
`describeQuery`), README (tabla de claves) y `docs/API.md` + `LumbreQueryInput` si entra en la API.

**Añadir un ajuste.** `src/settings.ts` (`LumbreSettings`, `DEFAULT_SETTINGS`, control en
`display`), `src/storage/plugin-store.ts` (subir `PLUGIN_DATA_VERSION`, corregir en `migrate` solo
si puede venir mal escrito), `docs/ESTADO.md`.

**Añadir un comando.** `registerCommands` en `src/main.ts` con `this.command(id, fn)`; nombre sin
prefijo «Lumbre:»; si necesita editor, `editorCallback`; si depende de la nota, `checkCallback`.

**Algo que escucha el DOM.** Siempre `registerDomEvent` (en modales, por su `Component` propio).
`src/dom-events.test.ts` falla si no.

**Cambiar qué se registra.** Nunca texto del usuario en `info`; títulos con `shortTitle` en `debug`;
comprobar con `redact.test.ts` y `report.test.ts`.

## Dónde mirar cuando algo falla
- Ajustes → Diagnóstico → nivel `debug`, repetir, «Copiar registro» (buffer de 1000 siempre lleno).
- `logs/lumbre-live.log` en `.obsidian/plugins/lumbre/` si el interruptor está encendido.
- Cola parada: panel, «Reintentar» / «Descartar». Un 401 apaga TODAS las lecturas hasta cambiar el
  token o pulsar «Reintentar».

## Trampas medidas
- `data.json` viaja por Sync: no guardes ahí nada por dispositivo ni contenido de tareas.
- Un `:` en un nombre de fichero del vault mete a Obsidian Sync en bucle.
- `Modal` no es `Component`; `Plugin.settings` existe en 1.13 pero no en la mínima 1.11.4.
- `?ids=` de `/api/tasks` no trae subtareas; `?id=` sí.
- `/api/batch` rechaza entero un lote de más de 200 y responde 200 con éxito parcial.
- SvelteKit rechaza con 403 un POST con `Content-Type` de formulario: los adjuntos van siempre
  como `application/octet-stream`.
- `POST /api/mutations` con `op: update` reemplaza `notes` entero y el servidor recorta a 10 000
  en silencio.
- El repo de Lumbre es de OTRA sesión: se lee para medir contratos, no se toca.
- `/.claude/` está ignorado por `.gitignore`; este mapa no se versiona sin una negación explícita.
