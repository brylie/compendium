import { describe, expect, it } from 'vitest';
import {
	mcpAdapterBindings,
	serviceModules,
	serviceSurfaces,
	uiAdapterBindings,
	type ServiceMethod
} from './manifest';

describe('service surface manifest', () => {
	const alphabetically = <T extends string>(values: T[]) =>
		values.toSorted((a, b) => a.localeCompare(b));

	it('declares every callable service method exactly once', () => {
		const callableMethods = Object.entries(serviceModules).flatMap(([moduleName, module]) =>
			Object.entries(module)
				.filter(
					([, value]) =>
						typeof value === 'function' &&
						!Function.prototype.toString.call(value).startsWith('class ')
				)
				.map(([methodName]) => `${moduleName}.${methodName}`)
		);
		expect(alphabetically(Object.keys(serviceSurfaces))).toEqual(alphabetically(callableMethods));
	});

	it('requires one and only one adapter binding for each declared surface', () => {
		const methods = Object.keys(serviceSurfaces) as ServiceMethod[];
		const expectedMcp = alphabetically(methods.filter((method) => serviceSurfaces[method].mcp));
		const expectedUi = alphabetically(methods.filter((method) => serviceSurfaces[method].ui));

		expect(alphabetically(Object.keys(mcpAdapterBindings))).toEqual(expectedMcp);
		expect(alphabetically(Object.keys(uiAdapterBindings))).toEqual(expectedUi);
		for (const method of expectedMcp) {
			expect(mcpAdapterBindings[method as keyof typeof mcpAdapterBindings]).toBe(
				serviceSurfaces[method].mcpToolName
			);
		}
	});
});
