import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type DriverLoadScope, type DriverLoadsResponse } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { TripCard } from '@/features/components';
import { SegmentedTabs } from '@/ui/controls';
import { Screen } from '@/ui/layout';
import { EmptyState, ResourceView } from '@/ui/states';
import { space } from '@/ui/tokens';
import { t } from '@/i18n';

function emptyText(scope: DriverLoadScope): string {
  return { active: t('No active trip right now.'), upcoming: t('No upcoming trips assigned yet.'), completed: t('No completed trips yet.') }[scope];
}

/** Sheet 02 — GET /driver/loads?scope=. */
export default function Trips() {
  const [scope, setScope] = useState<DriverLoadScope>('active');
  const trips = useResource<DriverLoadsResponse>(routes.driverLoads(scope));
  return (
    <Screen title={t('Trips')} onRefresh={trips.reload}>
      <SegmentedTabs
        options={[
          { key: 'active', label: t('Active') },
          { key: 'upcoming', label: t('Upcoming') },
          { key: 'completed', label: t('Completed') },
        ]}
        value={scope}
        onChange={setScope}
      />
      <View style={{ marginTop: space.lg, gap: space.md }}>
        <ResourceView resource={trips} what={t('Your trips')}>
          {({ loads }) =>
            loads.length ? (
              loads.map((load) => <TripCard key={load.id} load={load} onPress={() => router.push(`/driver/load/${load.id}`)} />)
            ) : (
              <EmptyState icon="truck-outline" title={emptyText(scope)} />
            )
          }
        </ResourceView>
      </View>
    </Screen>
  );
}
