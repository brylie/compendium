import { describe, expect, it } from 'vitest';
import {
	mcpAdapterBindings,
	serviceModules,
	serviceSurfaces,
	uiAdapterBindings,
	type ServiceMethod
} from './manifest';

describe('service surface manifest', () => {
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
		expect(Object.keys(serviceSurfaces).sort()).toEqual(callableMethods.sort());
	});

	it('requires one and only one adapter binding for each declared surface', () => {
		const methods = Object.keys(serviceSurfaces) as ServiceMethod[];
		const expectedMcp = methods.filter((method) => serviceSurfaces[method].mcp).sort();
		const expectedUi = methods.filter((method) => serviceSurfaces[method].ui).sort();

		expect(Object.keys(mcpAdapterBindings).sort()).toEqual(expectedMcp);
		expect(Object.keys(uiAdapterBindings).sort()).toEqual(expectedUi);
		for (const method of expectedMcp) {
			expect(mcpAdapterBindings[method as keyof typeof mcpAdapterBindings]).toBe(
				serviceSurfaces[method].mcpToolName
			);
		}
	});
});
