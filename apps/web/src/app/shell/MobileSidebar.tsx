import { X } from 'lucide-react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { IconButton } from '@/design-system';
import { SidebarNav } from './Sidebar';
import { useShellState } from './shellState';

/** Slide-over navigation below the `lg` breakpoint, opened from the topbar menu button. */
export function MobileSidebar() {
  const { mobileNavOpen, setMobileNavOpen } = useShellState();
  return (
    <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-nw-backdrop data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          // A side panel: the same sidebar surface, with the menu shadow (SPEC §6 shadows).
          className="fixed inset-y-0 left-0 z-50 w-(--sidebar-width) max-w-[85vw] bg-nw-sidebar shadow-menu outline-none data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out lg:hidden"
        >
          <VisuallyHidden.Root asChild>
            <Dialog.Title>Navigation</Dialog.Title>
          </VisuallyHidden.Root>
          <SidebarNav
            collapsed={false}
            onNavigate={() => setMobileNavOpen(false)}
            className="h-full w-full"
          />
          <Dialog.Close asChild>
            <IconButton label="Close navigation" size="sm" className="absolute top-3 right-2">
              <X />
            </IconButton>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
