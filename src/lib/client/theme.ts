export type Theme = 'light' | 'dark' | 'system';

/** The user's persisted theme preference, or 'system' during SSR or when nothing has been saved yet. */
export function getTheme(): Theme {
	if (typeof window === 'undefined') return 'system';
	return (localStorage.getItem('theme') as Theme) || 'system';
}

/** Whether dark mode is currently active, per the `dark` class on the document root. */
export function isDark(): boolean {
	if (typeof window === 'undefined') return false;
	return document.documentElement.classList.contains('dark');
}

/** Flips between light and dark, updating the root class and persisting the choice to localStorage; returns the new isDark state. */
export function toggleTheme(): boolean {
	if (typeof window === 'undefined') return false;
	const currentlyDark = isDark();
	const nextTheme = currentlyDark ? 'light' : 'dark';
	if (nextTheme === 'dark') {
		document.documentElement.classList.add('dark');
		localStorage.setItem('theme', 'dark');
		return true;
	} else {
		document.documentElement.classList.remove('dark');
		localStorage.setItem('theme', 'light');
		return false;
	}
}
