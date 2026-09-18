import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Footer from './Footer';
import CommandPalette from '@/components/command/CommandPalette';
import { CommandPaletteProvider } from '@/context/CommandPaletteContext';
import { QuickConnectProvider } from '@/context/QuickConnectContext';
import useKeyboardShortcuts from '@/hooks/useKeyboardShortcuts';
import useDocumentTitle from '@/hooks/useDocumentTitle';

function AppLayout() {
  // Mount global keyboard shortcuts for authenticated pages
  useKeyboardShortcuts();
  useDocumentTitle();

  return (
    <QuickConnectProvider>
      <CommandPaletteProvider>
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden min-w-0">
            <Topbar />
            <main className="flex-1 overflow-y-auto overflow-x-hidden bg-muted/30">
              <div className="min-h-[calc(100%-3rem)]">
                <Outlet />
              </div>
              <Footer />
            </main>
          </div>
        </div>

        {/* Mounted once so ⌘K / Ctrl+K / "/" work from any authenticated page */}
        <CommandPalette />
      </CommandPaletteProvider>
    </QuickConnectProvider>
  );
}

export default AppLayout;
