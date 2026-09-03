import { describe, expect, it } from 'vitest';

import {
	isReportFile,
	LiveLog,
	logsFolder,
	MAX_REPORT_FILES,
	pruneReports,
	reportFileName,
	saveReport,
	type LogFileAdapter,
} from './log-files';

// El directorio de configuración lo elige el usuario (`Vault#configDir`), así
// que el de los tests NO se llama como el de fábrica: la ruta se construye.
const CONFIG_DIR = 'config-del-vault';
const FOLDER = `${CONFIG_DIR}/plugins/lumbre/logs`;

/** Adaptador en memoria con la misma forma que `app.vault.adapter`. */
function memoryAdapter(files: Record<string, string> = {}): LogFileAdapter & {
	files: Record<string, string>;
	folders: Set<string>;
} {
	return {
		files: { ...files },
		folders: new Set<string>(),
		async exists(path: string): Promise<boolean> {
			return this.files[path] !== undefined || this.folders.has(path);
		},
		async mkdir(path: string): Promise<void> {
			this.folders.add(path);
		},
		async write(path: string, data: string): Promise<void> {
			this.files[path] = data;
		},
		async append(path: string, data: string): Promise<void> {
			this.files[path] = (this.files[path] ?? '') + data;
		},
		async list(path: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = `${path}/`;
			return {
				files: Object.keys(this.files).filter((name) => name.startsWith(prefix)),
				folders: [],
			};
		},
		async remove(path: string): Promise<void> {
			delete this.files[path];
		},
		async rename(from: string, to: string): Promise<void> {
			this.files[to] = this.files[from] ?? '';
			delete this.files[from];
		},
		async stat(path: string): Promise<{ size: number } | null> {
			const content = this.files[path];
			return content === undefined ? null : { size: content.length };
		},
	};
}

describe('Nombres y rutas', () => {
	it('la carpeta cuelga de la configuración del vault', () => {
		expect(logsFolder(CONFIG_DIR, 'lumbre')).toBe(FOLDER);
	});

	it('el nombre lleva la fecha y la hora SIN dos puntos, que romperían el vault', () => {
		const name = reportFileName(new Date(2026, 8, 3, 11, 32, 45));

		expect(name).toBe('lumbre-2026-09-03-113245.log');
		expect(name).not.toContain(':');
	});

	it('el registro en vivo NO cuenta como informe', () => {
		expect(isReportFile(`${FOLDER}/lumbre-2026-09-03-113245.log`)).toBe(true);
		expect(isReportFile(`${FOLDER}/lumbre-live.log`)).toBe(false);
		expect(isReportFile(`${FOLDER}/lumbre-live.1.log`)).toBe(false);
		expect(isReportFile(`${FOLDER}/otra-cosa.md`)).toBe(false);
	});
});

describe('saveReport', () => {
	it('crea la carpeta si falta y escribe el informe', async () => {
		const adapter = memoryAdapter();

		const path = await saveReport(adapter, FOLDER, 'el informe', new Date(2026, 8, 3, 11, 0, 0));

		expect(adapter.folders.has(FOLDER)).toBe(true);
		expect(adapter.files[path]).toBe('el informe');
	});

	it('conserva como mucho 10 informes y borra los más viejos', async () => {
		const existing: Record<string, string> = {};
		for (let index = 0; index < 12; index += 1) {
			existing[`${FOLDER}/lumbre-2026-09-0${1}-0000${index}.log`] = 'viejo';
		}
		const adapter = memoryAdapter(existing);

		await saveReport(adapter, FOLDER, 'nuevo', new Date(2026, 8, 3, 11, 0, 0));

		const reports = Object.keys(adapter.files).filter((path) => isReportFile(path));
		expect(reports).toHaveLength(MAX_REPORT_FILES);
		// El que sobrevive es el nuevo; los tres más viejos han caído.
		expect(Object.values(adapter.files)).toContain('nuevo');
		expect(adapter.files[`${FOLDER}/lumbre-2026-09-01-000000.log`]).toBeUndefined();
	});

	it('la poda no toca el registro en vivo', async () => {
		const existing: Record<string, string> = { [`${FOLDER}/lumbre-live.log`]: 'en vivo' };
		for (let index = 0; index < 12; index += 1) {
			existing[`${FOLDER}/lumbre-2026-09-01-00000${index}.log`] = 'viejo';
		}
		const adapter = memoryAdapter(existing);

		await pruneReports(adapter, FOLDER, 2);

		expect(adapter.files[`${FOLDER}/lumbre-live.log`]).toBe('en vivo');
	});
});

describe('LiveLog', () => {
	it('añade líneas al fichero', async () => {
		const adapter = memoryAdapter();
		const live = new LiveLog(adapter, FOLDER);

		await live.append('primera');
		await live.append('segunda');

		expect(adapter.files[live.path]).toBe('primera\nsegunda\n');
	});

	it('rota al pasar del tope y conserva UNA vuelta anterior', async () => {
		const adapter = memoryAdapter();
		const live = new LiveLog(adapter, FOLDER, 10);

		await live.append('doce caracteres');
		await live.append('después de rotar');

		expect(adapter.files[`${FOLDER}/lumbre-live.1.log`]).toBe('doce caracteres\n');
		expect(adapter.files[live.path]).toBe('después de rotar\n');
	});

	it('un fallo de escritura se cuenta y no se propaga', async () => {
		const adapter = memoryAdapter();
		adapter.append = async (): Promise<never> => {
			throw new Error('disco lleno');
		};
		const live = new LiveLog(adapter, FOLDER);

		await expect(live.append('lo que sea')).resolves.toBeUndefined();
		expect(live.dropped).toBe(1);
	});

	it('las escrituras van en orden aunque se pidan a la vez', async () => {
		const adapter = memoryAdapter();
		const live = new LiveLog(adapter, FOLDER);

		void live.append('uno');
		void live.append('dos');
		await live.append('tres');

		expect(adapter.files[live.path]).toBe('uno\ndos\ntres\n');
	});
});
