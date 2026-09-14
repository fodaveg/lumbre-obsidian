# Tecnología

*Última actualización: 2026-09-14*

## Ficheros fuente de verdad

| Información | Fichero |
|---|---|
| Dependencias y scripts | `package.json` (todo `devDependencies`; runtime = API de Obsidian) |
| Manifest del plugin | `manifest.json` (id `lumbre`, `minAppVersion` 1.11.4, `isDesktopOnly: false`) |
| Versiones publicadas | `versions.json` (0.1.0 a 0.1.12, todas → 1.11.4) |
| Build | `esbuild.config.mjs` (CJS, ES2021, `obsidian`/`electron`/CodeMirror/Lezer/builtins externos; prod minificado sin sourcemap) |
| TypeScript | `tsconfig.json` (`strict` + `noUncheckedIndexedAccess`, `noUnusedLocals`, `noImplicitReturns`, `noFallthroughCasesInSwitch`; `types: node, vitest/globals`) |
| Lint | `eslint.config.mjs` (`eslint-plugin-obsidianmd` recommended + typescript-eslint) |
| Tests | `vitest.config.mts` (alias `obsidian` → `src/test/obsidian-mock.ts`; excluye `.claude/**`) |
| Formato | `.editorconfig` (tabs de 4; 2 espacios en json/yml/md; LF) |
| npm | `.npmrc` (`tag-version-prefix=""`, `engine-strict=true`) |
| Node | `engines`: `^22.20.0 || >=24.12.0`; CI fija 22.20.0 |
| Release | `.github/workflows/release.yml`, `scripts/verify-release.mjs`, `version-bump.mjs` |
| Estado y decisiones | `docs/ESTADO.md` (por lotes A…O), `docs/API.md` (contrato público) |

## Stack

| Capa | Tecnología | Notas |
|---|---|---|
| Lenguaje | TypeScript 5.8 | identificadores en inglés, todo lo demás en castellano |
| Runtime | Obsidian (Electron en escritorio, WebView en móvil) | sin módulos de Node en `src/` (lint `no-nodejs-modules`) |
| Bundler | esbuild 0.25 | `npm run dev` = watch con sourcemap inline |
| Tests | Vitest 3 | sin jsdom; DOM falso propio en `src/test/fake-dom.ts` |
| Lint | ESLint 9 flat config | reglas de Obsidian con cuatro desactivaciones justificadas en el propio fichero |
| Estilos | `styles.css` en raíz | asset de la release |

## Gate y CI

`npm run check` = `lint && test && verify:release && build` (`build` = `tsc --noEmit` + esbuild
prod). `.github/workflows/ci.yml` lo corre en cada push y PR con `contents: read`.

## Release (BRAT)

1. `npm version patch|minor` → `version-bump.mjs` sincroniza `manifest.json` y `versions.json`;
   tag SIN prefijo `v` (`.npmrc`).
2. `git push --follow-tags` → `release.yml` (solo el job `publish` eleva a `contents: write`):
   `npm run check` de nuevo, `verify-release.mjs --tag`, `gh release create` con `main.js`,
   `manifest.json`, `styles.css` sueltos, y `verify-release.mjs --published` contra lo que GitHub
   devuelve (assets con `size > 0`, no draft).
3. BRAT descarga los tres assets por nombre desde `fodaveg/lumbre-obsidian`.

Instalación local: `OBSIDIAN_VAULT=/ruta npm run install:dev` copia los tres ficheros a
`.obsidian/plugins/lumbre/`.

## Infraestructura
No hay servidor propio, base de datos ni contenedores. El estado vive en `data.json` del vault y
en Lumbre.
