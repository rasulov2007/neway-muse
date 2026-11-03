import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { api } from '@/api/client';
import { routes, type BreakdownPerson, type BreakdownShop, type FleetBreakdown, type FleetBreakdownList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { useSession } from '@/auth/session';
import { BREAKDOWN_TONE } from '@/features/office/breakdowns';
import { can, errorText, Field, isConflict } from '@/features/office/common';
import { canMoveBreakdown, type BreakdownStatus } from '@neway/shared/mobile/breakdowns';
import { inEastern } from '@/lib/clock';
import { moneyCents } from '@/lib/format';
import { Button, ListRow, Sheet, TextField } from '@/ui/controls';
import { Screen, Section, Timeline, useToast } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { Divider, Icon, StatusPill, Text } from '@/ui/primitives';
import { Pager } from '@/ui/sheets';
import { LoadingState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space } from '@/ui/tokens';

type Picker = 'assign' | 'shop' | null;

const MOVES: Array<{ status: Extract<BreakdownStatus, 'in_repair' | 'ready' | 'closed'>; label: string }> = [
  { status: 'in_repair', label: 'In repair' },
  { status: 'ready', label: 'Ready' },
  { status: 'closed', label: 'Close case' },
];

function PickerSheet<T extends { id: string; name: string }>({
  title,
  path,
  visible,
  onClose,
  onPick,
  subtitle,
}: {
  title: string;
  path: string;
  visible: boolean;
  onClose: () => void;
  onPick: (item: T) => void;
  subtitle?: (item: T) => string | undefined;
}) {
  const list = useResource<T[]>(visible ? path : null);
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      {list.status === 'loading' ? (
        <LoadingState compact />
      ) : (
        <ResourceView resource={list} what={title} compact>
          {(rows) =>
            rows.length ? (
              <>
                {rows.map((r, i) => (
                  <ListRow key={r.id} title={r.name} subtitle={subtitle?.(r)} chevron={false} divider={i < rows.length - 1} onPress={() => onPick(r)} />
                ))}
              </>
            ) : (
              <Text variant="small" tint={color.text2} style={{ paddingVertical: space.lg }}>
                {t('Nobody to choose yet.')}
              </Text>
            )
          }
        </ResourceView>
      )}
    </Sheet>
  );
}

/**
 * Sheet 20 case page — GET /fleet/breakdowns/:id. Every action is the existing breakdown route,
 * version-checked; offered only with maintenance.edit. In repair needs the work order in the shop
 * (the server refuses otherwise and says why).
 */
export default function BreakdownCase() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useResource<FleetBreakdown>(routes.fleetBreakdown(id));
  const list = useResource<FleetBreakdownList>(routes.fleetBreakdowns(true));
  const { account } = useSession();
  const toast = useToast();
  const [picker, setPicker] = useState<Picker>(null);
  const [shop, setShop] = useState<BreakdownShop | null>(null);
  const [estimate, setEstimate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const mayEdit = can(account, 'maintenance.edit');

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await run();
      toast(done, 'success');
    } catch (e) {
      toast(isConflict(e) ? t('Someone changed this case — reloaded.') : errorText(e), 'danger');
    } finally {
      setBusy(null);
      item.reload();
      list.reload();
    }
  };

  const ids = list.status === 'ready' ? list.data.breakdowns.map((b) => b.id) : [];
  const at = ids.indexOf(id);

  return (
    <Screen onRefresh={item.reload}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
        <Pressable accessibilityRole="link" onPress={() => (router.canGoBack() ? router.back() : router.replace('/office/fleet'))} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flex: 1, minHeight: 36 }}>
          <Icon name="arrow-left" size={18} tint={color.primary} />
          <Text variant="smallStrong" tint={color.primary}>
            {t('Back to cases')}
          </Text>
        </Pressable>
        {at >= 0 ? (
          <>
            <Text variant="caption" tint={color.text2}>
              {t('Case')}{' '}
            </Text>
            <Pager index={at} total={ids.length} onChange={(n) => router.replace(`/office/breakdown/${ids[n]}`)} />
          </>
        ) : null}
      </View>
      <ResourceView resource={item} what={t('This breakdown case')}>
        {(c) => {
          const unit = c.truck ? t('Unit {number}', { number: c.truck.unitNumber }) : c.trailer ? t('Trailer {number}', { number: c.trailer.unitNumber }) : c.number;
          const moves = MOVES.filter((m) => canMoveBreakdown(c.status, m.status));
          const loc = c.location;
          return (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                <Text variant="title">{unit}</Text>
                <StatusPill tone={BREAKDOWN_TONE[c.status]} label={t(c.statusLabel)} />
              </View>
              <Text variant="small" tint={color.text2}>
                {[c.number, c.trailer && c.truck ? t('Trailer {number}', { number: c.trailer.unitNumber }) : null, c.load ? t('Load {number}', { number: c.load.loadNumber }) : null].filter(Boolean).join('  •  ')}
              </Text>
              <Divider style={{ marginVertical: space.md }} />
              <Field label={t('Issue')}>{`${t(c.categoryLabel)}: ${c.description}`}</Field>
              <Field label={t('Driver')}>{c.driver?.name ?? '—'}</Field>
              <Field label={t('Driver location')}>
                <View style={{ gap: 2 }}>
                  <Text variant="small">{loc?.text || '—'}</Text>
                  {loc?.captured_at ? (
                    <Text variant="caption" tint={color.text3}>
                      {loc.source === 'gps' ? 'GPS' : t('Typed by driver')} · {inEastern(loc.captured_at, true)}
                    </Text>
                  ) : null}
                  {loc?.lat != null && loc?.lng != null ? (
                    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`https://maps.google.com/?q=${loc.lat},${loc.lng}`)}>
                      <Text variant="smallStrong" tint={color.link}>
                        {t('View on map')}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </Field>
              <Field label={t('Assigned to')}>{c.responsible?.name ?? t('Nobody yet')}</Field>
              <Field label={t('Shop')}>{c.vendor?.name ?? c.shopName ?? t('Not arranged')}</Field>
              {c.workOrder ? <Field label={t('Work order')}>{`${c.workOrder.number} · ${t(c.workOrder.status.replace(/_/g, ' '))}`}</Field> : null}

              {c.fileIds.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
                  {c.fileIds.map((f) => (
                    <SignedImage key={f} linkRoute={routes.fileLink(f)} style={{ width: 96, height: 72 }} />
                  ))}
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.lg }}>
                <View style={{ width: 120, gap: 2 }}>
                  <Text variant="smallStrong">{t('Estimate')}</Text>
                  <Text variant="title">{c.estimateCents != null ? moneyCents(c.estimateCents) : '—'}</Text>
                  <Text variant="caption" tint={color.text2}>
                    {c.estimateCents != null ? t('From the shop') : t('No estimate yet')}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="smallStrong" style={{ marginBottom: space.sm }}>
                    {t('Repair timeline')}
                  </Text>
                  <Timeline
                    steps={c.steps.map((s) => ({
                      key: s.status,
                      title: t(s.label),
                      state: s.current ? (s.status === 'closed' || s.status === 'ready' ? 'done' : 'current') : s.reachedAt ? 'done' : 'pending',
                      subtitle: s.reachedAt ? inEastern(s.reachedAt, true) : null,
                    }))}
                  />
                </View>
              </View>

              {c.latestUpdate ? (
                <Section title={t('Latest update')}>
                  <Text variant="small">{c.latestUpdate.text}</Text>
                  <Text variant="caption" tint={color.text3}>
                    {inEastern(c.latestUpdate.at, true)}
                  </Text>
                </Section>
              ) : null}

              {mayEdit && c.status !== 'closed' ? (
                <Section title={t('Actions')}>
                  <View style={{ gap: space.sm }}>
                    <Button variant="outline" icon="account-arrow-right-outline" label={c.responsible ? t('Reassign') : t('Assign')} loading={busy === 'assign'} onPress={() => setPicker('assign')} />
                    <Button variant="outline" icon="store-outline" label={c.vendor ? t('Change shop') : t('Arrange shop')} loading={busy === 'shop'} onPress={() => setPicker('shop')} />
                    {!c.workOrder ? (
                      <Button
                        variant="outline"
                        icon="wrench-outline"
                        label={t('Open work order (in the shop)')}
                        loading={busy === 'wo'}
                        onPress={() => void act('wo', () => api.post(routes.fleetBreakdownWorkOrder(c.id), { version: c.version, create: { status: 'in_shop' } }), t('Work order opened; the unit is in the shop.'))}
                      />
                    ) : null}
                    {moves.length ? (
                      <View style={{ flexDirection: 'row', gap: space.sm }}>
                        {moves.map((m) => (
                          <Button
                            key={m.status}
                            style={{ flex: 1 }}
                            compact
                            label={t(m.label)}
                            variant={m.status === 'closed' ? 'outline' : 'primary'}
                            loading={busy === m.status}
                            onPress={() => void act(m.status, () => api.patch(routes.fleetBreakdownStatus(c.id), { version: c.version, status: m.status }), m.status === 'closed' ? t('Case is now closed.') : t('Case is now {status}.', { status: t(m.label) }))}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                </Section>
              ) : null}

              {c.history.length ? (
                <Section title={t('History')}>
                  {[...c.history].reverse().map((h, i) => (
                    <View key={`${h.at}${i}`} style={{ paddingVertical: space.sm }}>
                      <Text variant="small">
                        {t(h.kind.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()))} · {h.byName}
                      </Text>
                      {h.note ? (
                        <Text variant="caption" tint={color.text2}>
                          {h.note}
                        </Text>
                      ) : null}
                      <Text variant="caption" tint={color.text3}>
                        {inEastern(h.at, true)}
                      </Text>
                    </View>
                  ))}
                </Section>
              ) : null}

              <PickerSheet<BreakdownPerson>
                title={t('Assign to')}
                path={routes.fleetBreakdownPeople}
                visible={picker === 'assign'}
                onClose={() => setPicker(null)}
                onPick={(p) => {
                  setPicker(null);
                  void act('assign', () => api.post(routes.fleetBreakdownAssign(c.id), { version: c.version, userId: p.id }), t('Assigned to {name}.', { name: p.name }));
                }}
              />
              <PickerSheet<BreakdownShop>
                title={t('Arrange shop')}
                path={routes.fleetBreakdownShops}
                visible={picker === 'shop' && !shop}
                onClose={() => setPicker(null)}
                subtitle={(s) => [s.city, s.state].filter(Boolean).join(', ') || undefined}
                onPick={(s) => {
                  setEstimate('');
                  setShop(s);
                }}
              />
              <Sheet
                visible={Boolean(shop)}
                title={shop?.name ?? t('Shop')}
                onClose={() => {
                  setShop(null);
                  setPicker(null);
                }}
              >
                <View style={{ gap: space.md, paddingVertical: space.md }}>
                  <TextField label={t('Estimate (optional)')} placeholder="0.00" keyboardType="decimal-pad" value={estimate} onChangeText={(v) => setEstimate(v.replace(/[^\d.]/g, ''))} icon="currency-usd" />
                  <Button
                    label={t('Arrange shop')}
                    loading={busy === 'shop'}
                    onPress={() => {
                      const s = shop!;
                      const cents = estimate.trim() ? Math.round(Number(estimate) * 100) : null;
                      setShop(null);
                      setPicker(null);
                      void act(
                        'shop',
                        () => api.post(routes.fleetBreakdownShop(c.id), { version: c.version, vendorId: s.id, ...(cents !== null && !Number.isNaN(cents) ? { estimateCents: cents } : {}) }),
                        t('Shop arranged: {name}.', { name: s.name }),
                      );
                    }}
                  />
                </View>
              </Sheet>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
