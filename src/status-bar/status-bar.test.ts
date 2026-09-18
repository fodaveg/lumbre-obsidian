import { describe, expect, it, vi } from 'vitest';

import { MAX_ATTEMPTS } from '../lumbre/queue';
import { queueStatusCounts, startStatusBar, statusBarText } from './status-bar';

describe('queueStatusCounts', () => {
	it('materializada no cuenta', () => {
		expect(queueStatusCounts([{ state: 'materialized', attempts: 0 }])).toEqual({
			waiting: 0,
			attention: 0,
		});
	});

	it('pending_local, sent y un error recuperable que aún reintenta van a "waiting"', () => {
		expect(
			queueStatusCounts([
				{ state: 'pending_local', attempts: 0 },
				{ state: 'sent', attempts: 0 },
				{ state: 'recoverable_error', attempts: MAX_ATTEMPTS - 1 },
			]),
		).toEqual({ waiting: 3, attention: 0 });
	});

	it('rechazada y agotada van a "attention"', () => {
		expect(
			queueStatusCounts([
				{ state: 'rejected', attempts: 0 },
				{ state: 'recoverable_error', attempts: MAX_ATTEMPTS },
			]),
		).toEqual({ waiting: 0, attention: 2 });
	});
});

describe('statusBarText', () => {
	it('cola vacía, online y token bueno: texto vacío, se oculta', () => {
		expect(statusBarText({ operations: [], online: true, tokenRejected: false })).toEqual({
			text: '',
			tooltip: '',
		});
	});

	it('con pendientes', () => {
		const state = statusBarText({
			operations: [
				{ state: 'pending_local', attempts: 0 },
				{ state: 'sent', attempts: 0 },
			],
			online: true,
			tokenRejected: false,
		});
		expect(state.text).toBe('Lumbre: 2 pendientes');
		expect(state.tooltip.length).toBeGreaterThan(0);
	});

	it('sin conexión, con operaciones esperando', () => {
		const state = statusBarText({
			operations: [{ state: 'pending_local', attempts: 0 }],
			online: false,
			tokenRejected: false,
		});
		expect(state.text).toBe('Lumbre: sin conexión (1)');
	});

	it('sin conexión y sin nada pendiente', () => {
		const state = statusBarText({ operations: [], online: false, tokenRejected: false });
		expect(state.text).toBe('Lumbre: sin conexión');
	});

	it('token rechazado gana sobre cualquier otra cosa', () => {
		const state = statusBarText({
			operations: [{ state: 'rejected', attempts: 0 }],
			online: false,
			tokenRejected: true,
		});
		expect(state.text).toBe('Lumbre: token rechazado');
	});

	it('con errores, online: cuenta aparte de los pendientes normales', () => {
		const state = statusBarText({
			operations: [
				{ state: 'rejected', attempts: 0 },
				{ state: 'pending_local', attempts: 0 },
			],
			online: true,
			tokenRejected: false,
		});
		expect(state.text).toBe('Lumbre: 1 operación con error');
	});
});

describe('startStatusBar', () => {
	it('pinta al arrancar y se suscribe a los dos canales', () => {
		const render = vi.fn();
		const dataListeners: (() => void)[] = [];
		const connectionListeners: (() => void)[] = [];

		startStatusBar({
			queue: { pending: () => [] },
			isOnline: () => true,
			isTokenRejected: () => false,
			render,
			onDataChange: (listener) => dataListeners.push(listener),
			onConnectionChange: (listener) => connectionListeners.push(listener),
		});

		expect(render).toHaveBeenCalledTimes(1);
		expect(render).toHaveBeenCalledWith({ text: '', tooltip: '' });
		expect(dataListeners).toHaveLength(1);
		expect(connectionListeners).toHaveLength(1);

		// Un cambio en la cola dispara un repintado con el estado de ESE momento.
		dataListeners[0]?.();
		expect(render).toHaveBeenCalledTimes(2);

		connectionListeners[0]?.();
		expect(render).toHaveBeenCalledTimes(3);
	});
});
