import { router, type Href } from 'expo-router';
import { View, StyleSheet } from 'react-native';

import { routes, type OfficeMyWork, type OfficeTask, type OfficeWorkspace } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import type { PtoBalance } from '@neway/shared/hr/pto';
import { longDate, useOfficeMe } from '@/features/office/common';
import { addDays, easternDay, inEastern } from '@/lib/clock';
import { hrefFor } from '@/lib/deep-link';
import { ListRow } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { Icon, StatusPill, Text, type IconName } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space, type StatusTone } from '@/ui/tokens';

const WORKSPACES: Array<{ key: OfficeWorkspace; href: Href; icon: IconName; title: string; subtitle: string }> = [
  { key: 'dispatch', href: '/office/dispatch', icon: 'truck-fast-outline', title: 'Dispatch', subtitle: 'Trucks, drivers and loads' },
  { key: 'safety', href: '/office/safety', icon: 'shield-check-outline', title: 'Safety', subtitle: 'PTI review, documents, incidents' },
  { key: 'fleet', href: '/office/fleet', icon: 'wrench-outline', title: 'Fleet', subtitle: 'Breakdown cases and repairs' },
  { key: 'accounting', href: '/office/accounting', icon: 'calculator-variant-outline', title: 'Accounting', subtitle: 'PODs, reimbursements, settlements' },
  { key: 'recruiting', href: '/office/recruiting', icon: 'account-plus-outline', title: 'Recruiting', subtitle: 'My leads' },
  { key: 'owner', href: '/office/owner', icon: 'chart-box-outline', title: 'Owner overview', subtitle: 'Revenue, expenses, fleet status' },
];

function priority(p: string | null): { tone: StatusTone; label: string } | null {
  if (!p) return null;
  const s = p.toLowerCase();
  if (s === 'high' || s === 'urgent' || s === 'critical') return { tone: 'danger', label: t(s === 'high' ? 'High' : s.replace(/^\w/, (c) => c.toUpperCase())) };
  if (s === 'medium' || s === 'normal_high') return { tone: 'warning', label: t('Medium') };
  return { tone: 'neutral', label: t(s.replace(/^\w/, (c) => c.toUpperCase())) };
}

function due(at: string | null): string | null {
  if (!at) return null;
  const day = easternDay(new Date(at));
  const today = easternDay();
  const time = inEastern(at) ?? '';
  if (day === today) return t('Due today {time}', { time });
  if (day === addDays(today, 1)) return t('Due tomorrow {time}', { time });
  if (day < today) return t('Overdue · {when}', { when: inEastern(at, true) });
  return t('Due {when}', { when: inEastern(at, true) });
}

const ATTENDANCE: Record<OfficeMyWork['attendance']['status'], { tone: StatusTone; label: string }> = {
  checked_in: { tone: 'success', label: 'Checked in' },
  checked_out: { tone: 'neutral', label: 'Checked out' },
  not_checked_in: { tone: 'warning', label: 'Not checked in' },
  no_employee: { tone: 'neutral', label: 'Not linked to an employee' },
};

function TaskRow({ task, last }: { task: OfficeTask; last: boolean }) {
  const p = priority(task.priority);
  const href = task.target ? hrefFor('office', task.target) : null;
  return (
    <ListRow
      left={<Icon name="checkbox-blank-outline" size={22} tint={color.text3} />}
      title={<Text variant="small">{task.title}</Text>}
      meta={due(task.dueAt) ?? undefined}
      right={p ? <StatusPill tone={p.tone} label={p.label} /> : null}
      chevron={Boolean(href)}
      divider={!last}
      onPress={href ? () => router.push(href) : undefined}
    />
  );
}

/** Sheet 18 — my tasks and my info (GET /office/my-work, GET /hr/pto/me), then my workspaces. */
export default function Work() {
  const work = useResource<OfficeMyWork>(routes.officeMyWork);
  const pto = useResource<PtoBalance[]>(routes.ptoMe);
  const me = useOfficeMe();
  const allowed = me.status === 'ready' ? WORKSPACES.filter((w) => me.data.workspaces.includes(w.key)) : [];

  return (
    <Screen
      title={t('My work')}
      subtitle={longDate()}
      onRefresh={() => {
        work.reload();
        pto.reload();
        me.reload();
      }}
    >
      <ResourceView resource={work} what={t('Your work')}>
        {(w) => {
          const att = ATTENDANCE[w.attendance.status];
          const attLabel = t(att.label);
          return (
            <>
              <Section title={t('My tasks ({count})', { count: w.tasks.length })} style={{ marginTop: 0 }}>
                {w.tasks.length ? (
                  w.tasks.map((task, i) => <TaskRow key={task.id} task={task} last={i === w.tasks.length - 1} />)
                ) : (
                  <EmptyState compact icon="check-all" title={t('No open tasks')} />
                )}
              </Section>
              <Section title={t('My info')}>
                <ListRow
                  left={<Icon name="clock-outline" tint={color.ink} />}
                  title={t('Attendance')}
                  chevron={false}
                  right={
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <StatusPill tone={att.tone} label={attLabel} />
                      {w.attendance.since && w.attendance.status === 'checked_in' ? (
                        <Text variant="caption" tint={color.text2}>
                          {t('Since {time}', { time: inEastern(w.attendance.since) })}
                        </Text>
                      ) : null}
                    </View>
                  }
                />
                <ListRow
                  left={<Icon name="calendar-month-outline" tint={color.ink} />}
                  title={t('PTO balance')}
                  chevron={false}
                  right={
                    pto.status === 'loading' ? (
                      <Text variant="caption" tint={color.text2}>
                        {t('Loading…')}
                      </Text>
                    ) : pto.status === 'error' ? (
                      <Text variant="caption" tint={color.text2}>
                        {t('Not available')}
                      </Text>
                    ) : pto.data.length ? (
                      <View style={{ alignItems: 'flex-end' }}>
                        {pto.data.map((b, i) => (
                          <Text key={b.policyId ?? i} variant="smallStrong">
                            {b.policyName}: {t('{hours} h', { hours: b.balance })}{b.pending ? ` ${t('({hours} h pending)', { hours: b.pending })}` : ''}
                          </Text>
                        ))}
                      </View>
                    ) : (
                      <Text variant="caption" tint={color.text2} style={{ maxWidth: 180, textAlign: 'right' }}>
                        {w.pto.employeeLinked ? t('No PTO balance on file') : t('No PTO balance (no employee record)')}
                      </Text>
                    )
                  }
                />
                {w.salaryReport ? (
                  <ListRow
                    left={<Icon name="file-document-outline" tint={color.ink} />}
                    title={t('Salary report')}
                    meta={t('Open in the TMS')}
                    chevron={false}
                    divider={false}
                    right={
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.subtle, borderRadius: 6, paddingHorizontal: space.sm, paddingVertical: 3 }}>
                        <Icon name="lock-outline" size={14} tint={color.text2} />
                        <Text variant="captionStrong" tint={color.text2}>
                          {t('Private')}
                        </Text>
                      </View>
                    }
                  />
                ) : null}
              </Section>
            </>
          );
        }}
      </ResourceView>
      <Section title={t('Workspaces')}>
        <ResourceView resource={me} what={t('Your workspaces')} compact>
          {() =>
            allowed.length ? (
              <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.divider }}>
                {allowed.map((w, i) => (
                  <ListRow key={w.key} left={<Icon name={w.icon} tint={color.primary} />} title={t(w.title)} subtitle={t(w.subtitle)} divider={i < allowed.length - 1} onPress={() => router.push(w.href)} />
                ))}
              </View>
            ) : (
              <EmptyState compact icon="lock-outline" title={t('No workspaces for your role')} />
            )
          }
        </ResourceView>
      </Section>
    </Screen>
  );
}
