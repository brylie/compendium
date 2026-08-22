export type Theme = 'light' | 'dark' | 'system';

export function getTheme(): Theme {
	if (typeof window === 'undefined') return 'system';
	return (localStorage.getItem('theme') as Theme) || 'system';
}

export function isDark(): boolean {
	if (typeof window === 'undefined') return false;
	return document.documentElement.classList.contains('dark');
}

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
