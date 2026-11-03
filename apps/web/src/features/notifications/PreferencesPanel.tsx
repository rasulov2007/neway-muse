import { AppWindow, Mail, Send } from 'lucide-react';
import { Badge, Card, Switch, cn } from '@/design-system';
import { KINDS } from './event-kind';
import { CATEGORIES, DELIVERY_CHANNELS, type ChannelKey } from './preferences';
import type { PreferencesState } from './usePreferences';

const CHANNEL_ICONS: Record<ChannelKey, typeof Mail> = {
  in_app: AppWindow,
  email: Mail,
  telegram: Send,
};

/**
 * Which categories reach you. These toggles are load-bearing: an off category is filtered out of
 * the list and out of the tab counts, so the panel is a control, not a settings mock-up.
 */
export function PreferencesPanel({ state }: { state: PreferencesState }) {
  const { preferences, setCategory } = state;
  const offCount = CATEGORIES.filter((c) => !preferences.categories[c.key]).length;

  return (
    <Card
      title="Notification preferences"
      description="Choose what you want to be notified about."
      padding="none"
      data-testid="notification-preferences"
      footer={
        offCount > 0 ? (
          <span className="text-xs text-muted">
            {offCount === 1 ? '1 category is' : `${offCount} categories are`} muted and hidden from
            the list.
          </span>
        ) : (
          <span className="text-xs text-muted">All categories are on.</span>
        )
      }
    >
      <ul className="flex flex-col divide-y divide-line-soft">
        {CATEGORIES.map((category) => {
          // The first kind in a category is its most representative event, so it lends the icon.
          const Icon = KINDS[category.kinds[0] ?? 'system'].icon;
          const enabled = preferences.categories[category.key];
          return (
            <li key={category.key} className="flex items-start gap-3 px-(--card-padding) py-3">
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
                  enabled ? 'bg-primary-soft text-primary-text' : 'bg-surface-muted text-muted',
                )}
              >
                <Icon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{category.label}</p>
                <p className="mt-0.5 text-xs text-muted">{category.description}</p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(next) => setCategory(category.key, next)}
                aria-label={category.label}
                className="mt-0.5 shrink-0"
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Where notifications are delivered. In-app is this application, so it cannot be switched off.
 * Email and Telegram record the choice but say plainly that nothing is sent yet: no
 * `MessagingProvider` is implemented (`docs/INTEGRATIONS.md` schedules them for later phases), and
 * a toggle that silently does nothing would be worse than one that admits it.
 */
export function DeliveryPanel({ state }: { state: PreferencesState }) {
  const { preferences, setChannel } = state;
  return (
    <Card
      title="Notification delivery"
      description="Where these notifications reach you."
      padding="none"
      data-testid="notification-delivery"
    >
      <ul className="grid grid-cols-1 divide-y divide-line-soft md:grid-cols-3 md:divide-x md:divide-y-0">
        {DELIVERY_CHANNELS.map((channel) => {
          const Icon = CHANNEL_ICONS[channel.key];
          const enabled = preferences.channels[channel.key];
          return (
            <li key={channel.key} className="flex items-start gap-3 px-(--card-padding) py-3">
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
                  enabled && channel.connected
                    ? 'bg-primary-soft text-primary-text'
                    : 'bg-surface-muted text-muted',
                )}
              >
                <Icon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                  {channel.label}
                  {channel.connected ? null : (
                    <Badge tone="neutral" variant="outline" size="sm">
                      Not connected
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">{channel.description}</p>
                {channel.note ? <p className="mt-1 text-2xs text-faint">{channel.note}</p> : null}
              </div>
              <Switch
                checked={enabled}
                disabled={channel.locked}
                onCheckedChange={(next) => setChannel(channel.key, next)}
                aria-label={channel.label}
                className="mt-0.5 shrink-0"
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
