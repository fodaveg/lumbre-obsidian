import { describe, expect, it } from 'vitest';

import { filterTasks, normalizeForSearch } from './search-filter';

const tasks = [
	{ content: 'Comprar camión de juguete', list: { name: 'Casa' } },
	{ content: 'Llamar al fontanero', list: { name: 'Casa' } },
	{ content: 'Preparar la charla', list: { name: 'Trabajo' } },
	{ content: 'Revisar el presupuesto', list: null },
];

describe('normalizeForSearch', () => {
	it('quita tildes y baja a minúsculas; la eñe también se pliega', () => {
		expect(normalizeForSearch('  Camión Ñoño ')).toBe('camion nono');
	});
});

describe('filterTasks', () => {
	it('sin texto devuelve todo', () => {
		expect(filterTasks(tasks, '   ')).toHaveLength(4);
	});

	it('filtra por título ignorando tildes y mayúsculas', () => {
		const found = filterTasks(tasks, 'CAMION');
		expect(found.map((task) => task.content)).toEqual(['Comprar camión de juguete']);
	});

	it('si el texto es el nombre de una lista, devuelve esa lista entera', () => {
		const found = filterTasks(tasks, 'casa');
		expect(found).toHaveLength(2);
	});

	it('la lista gana solo con el nombre exacto; si no, sigue el título', () => {
		expect(filterTasks(tasks, 'cas')).toHaveLength(0);
		expect(filterTasks(tasks, 'presupuesto')).toHaveLength(1);
	});

	it('no devuelve el array original, para que el llamador no lo mute', () => {
		expect(filterTasks(tasks, '')).not.toBe(tasks);
	});
});
