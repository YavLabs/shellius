import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Footer from './Footer';
import useKeyboardShortcuts from '@/hooks/useKeyboardShortcuts';
import useDocumentTitle from '@/hooks/useDocumentTitle';

function AppLayout() {
  // Mount global keyboard shortcuts for authenticated pages
  useKeyboardShortcuts();
  useDocumentTitle();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-muted/30">
          <Outlet />
          <Footer />
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
