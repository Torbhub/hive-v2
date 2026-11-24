export const PROJECT_TABS = ['tasks', 'activity', 'team', 'settings'] as const;
export const NEED_FILTERS = ['all', 'fresh', 'plans', 'questions', 'blocked', 'stale'] as const;

export type ProjectTab = typeof PROJECT_TABS[number];
export type NeedFilter = typeof NEED_FILTERS[number];
export type Route =
  | { name: 'home'; filter: NeedFilter; project?: string }
  | { name: 'project'; project: string; tab: ProjectTab }
  | { name: 'task'; project: string; task: string }
  | { name: 'questions'; batch?: string }
  | { name: 'logs'; project: string; agent?: string }
  | { name: 'branches'; project: string; branch?: string };

function basePath(): string {
  return window.location.pathname === '/hive' || window.location.pathname.startsWith('/hive/') ? '/hive' : '';
}

function isProjectTab(value: string): value is ProjectTab {
  return (PROJECT_TABS as readonly string[]).includes(value);
}

function isNeedFilter(value: string): value is NeedFilter {
  return (NEED_FILTERS as readonly string[]).includes(value);
}

export function readRoute(): Route {
  const base = basePath();
  const path = window.location.pathname.slice(base.length).replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const query = new URLSearchParams(window.location.search);
  if (parts[0] === 'projects' && parts[1]) {
    const project = parts[1];
    if (parts[2] === 'tasks' && parts[3]) return { name: 'task', project, task: parts[3] };
    if (parts[2] === 'logs') return { name: 'logs', project, agent: query.get('agent') ?? undefined };
    if (parts[2] === 'branches') return { name: 'branches', project, branch: parts[3] };
    const tab = query.get('tab') ?? 'tasks';
    return { name: 'project', project, tab: isProjectTab(tab) ? tab : 'tasks' };
  }
  if (parts[0] === 'questions') return { name: 'questions', batch: parts[1] };
  const filter = query.get('filter') ?? 'all';
  return { name: 'home', filter: isNeedFilter(filter) ? filter : 'all', project: query.get('project') ?? undefined };
}

export function routeUrl(route: Route): string {
  const base = basePath();
  if (route.name === 'home') {
    const query = new URLSearchParams();
    if (route.filter !== 'all') query.set('filter', route.filter);
    if (route.project) query.set('project', route.project);
    const suffix = query.size ? `?${query}` : '';
    return `${base}/${suffix}`;
  }
  if (route.name === 'questions') return `${base}/questions${route.batch ? `/${encodeURIComponent(route.batch)}` : ''}`;
  const project = encodeURIComponent(route.project);
  if (route.name === 'task') return `${base}/projects/${project}/tasks/${encodeURIComponent(route.task)}`;
  if (route.name === 'logs') {
    const query = route.agent ? `?agent=${encodeURIComponent(route.agent)}` : '';
    return `${base}/projects/${project}/logs${query}`;
  }
  if (route.name === 'branches') {
    return `${base}/projects/${project}/branches${route.branch ? `/${encodeURIComponent(route.branch)}` : ''}`;
  }
  return `${base}/projects/${project}?tab=${route.tab}`;
}
