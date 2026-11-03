import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type OfficeToday } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { AttentionList, AttentionStrip } from '@/features/office/attention';
import { longDate, OmittedNotes, useOfficeMe } from '@/features/office/common';
import { RolePicker, useOfficeRole } from '@/features/office/role-picker';
import { Button } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { CounterRow } from '@/ui/sheets';
import { EmptyState, LoadingState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { space } from '@/ui/tokens';

const COLLAPSED = 3;

/**
 * Sheet 13 — what needs attention for the chosen role, then the day's counters
 * (GET /office/today?role=). The roles offered are the server's todayRoles for this person.
 */
export default function OfficeTodayScreen() {
  const me = useOfficeMe();
  const roles = me.status === 'ready' ? me.data.todayRoles : null;
  const [role, setRole] = useOfficeRole(roles);
  const today = useResource<OfficeToday>(role ? routes.officeToday(role) : null);
  const [open, setOpen] = useState(false);

  return (
    <Screen
      title={t('Today')}
      subtitle={longDate()}
      titleRight={role && roles ? <RolePicker role={role} roles={roles} onChange={setRole} /> : null}
      onRefresh={() => {
        me.reload();
        today.reload();
      }}
    >
      {me.status !== 'ready' ? (
        <ResourceView resource={me} what={t('Your Today view')}>
          {() => null}
        </ResourceView>
      ) : !role ? (
        me.data.todayRoles.length === 0 ? (
          <EmptyState icon="lock-outline" title={t('No Today view for your role')} body={t('Ask your administrator for access to a department.')} />
        ) : (
          <LoadingState />
        )
      ) : (
        <ResourceView resource={today} what={t('Your Today view')}>
          {(d) => {
            // The counters' words come from the server in English; known ones are translated here.
            const counters = d.sections.flatMap((s) => s.counters).map((c) => ({ ...c, label: t(c.label) }));
            const shown = open ? d.attention : d.attention.slice(0, COLLAPSED);
            return (
              <>
                {d.attention.length ? (
                  <>
                    <AttentionStrip count={d.attention.length} open={open} onToggle={() => setOpen((o) => !o)} />
                    <AttentionList items={shown} />
                  </>
                ) : (
                  <EmptyState compact icon="check-circle-outline" title={t('Nothing needs attention')} />
                )}
                <CounterRow counters={counters} />
                {d.role === 'owner' ? (
                  <Section>
                    <Button variant="outline" icon="chart-box-outline" label={t('Owner overview')} onPress={() => router.push('/office/owner')} />
                  </Section>
                ) : null}
                <View style={{ marginTop: space.sm }}>
                  <OmittedNotes omitted={d.omitted} />
                </View>
              </>
            );
          }}
        </ResourceView>
      )}
    </Screen>
  );
}
