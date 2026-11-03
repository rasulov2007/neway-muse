import { Tabs } from 'expo-router/js-tabs';

import { DOCK_SPACE, DockSpaceContext, DRIVER_TABS, FloatingTabBar } from '@/ui/tab-bar';

/** The driver shell: five tabs in the floating dock; every page leaves room for it at the bottom. */
export default function DriverTabs() {
  return (
    <DockSpaceContext.Provider value={DOCK_SPACE}>
      <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <FloatingTabBar {...props} specs={DRIVER_TABS} />}>
        {DRIVER_TABS.map((t) => (
          <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
        ))}
      </Tabs>
    </DockSpaceContext.Provider>
  );
}
