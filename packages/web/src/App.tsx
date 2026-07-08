import { useEffect } from 'react';
import { navigate, useRoute, type Page } from './lib/router.js';
import { startWs, useWsStatus } from './lib/ws.js';
import { initStores, useOpenTaskCount, useStoreRefetchOnReconnect, useUnseenNotificationCount } from './lib/stores.js';
import { ChatPage } from './pages/ChatPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { PeoplePage } from './pages/PeoplePage.js';
import { InspectorPage } from './pages/InspectorPage.js';
import { CostsPage } from './pages/CostsPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import './styles/shell.css';

startWs();
initStores();

const NAV: { page: Page; label: string; glyph: string; key: string }[] = [
  { page: 'chat', label: 'Chat', glyph: '◍', key: '1' },
  { page: 'tasks', label: 'Tasks', glyph: '▤', key: '2' },
  { page: 'people', label: 'People', glyph: '◭', key: '3' },
  { page: 'inspector', label: 'Inspector', glyph: '◉', key: '4' },
  { page: 'costs', label: 'Costs', glyph: '◗', key: '5' },
  { page: 'config', label: 'Config', glyph: '⌘', key: '6' },
];

const PAGE_TITLES: Record<Page, string> = {
  chat: 'Chat',
  tasks: 'Tasks',
  people: 'People',
  inspector: 'Inspector',
  costs: 'Costs',
  config: 'Config',
};

export function App() {
  const route = useRoute();
  const wsStatus = useWsStatus();
  const openCount = useOpenTaskCount();
  const unseen = useUnseenNotificationCount();
  useStoreRefetchOnReconnect();

  // Ctrl/Cmd+1..5 page switching.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const hit = NAV.find((n) => n.key === e.key);
      if (hit) {
        e.preventDefault();
        navigate(hit.page);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = `botty · ${PAGE_TITLES[route].toLowerCase()}`;
  }, [route]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">bo<span className="brand-tty">tty</span></span>
        </div>
        <nav className="side-nav">
          {NAV.map(({ page, label, glyph, key }) => (
            <button
              key={page}
              className={`nav-item ${route === page ? 'active' : ''}`}
              onClick={() => navigate(page)}
              title={`${label} (⌘${key})`}
            >
              <span className="nav-glyph">{glyph}</span>
              <span className="nav-label">{label}</span>
              {page === 'tasks' && openCount !== null && openCount > 0 && (
                <span className="nav-badge">{openCount}</span>
              )}
              {page === 'chat' && unseen > 0 && <span className="nav-badge nav-badge-hot">{unseen}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`ws-dot ws-${wsStatus}`} />
          <span className="ws-label">
            {wsStatus === 'open' ? 'connected' : wsStatus === 'connecting' ? 'connecting…' : 'offline'}
          </span>
        </div>
      </aside>
      <main className="page-main">
        <header className="page-head">
          <h1>{PAGE_TITLES[route]}</h1>
        </header>
        <div className="page-body">
          {route === 'chat' && <ChatPage />}
          {route === 'tasks' && <TasksPage />}
          {route === 'people' && <PeoplePage />}
          {route === 'inspector' && <InspectorPage />}
          {route === 'costs' && <CostsPage />}
          {route === 'config' && <ConfigPage />}
        </div>
      </main>
    </div>
  );
}
