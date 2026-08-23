import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import Icon from './Icon.svelte';

describe('Icon', () => {
	it('renders an svg sized to the default 18px', () => {
		const { container } = render(Icon, { name: 'document' });
		const svg = container.querySelector('svg');
		expect(svg).toHaveAttribute('width', '18');
		expect(svg).toHaveAttribute('height', '18');
	});

	it('renders at a custom size', () => {
		const { container } = render(Icon, { name: 'trash', size: 24 });
		const svg = container.querySelector('svg');
		expect(svg).toHaveAttribute('width', '24');
		expect(svg).toHaveAttribute('height', '24');
	});

	it('applies the class prop to the svg element', () => {
		const { container } = render(Icon, { name: 'plus', class: 'text-accent' });
		expect(container.querySelector('svg')).toHaveClass('text-accent');
	});

	it('is hidden from assistive tech since it is always paired with visible text or a title/aria-label', () => {
		const { container } = render(Icon, { name: 'sync' });
		expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
	});

	it('renders distinct markup for each icon name', () => {
		const { container: doc } = render(Icon, { name: 'document' });
		const { container: trash } = render(Icon, { name: 'trash' });
		expect(doc.querySelector('svg')?.innerHTML).not.toBe(trash.querySelector('svg')?.innerHTML);
	});

	it('renders checkbox-checked with a filled rect and inner check path', () => {
		const { container } = render(Icon, { name: 'checkbox-checked' });
		const svg = container.querySelector('svg')!;
		expect(svg.querySelector('rect')).toHaveAttribute('fill', 'currentColor');
		expect(svg.querySelectorAll('path')).toHaveLength(1);
	});

	it('renders nothing inside the svg for an unrecognized name', () => {
		// @ts-expect-error deliberately invalid to exercise the fall-through {#if} chain
		const { container } = render(Icon, { name: 'not-a-real-icon' });
		expect(container.querySelector('svg')?.querySelector('path, circle, rect')).toBeNull();
	});
});
