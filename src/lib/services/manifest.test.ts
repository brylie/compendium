import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '$lib/mcp/server';
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

	it('registers every declared MCP adapter at runtime', () => {
		const serverWithTools = createMcpServer() as unknown as {
			_registeredTools: Record<string, unknown>;
		};

		expect(alphabetically(Object.keys(serverWithTools._registeredTools))).toEqual(
			alphabetically(Object.values(mcpAdapterBindings))
		);
	});

	it('binds every declared UI adapter to an existing route module', () => {
		for (const [method, routeModule] of Object.entries(uiAdapterBindings)) {
			expect(existsSync(resolve(process.cwd(), routeModule)), method).toBe(true);
		}
	});

	it('binds every declared UI adapter to a route module that actually calls it', () => {
		// existsSync alone only proves the bound file is present, not that it
		// calls the bound service method — a route can be rewritten to bypass
		// its bound method entirely while uiAdapterBindings keeps silently
		// claiming it's wired (#190's motivating example, left open by #191).
		// A source-text scan for a call expression using the method's short
		// name catches that drift; it does not (and is not meant to) verify
		// the call resolves to this exact module rather than a same-named
		// function elsewhere — see service-layer-manifest.md §3 for the
		// heavier, harness-driven check that would.
		for (const [method, routeModule] of Object.entries(uiAdapterBindings)) {
			const methodName = method.split('.')[1];
			const source = readFileSync(resolve(process.cwd(), routeModule), 'utf-8');
			const callsMethod = new RegExp(`\\b${methodName}\\s*\\(`).test(source);
			expect(callsMethod, `${routeModule} does not call ${methodName}`).toBe(true);
		}
	});
});
