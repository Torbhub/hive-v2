export function apiPath(pathname: string): string {
  const base = window.location.pathname === '/hive' || window.location.pathname.startsWith('/hive/') ? '/hive' : '';
  return `${base}/${pathname.replace(/^\/+/, '')}`;
}
