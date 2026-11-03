import type { CSSProperties, ReactNode } from 'react';
import { ToastProvider, TooltipProvider } from '@/design-system';
import { AiLauncher } from '@/features/ai-assistant/AiLauncher';
import { GuideOverlay } from '@/features/ai-assistant/GuideOverlay';
import { DriveCursor } from '@/features/ai-assistant/drive/DriveCursor';
import { DriveDock } from '@/features/ai-assistant/drive/DriveDock';
import { CommandPalette } from './CommandPalette';
import { MobileSidebar } from './MobileSidebar';
import { NotificationCenter } from './NotificationCenter';
import { ShellStateProvider } from './ShellStateProvider';
import { Sidebar } from './Sidebar';
import { useShellState } from './shellState';
import { Topbar } from './Topbar';

function ShellFrame({ children }: { children: ReactNode }) {
  const { collapsed } = useShellState();
  const style = {
    '--shell-sidebar-width': collapsed ? 'var(--sidebar-width-collapsed)' : 'var(--sidebar-width)',
  } as CSSProperties;

  return (
    // Canvas: `--nw-bg`; pages get `--page-padding` (20px 24px 24px, SPEC §6).
    <div className="min-h-screen bg-nw-bg" style={style}>
      <Sidebar />
      <MobileSidebar />
      <div data-shell-content className="flex min-h-screen flex-col transition-[padding] duration-200 ease-in-out lg:pl-(--shell-sidebar-width)">
        <Topbar />
        <main className="min-w-0 flex-1 overflow-x-clip">
          <div className="w-full p-(--page-padding)">
            {children}
          </div>
        </main>
      </div>
      <CommandPalette />
      <NotificationCenter />
      <AiLauncher />
      <GuideOverlay />
      <DriveDock />
      <DriveCursor />
    </div>
  );
}

/** Application frame: sidebar, topbar, content area and the shell-wide overlays. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>
        <ShellStateProvider>
          <ShellFrame>{children}</ShellFrame>
        </ShellStateProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
