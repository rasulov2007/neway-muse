import type { AiConversationView } from '@neway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Switch, Tooltip, useToast } from '@/design-system';
import { updateConversation, useAiKeys, useAiUsage } from './api';

/**
 * Dry run, per chat. On by default: the assistant prepares actions but nothing is sent. Only
 * ai_assistant.manage may turn it off (owner, 2026-10-20); everyone else sees it locked on.
 */
export function DryRunSwitch({ conversation }: { conversation: AiConversationView | null }) {
  const usage = useAiUsage();
  const keys = useAiKeys();
  const client = useQueryClient();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const on = conversation?.dryRun ?? true;
  const canChange = Boolean(conversation && usage.data?.canLeaveDryRun);

  const control = (
    <span className="inline-flex items-center gap-2">
      <Switch
        checked={on}
        disabled={!canChange || saving}
        aria-label="Dry run"
        onCheckedChange={async (next) => {
          if (!conversation) return;
          setSaving(true);
          try {
            await updateConversation(conversation.id, { dryRun: next });
            await client.invalidateQueries({ queryKey: keys.conversations });
          } catch (e) {
            toast({ tone: 'danger', title: 'Dry run was not changed', description: e instanceof Error ? e.message : undefined });
          } finally {
            setSaving(false);
          }
        }}
      />
      <Badge tone={on ? 'warning' : 'success'} size="sm" dot>
        {on ? 'Dry run' : 'Live'}
      </Badge>
    </span>
  );
  if (canChange) return control;
  return <Tooltip content="Dry run: actions are prepared, never sent. Only an administrator can turn it off.">{control}</Tooltip>;
}
