import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ActorId, WorkspaceRecord } from '$lib/data/types';
import BookmarkBlock from './BookmarkBlock.svelte';

const actor: ActorId = { kind: 'human', userId: 'local' };

function makeBlock(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
	return {
		id: 'block-1',
		parentId: 'doc-1',
		order: 'a0',
		blockType: 'bookmark',
		createdBy: actor,
		createdAt: 0,
		lastEditedBy: actor,
		lastEditedAt: 0,
		...overrides
	};
}

describe('BookmarkBlock (issue #155)', () => {
	it('shows a URL input when unconfigured, and submits a normalized url', async () => {
		const user = userEvent.setup();
		const onSubmitUrl = vi.fn();
		render(BookmarkBlock, { block: makeBlock(), onSubmitUrl, onRetry: vi.fn() });

		await user.type(screen.getByLabelText('Bookmark URL'), 'example.com/page');
		await user.click(screen.getByRole('button', { name: 'Add bookmark' }));

		expect(onSubmitUrl).toHaveBeenCalledWith('https://example.com/page');
	});

	it('rejects an invalid url without calling onSubmitUrl', async () => {
		const user = userEvent.setup();
		const onSubmitUrl = vi.fn();
		render(BookmarkBlock, { block: makeBlock(), onSubmitUrl, onRetry: vi.fn() });

		await user.type(screen.getByLabelText('Bookmark URL'), 'not a url at all');
		await user.click(screen.getByRole('button', { name: 'Add bookmark' }));

		expect(onSubmitUrl).not.toHaveBeenCalled();
		expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid web address.');
	});

	it('always renders a real accessible link to the plain url, even while pending', () => {
		render(BookmarkBlock, {
			block: makeBlock({ url: 'https://example.com/', bookmarkMetadata: { status: 'pending' } }),
			onSubmitUrl: vi.fn(),
			onRetry: vi.fn()
		});

		const link = screen.getByRole('link');
		expect(link).toHaveAttribute('href', 'https://example.com/');
		expect(screen.getByText('Fetching preview…')).toBeInTheDocument();
	});

	it('renders the fetched title/description once ready', () => {
		render(BookmarkBlock, {
			block: makeBlock({
				url: 'https://example.com/article',
				bookmarkMetadata: {
					status: 'ready',
					title: 'Example Article',
					description: 'A short summary.'
				}
			}),
			onSubmitUrl: vi.fn(),
			onRetry: vi.fn()
		});

		expect(screen.getByText('Example Article')).toBeInTheDocument();
		expect(screen.getByText('A short summary.')).toBeInTheDocument();
		expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/article');
	});

	it('shows a Retry control and the plain url on an error status, and calls onRetry when clicked', async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(BookmarkBlock, {
			block: makeBlock({ url: 'https://example.com/', bookmarkMetadata: { status: 'error' } }),
			onSubmitUrl: vi.fn(),
			onRetry
		});

		expect(screen.getByText("Couldn't load a preview.")).toBeInTheDocument();
		expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/');

		await user.click(screen.getByRole('button', { name: 'Retry preview' }));
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it('falls back to the plain url as the visible label when no title was scraped', () => {
		render(BookmarkBlock, {
			block: makeBlock({
				url: 'https://example.com/no-title',
				bookmarkMetadata: { status: 'ready' }
			}),
			onSubmitUrl: vi.fn(),
			onRetry: vi.fn()
		});

		expect(screen.getByText('https://example.com/no-title')).toBeInTheDocument();
	});
});
