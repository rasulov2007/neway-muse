import { Tabs } from 'expo-router/js-tabs';

import { OFFICE_TABS, TabBar } from '@/ui/tab-bar';

export default function OfficeTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} specs={OFFICE_TABS} />}>
      {OFFICE_TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
      ))}
    </Tabs>
  );
}
