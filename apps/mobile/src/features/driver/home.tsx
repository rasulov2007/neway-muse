import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, View } from 'react-native';

import type { DriverLoadSummary } from '@/api/contract';
import { MiniOrb } from '@/features/assistant/orb';
import { appointment, loadStatus, placeOf } from '@/features/loads';
import { Icon, StatusPill, Text, type IconName } from '@/ui/primitives';
import { color, elevation, radius, space, type StatusTone } from '@/ui/tokens';
import { t } from '@/i18n';

/**
 * The driver Home pieces (mobile M6, after the owner's fintech reference): the stacked load cards,
 * the round quick actions, the Ask NeWay row and the clean list rows below.
 */

const PEEK = 14;

function Route({ from, to }: { from: string; to: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ flexShrink: 1, maxWidth: '42%' }}>
        <Text variant="caption" tint={color.onCardMuted}>
          {t('Pickup')}
        </Text>
        <Text variant="bodyStrong" tint={color.onCard} numberOfLines={1}>
          {from || t('Not set')}
        </Text>
      </View>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 14 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color.onCard }} />
        <View style={{ flex: 1, borderTopWidth: 1.5, borderStyle: 'dashed', borderColor: color.onCardLine }} />
        <Icon name="truck-fast-outline" size={18} tint={color.onCard} />
        <View style={{ flex: 1, borderTopWidth: 1.5, borderStyle: 'dashed', borderColor: color.onCardLine }} />
        <Icon name="map-marker" size={14} tint={color.onCard} />
      </View>
      <View style={{ flexShrink: 1, maxWidth: '42%', alignItems: 'flex-end' }}>
        <Text variant="caption" tint={color.onCardMuted}>
          {t('Delivery')}
        </Text>
        <Text variant="bodyStrong" tint={color.onCard} numberOfLines={1}>
          {to || t('Not set')}
        </Text>
      </View>
    </View>
  );
}

/** The pill that overlaps a card's bottom-right corner ("+ Add card" on the reference). */
export function DockPill({ label, icon, onPress, style }: { label: string; icon?: IconName; onPress: () => void; style?: object }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: color.dock, borderRadius: radius.pill, paddingHorizontal: space.lg, minHeight: 44, opacity: pressed ? 0.85 : 1 },
        elevation.card,
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={18} tint={color.onDock} /> : null}
      <Text variant="smallStrong" tint={color.onDock}>
        {label}
      </Text>
    </Pressable>
  );
}

function FrontCard({ load, position }: { load: DriverLoadSummary; position: 'current' | 'next' }) {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, friction: 8, tension: 80 }).start();
  }, [enter]);
  const status = loadStatus(load.status);
  const next = load.nextStop;
  const when = next ? appointment(next) : null;
  return (
    <Animated.View
      style={{
        opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-PEEK, 0] }) }, { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
      }}
    >
      <LinearGradient colors={[color.cardFrom, color.cardTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: radius.xxl, padding: space.xl, paddingBottom: space.xxl + space.sm, gap: space.lg }, elevation.card]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="overline" tint={color.onCardMuted}>
              {position === 'current' ? t('CURRENT LOAD') : t('NEXT LOAD')}
            </Text>
            <Text style={{ fontSize: 28, lineHeight: 34, fontWeight: '800' }} tint={color.onCard} numberOfLines={1}>
              #{load.loadNumber}
            </Text>
            {load.truckUnit || load.trailerUnit ? (
              <Text variant="caption" tint={color.onCardMuted} numberOfLines={1}>
                {[load.truckUnit ? t('Truck {unit}', { unit: load.truckUnit }) : null, load.trailerUnit ? t('Trailer {unit}', { unit: load.trailerUnit }) : null].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>
          <StatusPill tone={status.tone} label={t(load.statusLabel || status.label)} />
        </View>
        <Route from={placeOf(load.firstPickup)} to={placeOf(load.lastDelivery)} />
        {load.loadedMiles || load.deadheadMiles ? (
          <Text variant="caption" tint={color.onCardMuted} numberOfLines={1}>
            {[load.loadedMiles ? t('Loaded {miles} mi', { miles: load.loadedMiles.toLocaleString('en-US') }) : null, load.deadheadMiles ? t('DH {miles} mi', { miles: load.deadheadMiles.toLocaleString('en-US') }) : null,].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        <View style={{ paddingRight: 140 }}>
          <View style={{ gap: 1 }}>
            <Text variant="caption" tint={color.onCardMuted}>
              {next ? (next.kind === 'pickup' ? t('Next pickup appointment') : t('Next delivery appointment')) : t('No open stop')}
            </Text>
            {when?.local ? (
              <Text variant="smallStrong" tint={color.onCard}>
                {when.local}
              </Text>
            ) : null}
            {when?.eastern ? (
              <Text variant="caption" tint={color.onCardMuted}>
                {when.eastern}
              </Text>
            ) : null}
          </View>
        </View>
      </LinearGradient>
      <DockPill label={t('Open load')} icon="arrow-right" onPress={() => router.push(`/driver/load/${load.id}`)} style={{ position: 'absolute', right: space.xl, bottom: -22 }} />
    </Animated.View>
  );
}

/**
 * The current load in front, the next ones peeking above it. Tapping a peeking card brings it to
 * the front. Only the driver's real loads are drawn: no decorative cards.
 */
export function LoadStack({ loads, activeCount }: { loads: DriverLoadSummary[]; activeCount: number }) {
  const [front, setFront] = useState(0);
  const shown = loads.slice(0, 3);
  const index = front < shown.length ? front : 0;
  const order = shown.map((_, i) => (index + i) % shown.length);
  const backs = order.slice(1).reverse();
  const backColors = [color.cardBack1, color.cardBack2];
  return (
    <View style={{ paddingTop: PEEK * backs.length, marginBottom: space.xxl + space.xs }}>
      {backs.map((li, j) => {
        const depth = backs.length - j; // 2 = furthest
        const load = shown[li]!;
        return (
          <Pressable
            key={load.id}
            accessibilityRole="button"
            accessibilityLabel={t('Show load {number}', { number: load.loadNumber })}
            onPress={() => setFront(li)}
            style={{
              position: 'absolute',
              top: (backs.length - depth) * PEEK,
              left: space.lg * depth * 0.6,
              right: space.lg * depth * 0.6,
              height: 120,
              borderRadius: radius.xxl,
              backgroundColor: backColors[(depth - 1) % backColors.length],
              opacity: depth === 2 ? 0.55 : 0.85,
            }}
          />
        );
      })}
      <FrontCard key={shown[index]!.id} load={shown[index]!} position={index < activeCount ? 'current' : 'next'} />
      {shown.length > 1 ? (
        <View style={{ position: 'absolute', bottom: -28, left: space.xs, height: 20, flexDirection: 'row', gap: 6, alignItems: 'center' }} accessibilityLabel={t('Load {n} of {total}', { n: index + 1, total: shown.length })}>
          {shown.map((l, i) => (
            <Pressable key={l.id} onPress={() => setFront(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Show load {number}', { number: l.loadNumber })}>
              <View style={{ width: i === index ? 18 : 7, height: 7, borderRadius: 4, backgroundColor: i === index ? color.primary : color.borderStrong }} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A plain card when there is no load, or while the loads are loading (never a made-up number). */
export function LoadStackPlaceholder({ title, body }: { title: string; body?: string }) {
  return (
    <LinearGradient colors={[color.cardFrom, color.cardTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: radius.xxl, padding: space.xl, minHeight: 150, justifyContent: 'center', gap: space.xs, marginBottom: space.lg }, elevation.card]}>
      <Text variant="heading" tint={color.onCard}>
        {title}
      </Text>
      {body ? (
        <Text variant="small" tint={color.onCardMuted}>
          {body}
        </Text>
      ) : null}
    </LinearGradient>
  );
}

export interface QuickAction {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  badge?: number | null;
}

/** Round icon buttons in a rounded panel (Send / Request / TopUp / More on the reference). */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: color.panel, borderRadius: radius.xl, paddingVertical: space.lg, paddingHorizontal: space.md }}>
      {actions.map((a) => (
        <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={a.badge ? t('{label}, {count} new', { label: a.label, count: a.badge }) : a.label} onPress={a.onPress} style={{ alignItems: 'center', gap: space.xs, flex: 1 }}>
          {({ pressed }) => (
            <>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: pressed ? color.subtlePressed : color.primaryTint, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.94 : 1 }] }}>
                <Icon name={a.icon} size={24} tint={color.primaryInk} />
                {a.badge ? (
                  <View style={{ position: 'absolute', top: 2, right: 2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: color.dangerIcon, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                    <Text style={{ fontSize: 10, lineHeight: 12, fontWeight: '700' }} tint={color.onPrimary}>
                      {a.badge > 9 ? '9+' : a.badge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text variant="captionStrong" tint={color.ink}>
                {a.label}
              </Text>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}

/** The Ask NeWay row ("Daily Reward · Open" on the reference). */
export function AskRow() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Ask NeWay about your pay and loads')}
      onPress={() => router.push('/driver/assistant')}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.panel, borderRadius: radius.xl, padding: space.md, opacity: pressed ? 0.9 : 1 })}
    >
      <MiniOrb size={44} />
      <View style={{ flex: 1 }}>
        <Text variant="rowTitle">{t('Ask NeWay')}</Text>
        <Text variant="caption" tint={color.text2}>
          {t('Your pay, loads and how-to — by voice or text')}
        </Text>
      </View>
      <View style={{ backgroundColor: color.dock, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        <Text variant="smallStrong" tint={color.onDock}>
          {t('Ask')}
        </Text>
      </View>
    </Pressable>
  );
}

/** A clean list row: tinted square icon, title + time, value on the right ("Manage Expenses"). */
export function HomeRow({
  icon,
  tone = 'info',
  title,
  subtitle,
  value,
  valueTone,
  href,
  done,
  last,
}: {
  icon: IconName;
  tone?: StatusTone | 'accent';
  title: string;
  subtitle?: string | null;
  value?: ReactNode;
  valueTone?: string;
  href?: Href;
  done?: boolean;
  last?: boolean;
}) {
  const bg = tone === 'accent' ? color.primaryTint : tone === 'success' ? color.successBg : tone === 'warning' ? color.warningBg : tone === 'danger' ? color.dangerBg : tone === 'neutral' ? color.neutralBg : color.infoBg;
  const fg = tone === 'accent' ? color.primaryInk : tone === 'success' ? color.successIcon : tone === 'warning' ? color.warningIcon : tone === 'danger' ? color.dangerIcon : tone === 'neutral' ? color.neutralIcon : color.infoIcon;
  return (
    <Pressable
      accessibilityRole={href ? 'button' : 'text'}
      accessibilityState={done !== undefined ? { checked: done } : undefined}
      disabled={!href}
      onPress={() => href && router.push(href)}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderBottomWidth: last ? 0 : 1, borderColor: color.divider, opacity: pressed ? 0.75 : 1 })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} tint={fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text variant="rowTitle" tint={done ? color.text2 : color.ink}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tint={color.text3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {typeof value === 'string' ? (
        <Text variant="bodyStrong" tint={valueTone ?? color.ink} numberOfLines={1} style={{ flexShrink: 0, textAlign: 'right' }}>
          {value}
        </Text>
      ) : (
        value
      )}
      {href ? <Icon name="chevron-right" size={20} tint={color.text3} /> : null}
    </Pressable>
  );
}

export function HomeSection({ title, action, onAction, children }: { title: string; action?: string; onAction?: () => void; children: ReactNode }) {
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.xs }}>
        <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
          {title}
        </Text>
        {action ? (
          <Pressable accessibilityRole="link" onPress={onAction} hitSlop={8}>
            <Text variant="smallStrong" tint={color.link}>
              {action}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ backgroundColor: color.panel, borderRadius: radius.xl, paddingHorizontal: space.lg }}>{children}</View>
    </View>
  );
}

/** "BOL for Acme DC" (a paper still due, worded by the server) in the chosen language. */
export function dueLabel(label: string): string {
  const m = /^(BOL|POD) for (.+)$/.exec(label);
  return m ? t('{doc} for {place}', { doc: m[1], place: m[2] }) : t(label);
}
