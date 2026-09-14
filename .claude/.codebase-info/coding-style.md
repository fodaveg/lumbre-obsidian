# Estilo de código

*Última actualización: 2026-09-14*

## Herramientas

| Herramienta | Config | Se aplica en |
|---|---|---|
| ESLint 9 (flat) | `eslint.config.mjs` | `npm run lint`, parte del gate |
| typescript-eslint con `projectService` | ídem | `.mjs` de `scripts/` via `allowDefaultProject` |
| `eslint-plugin-obsidianmd` recommended | ídem | también lintea `manifest.json` |
| TypeScript 5.8 | `tsconfig.json` | `tsc --noEmit` dentro de `npm run build` |
| EditorConfig | `.editorconfig` | tabs de 4 (código), 2 espacios (json/yml/md), LF, newline final |

Desactivaciones de lint, cada una con su motivo escrito en el propio fichero:
- `scripts/**/*.mjs`, `*.config.mts`: `rule-custom-message`, `hardcoded-config-path`,
  `no-nodejs-modules` (corren en Node, no entran en el bundle).
- `src/**/*.test.ts`: `no-nodejs-modules`; junto con `src/test/**`: `prefer-window-timers`,
  `no-global-this` (bajo Vitest no hay `window`).
- `src/**/*.ts`: `ui/sentence-case` (minusculiza «Lumbre») y
  `settings-tab/prefer-setting-definitions` (API de 1.13, el manifest declara 1.11.4).

tsconfig: `strict`, `noUncheckedIndexedAccess` (de ahí el estilo `row['campo']` con comprobación
de tipo en `types.ts`, `errors.ts`, `plugin-store.ts`), `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `isolatedModules`, `moduleResolution: bundler`.

## Convenciones

| Elemento | Convención | Ejemplo |
|---|---|---|
| Ficheros | kebab-case, `.test.ts` al lado | `note-list-link-store.ts` |
| Clases y tipos | PascalCase, en inglés | `OperationQueue`, `LumbreTaskLink` |
| Funciones y variables | camelCase, en inglés | `enqueueCreate`, `notePath` |
| Constantes de módulo | UPPER_SNAKE, exportadas y reutilizadas en tests | `MAX_ATTEMPTS`, `ORPHAN_GRACE_MS` |
| Comentarios, JSDoc, UI, Notices, docs | castellano | «Lumbre aceptó el envío» |
| Guiones largos | NUNCA como inciso; coma, punto o paréntesis | regla de `CLAUDE.md` |
| Comandos | id kebab en inglés, nombre en castellano sin prefijo «Lumbre:» | `send-task` / «Enviar como tarea» |
| Clases CSS | prefijo `lumbre-` | `lumbre-button` |
| Eventos de workspace | prefijo `lumbre:` | `lumbre:tasks-changed` |
| Claves de localStorage | prefijo `lumbre:` | `lumbre:device-id` |
| Módulos de log | unión cerrada `LogModule` | `http`, `queue`, `links`, `cache`, `block`, `panel`, `modal`, `api`, `settings`, `vault`, `main` |
| Mayúsculas en comentarios | para el contraste que se defiende | «se RELEE», «NUNCA casillas» |

## Lo que el linter no impone

- Los comentarios explican el POR QUÉ, con la medición o el incidente detrás; el qué ya lo dice el
  código. Muchos citan fichero y línea del repo de Lumbre con SHA.
- Cada constante numérica lleva en su JSDoc de dónde sale (un cupo del servidor, un tope medido).
- `void promesa` para disparar sin esperar, con un `guarded` o un `catch` dentro.
- No se escribe en una nota salvo `lumbre-list` y los comandos de foto fija.
- Título de tarea en el registro: solo `debug` y `shortTitle`.
- Sin `addEventListener` directo; sin `setTimeout` sin `window.`; sin `Co-Authored-By` en commits
  (preferencia de David registrada en memoria).
