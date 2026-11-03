import type { ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import type { ApiError } from '@/api/client';
import type { ResourceWithReload } from '@/api/use-resource';
import { useOnline } from '@/offline/network';

import { t } from '@/i18n/core';

import { Button } from './controls';
import { Icon, Text, type IconName } from './primitives';
import { color, gutter, space } from './tokens';

function StateFrame({
  icon,
  iconTint = color.text3,
  title,
  body,
  action,
  compact,
}: {
  icon: IconName | null;
  iconTint?: string;
  title: string;
  body?: string | null;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ alignItems: 'center', paddingVertical: compact ? space.xl : 48, paddingHorizontal: gutter, gap: space.sm }}
    >
      {icon ? <Icon name={icon} size={compact ? 28 : 40} tint={iconTint} /> : null}
      <Text variant="subheading" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {body ? (
        <Text variant="small" tint={color.text2} style={{ textAlign: 'center', maxWidth: 320 }}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: space.sm, alignSelf: 'stretch', alignItems: 'center' }}>{action}</View> : null}
    </View>
  );
}

/** "Loading…" — never a zero or a dash before the answer arrives. */
export function LoadingState({ label = t('Loading…'), compact }: { label?: string; compact?: boolean }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: compact ? space.lg : 48 }}
    >
      <ActivityIndicator size="small" color={color.text2} />
      <Text variant="small" tint={color.text2}>
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({ icon = 'inbox-outline', title, body, action, compact }: { icon?: IconName; title: string; body?: string; action?: ReactNode; compact?: boolean }) {
  return <StateFrame icon={icon} title={title} body={body} action={action} compact={compact} />;
}

export function ErrorState({ title = t('Could not load this'), body, onRetry, compact }: { title?: string; body?: string | null; onRetry?: () => void; compact?: boolean }) {
  return (
    <StateFrame
      icon="alert-octagon"
      iconTint={color.danger}
      title={title}
      body={body}
      compact={compact}
      action={onRetry ? <Button label={t('Try again')} variant="outline" icon="refresh" onPress={onRetry} /> : null}
    />
  );
}

export function OfflineState({ onRetry, compact }: { onRetry?: () => void; compact?: boolean }) {
  return (
    <StateFrame
      icon="wifi-off"
      title={t("You're offline")}
      body={t("This needs a connection to the TMS. Anything you save is kept on this phone and sent when you're back online.")}
      compact={compact}
      action={onRetry ? <Button label={t('Try again')} variant="outline" icon="refresh" onPress={onRetry} /> : null}
    />
  );
}

export function PermissionDenied({ what = t('this'), compact }: { what?: string; compact?: boolean }) {
  return (
    <StateFrame
      icon="lock-outline"
      title={t('No access')}
      body={t('Your role does not include {what}. Ask your administrator if you need it.', { what })}
      compact={compact}
    />
  );
}

/** Honest placeholder for a screen whose backend phase has not shipped yet. */
export function ComingSoon({ title = t('Coming in this build'), body, phase, compact }: { title?: string; body?: string; phase?: string; compact?: boolean }) {
  return (
    <StateFrame
      icon="progress-wrench"
      title={title}
      body={[body ?? t('This screen is ready; the TMS side of it is still being built.'), phase ? `(${phase})` : null].filter(Boolean).join(' ')}
      compact={compact}
    />
  );
}

/** A route the server does not have yet (404 "Cannot GET …"). */
export function NotConnected({ what, compact, onRetry }: { what: string; compact?: boolean; onRetry?: () => void }) {
  return (
    <StateFrame
      icon="link-variant-off"
      title={t('Not connected yet')}
      body={t('The TMS does not serve this to the app yet ({what}). Nothing is shown rather than a guess.', { what: what.toLowerCase() })}
      compact={compact}
      action={onRetry ? <Button label={t('Check again')} variant="outline" icon="refresh" onPress={onRetry} /> : null}
    />
  );
}

export function ErrorFor({ error, what, onRetry, compact }: { error: ApiError; what: string; onRetry?: () => void; compact?: boolean }) {
  switch (error.kind) {
    case 'offline':
      return <OfflineState onRetry={onRetry} compact={compact} />;
    case 'forbidden':
      return <PermissionDenied what={what.toLowerCase()} compact={compact} />;
    case 'not_connected':
      return <NotConnected what={what} onRetry={onRetry} compact={compact} />;
    case 'not_found':
      return <EmptyState icon="file-question-outline" title={t('Not found')} body={error.detail ?? t('It may have been removed or is not yours to see.')} compact={compact} />;
    default:
      return <ErrorState body={error.detail ?? error.title} onRetry={onRetry} compact={compact} />;
  }
}

/** Renders a resource's loading / error states, or its data through `children`. */
export function ResourceView<T>({
  resource,
  what,
  children,
  compact,
}: {
  resource: ResourceWithReload<T>;
  what: string;
  children: (data: T) => ReactNode;
  compact?: boolean;
}) {
  if (resource.status === 'loading') return <LoadingState compact={compact} />;
  if (resource.status === 'error') return <ErrorFor error={resource.error} what={what} onRetry={resource.reload} compact={compact} />;
  return <>{children(resource.data)}</>;
}

/** The strip under the header while the phone is offline. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        backgroundColor: color.warningBg,
        paddingHorizontal: gutter,
        paddingVertical: space.sm,
      }}
    >
      <Icon name="wifi-off" size={18} tint={color.warning} />
      <Text variant="small" tint={color.warning} style={{ flex: 1 }}>
        {t("Offline — saved on this phone, sent when you're back online.")}
      </Text>
    </View>
  );
}
