import { BlurView } from 'expo-blur';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, Platform, Pressable, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/i18n/core';

import { Icon, Text, type IconName } from './primitives';
import { color, elevation, space } from './tokens';

/** Room a page leaves at its bottom for the floating dock (0 where there is none). */
export const DockSpaceContext = createContext(0);
export const DOCK_HEIGHT = 64;
export const DOCK_SPACE = DOCK_HEIGHT + 28;
export function useDockSpace(): number {
  return useContext(DockSpaceContext);
}

export interface TabSpec {
  name: string;
  label: string;
  icon: IconName;
  activeIcon: IconName;
}

export const DRIVER_TABS: TabSpec[] = [
  { name: 'today', label: 'Today', icon: 'home-outline', activeIcon: 'home' },
  { name: 'trips', label: 'Trips', icon: 'truck-outline', activeIcon: 'truck' },
  { name: 'money', label: 'Money', icon: 'currency-usd', activeIcon: 'currency-usd' },
  { name: 'inbox', label: 'Inbox', icon: 'email-outline', activeIcon: 'email' },
  { name: 'more', label: 'More', icon: 'menu', activeIcon: 'menu' },
];

export const OFFICE_TABS: TabSpec[] = [
  { name: 'today', label: 'Today', icon: 'home-outline', activeIcon: 'home' },
  { name: 'work', label: 'Work', icon: 'format-list-bulleted', activeIcon: 'format-list-bulleted' },
  { name: 'inbox', label: 'Inbox', icon: 'message-outline', activeIcon: 'message' },
  { name: 'approvals', label: 'Approvals', icon: 'check-circle-outline', activeIcon: 'check-circle' },
  { name: 'more', label: 'More', icon: 'dots-horizontal', activeIcon: 'dots-horizontal' },
];

/** The five-tab bar from the sheets: icon over label, navy when active, a hairline above. */
export function TabBar({ state, emitter, navigateToTab, specs }: BottomTabBarProps & { specs: TabSpec[] }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: color.background,
        paddingBottom: Math.max(insets.bottom, space.xs),
        paddingTop: space.xs,
      }}
    >
      {state.routes.map((route, index) => {
        const spec = specs.find((s) => s.name === route.name);
        if (!spec) return null;
        const focused = state.index === index;
        const tint = focused ? color.primary : color.text3;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={t(spec.label)}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true } as never) as { defaultPrevented?: boolean } | undefined;
              if (!focused && !event?.defaultPrevented) navigateToTab(route.key);
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 52, gap: 2 }}
          >
            <Icon name={focused ? spec.activeIcon : spec.icon} size={24} tint={tint} />
            <Text variant={focused ? 'captionStrong' : 'caption'} tint={focused ? color.primary : color.text2}>
              {t(spec.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DockItem({ spec, focused, onPress }: { spec: TabSpec; focused: boolean; onPress: () => void }) {
  const grow = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(grow, { toValue: focused ? 1 : 0, useNativeDriver: false, friction: 8, tension: 90 }).start();
  }, [focused, grow]);
  return (
    <Animated.View style={{ flexGrow: grow.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }), flexBasis: 0 }}>
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel={t(spec.label)}
        accessibilityState={{ selected: focused }}
        onPress={onPress}
        style={{ height: DOCK_HEIGHT - 14, alignItems: 'center', justifyContent: 'center' }}
      >
        <Animated.View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            height: 44,
            paddingHorizontal: focused ? space.lg : space.sm,
            borderRadius: 22,
            backgroundColor: focused ? color.primary : 'transparent',
            opacity: grow.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }),
          }}
        >
          <Icon name={focused ? spec.activeIcon : spec.icon} size={22} tint={focused ? color.onPrimary : color.dockMuted} />
          {focused ? (
            <Text variant="smallStrong" tint={color.onPrimary} numberOfLines={1}>
              {t(spec.label)}
            </Text>
          ) : null}
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

/**
 * The driver's floating dock (mobile M6): an ink pill above the page, the active tab as an accent
 * pill with its word, the others as icons (their names are read out). Hidden while typing.
 *
 * M7 (owner, 2026-10-28): the pill is frosted glass. iOS and the web blur what scrolls under it
 * (expo-blur, included in Expo Go) under a part-strength ink. Android draws the see-through ink
 * without a blur: a real Android blur needs the page wrapped in a blur target, which the tab
 * navigator's own bar cannot be, so it stays a readable tinted glass over any page.
 */
const realBlur = Platform.OS === 'ios' || Platform.OS === 'web';

export function FloatingTabBar({ state, emitter, navigateToTab, specs }: BottomTabBarProps & { specs: TabSpec[] }) {
  const insets = useSafeAreaInsets();
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setTyping(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setTyping(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  if (typing) return null;
  return (
    <View
      accessibilityRole="tablist"
      pointerEvents="box-none"
      style={{ position: 'absolute', left: space.lg, right: space.lg, bottom: Math.max(insets.bottom, space.sm) + space.xs, alignItems: 'center' }}
    >
      <View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            width: '100%',
            maxWidth: 440,
            paddingHorizontal: space.sm - 1,
            height: DOCK_HEIGHT,
            borderRadius: DOCK_HEIGHT / 2,
          },
          // Android paints an elevation shadow through a see-through fill, so the glass carries
          // only its rim there.
          Platform.OS === 'android' ? null : elevation.card,
        ]}
      >
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: DOCK_HEIGHT / 2, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: color.dockGlassRim, backgroundColor: realBlur ? 'transparent' : color.dockFrost }]}
        >
          {realBlur ? (
            <>
              <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: color.dockGlass }]} />
            </>
          ) : null}
        </View>
        {state.routes.map((route, index) => {
          const spec = specs.find((s) => s.name === route.name);
          if (!spec) return null;
          const focused = state.index === index;
          return (
            <DockItem
              key={route.key}
              spec={spec}
              focused={focused}
              onPress={() => {
                const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true } as never) as { defaultPrevented?: boolean } | undefined;
                if (!focused && !event?.defaultPrevented) navigateToTab(route.key);
              }}
            />
          );
        })}
      </View>
    </View>
  );
}
