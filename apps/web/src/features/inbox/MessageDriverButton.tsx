import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Button, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { openLoadConversation } from './api';

/**
 * "Message driver" on the load page (mobile M4): opens (or starts) the load's Dispatch conversation
 * with its driver in the Inbox. Shown to dispatch.view holders, on a load that has a driver.
 */
export function MessageDriverButton({ loadId, driverId }: { loadId: string; driverId: string | null | undefined }) {
  const account = useAccount();
  const navigate = useNavigate();
  const { toast } = useToast();
  const open = useMutation({
    mutationFn: () => openLoadConversation(loadId),
    onSuccess: (thread) => void navigate({ to: '/inbox', search: { c: thread.conversation.id } } as never),
    onError: (error) => toast({ tone: 'danger', title: 'Could not open the conversation', description: error instanceof Error ? error.message : String(error) }),
  });
  if (!driverId || !account?.permissions.includes('dispatch.view') || !account.permissions.includes('loads.view')) return null;
  return (
    <Button variant="secondary" icon={<MessagesSquare />} loading={open.isPending} onClick={() => open.mutate()}>
      Message driver
    </Button>
  );
}
