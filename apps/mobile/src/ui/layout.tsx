import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Keyboard, Platform, Pressable, RefreshControl, ScrollView, View, StyleSheet, type HostInstance, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/i18n/core';

import { AppHeader } from './header';
import { useDockSpace } from './tab-bar';
import { Divider, Icon, StatusSymbol, Text } from './primitives';
import { OfflineBanner } from './states';
import { color, elevation, gutter, space, type StatusTone } from './tokens';

// ------------------------------------------------------------------------------------- Screen

/**
 * A page: the app header, the offline strip, then the scrolling body with the 16 px gutter.
 * `back` draws the "← Back" link from the sheets above the title.
 */
export function Screen({
  title,
  subtitle,
  titleRight,
  back,
  children,
  footer,
  scroll = true,
  onRefresh,
  refreshing = false,
  contentStyle,
  header = true,
  background,
}: {
  /** False: the page draws its own top (the driver Home). */
  header?: boolean;
  /** The page colour (the redesigned pages sit on the canvas). */
  background?: string;
  title?: string;
  subtitle?: string | null;
  titleRight?: ReactNode;
  back?: string | true;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const head = (
    <>
      {back ? <BackLink label={back === true ? t('Back') : back} /> : null}
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginBottom: subtitle ? 2 : space.md }}>
          <Text variant="title" accessibilityRole="header" style={{ flex: 1 }}>
            {title}
          </Text>
          {titleRight}
        </View>
      ) : null}
      {subtitle ? (
        <Text variant="small" tint={color.text2} style={{ marginBottom: space.md }}>
          {subtitle}
        </Text>
      ) : null}
    </>
  );
  const dock = useDockSpace();
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: background ?? color.background }}>
      {header ? <AppHeader /> : null}
      <OfflineBanner />
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[{ paddingHorizontal: gutter, paddingTop: space.md, paddingBottom: space.xxxl + dock }, contentStyle]}
          refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
        >
          {head}
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1, paddingHorizontal: gutter, paddingTop: space.md, paddingBottom: footer ? 0 : dock }, contentStyle]}>
          {head}
          {children}
        </View>
      )}
      {footer ? <Footer dock={dock}>{footer}</Footer> : null}
    </SafeAreaView>
  );
}

/**
 * The bar under a page (the message composer, Send pages). It sits above the phone's gesture bar
 * or buttons (safe-area bottom inset) and above the floating dock, and rises with the keyboard:
 * when the keyboard opens it measures how much of the bar the keyboard covers and lifts it by that
 * much. Measuring works whether or not the system already resized the window (Android
 * edge-to-edge does not; iOS never does), so the bar is never hidden and never floats too high.
 */
function Footer({ dock, children }: { dock: number; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const ref = useRef<HostInstance>(null);
  const [lift, setLift] = useState(0);
  const liftRef = useRef(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = Keyboard.addListener(showEvent, (e) => {
      const keyboardTop = e.endCoordinates.screenY;
      const measure = () =>
        ref.current?.measureInWindow((_x, y, _w, h) => {
          // The bar's bottom as it would be without any lift.
          const bottom = y + h + liftRef.current;
          const next = Math.max(0, Math.round(bottom - keyboardTop));
          if (next === liftRef.current) return;
          liftRef.current = next;
          setLift(next);
        });
      requestAnimationFrame(measure);
      // Again once the system has finished any resize of its own (then the lift drops back).
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, 350);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      if (timer) clearTimeout(timer);
      liftRef.current = 0;
      setLift(0);
    });
    return () => {
      if (timer) clearTimeout(timer);
      show.remove();
      hide.remove();
    };
  }, []);
  // With the keyboard up, the gesture-bar inset is under the keyboard.
  const bottomRoom = lift > 0 ? space.sm : space.md + Math.max(dock, insets.bottom);
  return (
    <View
      ref={ref}
      style={{ paddingHorizontal: gutter, paddingTop: space.md, paddingBottom: bottomRoom, marginBottom: lift, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.divider, backgroundColor: color.background }}
    >
      {children}
    </View>
  );
}

export function BackLink({ label = t('Back') }: { label?: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', minHeight: 36, marginBottom: space.xs }}
    >
      <Icon name="arrow-left" size={18} tint={color.primary} />
      <Text variant="smallStrong" tint={color.primary}>
        {label}
      </Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------------------------ Section

/** A titled block separated by whitespace and hairlines — no cards, as on the sheets. */
export function Section({
  title,
  action,
  onAction,
  children,
  style,
}: {
  title?: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ marginTop: space.lg }, style]}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
          <Text variant="subheading" accessibilityRole="header" style={{ flex: 1 }}>
            {title}
          </Text>
          {action ? (
            <Pressable accessibilityRole="link" onPress={onAction} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text variant="smallStrong" tint={color.link}>
                {action}
              </Text>
              <Icon name="chevron-right" size={18} tint={color.link} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A lightly framed block (the sheets' bordered groups: active load, today's tasks). */
export function Panel({ children, style, tinted }: { children: ReactNode; style?: StyleProp<ViewStyle>; tinted?: boolean }) {
  return (
    <View
      style={[
        {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: color.border,
          borderRadius: 10,
          paddingHorizontal: space.md,
          paddingVertical: space.md,
          backgroundColor: tinted ? color.subtle : color.background,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Label / value pairs: "Reference number   PO778930". */
export function KeyValue({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  return (
    <>
      <View style={{ flexDirection: 'row', paddingVertical: space.sm, gap: space.md }}>
        <Text variant="small" tint={color.text2} style={{ width: 140 }}>
          {label}
        </Text>
        <View style={{ flex: 1 }}>{typeof value === 'string' ? <Text variant="small">{value}</Text> : value}</View>
      </View>
      {last ? null : <Divider />}
    </>
  );
}

// ----------------------------------------------------------------------------------- Timeline

export interface TimelineStep {
  key: string;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  right?: ReactNode;
  state: 'done' | 'current' | 'pending';
}

/** Steps with a check (done), a navy ring (current) or a gray ring (pending), joined by a line. */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <View>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const done = step.state === 'done';
        return (
          <View key={step.key} style={{ flexDirection: 'row', gap: space.md }}>
            <View style={{ alignItems: 'center', width: 24 }}>
              {done ? (
                <Icon name="check-circle" size={22} tint={color.success} />
              ) : (
                <View
                  style={{
                    width: 20,
                    height: 20,
                    margin: 1,
                    borderRadius: 10,
                    borderWidth: step.state === 'current' ? 6 : 2,
                    borderColor: step.state === 'current' ? color.primary : color.borderStrong,
                    backgroundColor: color.background,
                  }}
                />
              )}
              {last ? null : <View style={{ flex: 1, width: 2, backgroundColor: done ? color.success : color.divider, marginVertical: 2 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : space.lg, flexDirection: 'row', gap: space.sm }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="rowTitle" tint={step.state === 'pending' ? color.text2 : color.ink}>
                  {step.title}
                </Text>
                {step.subtitle ? (
                  <Text variant="small" tint={color.text2}>
                    {step.subtitle}
                  </Text>
                ) : null}
                {step.detail ? (
                  <Text variant="caption" tint={color.text3}>
                    {step.detail}
                  </Text>
                ) : null}
              </View>
              {step.right}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// -------------------------------------------------------------------------------------- Toast

interface ToastMessage {
  id: number;
  text: string;
  tone: StatusTone;
}

const ToastContext = createContext<(text: string, tone?: StatusTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const seq = useRef(0);

  const show = useCallback(
    (text: string, tone: StatusTone = 'info') => {
      const id = ++seq.current;
      setMessage({ id, text, tone });
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      setTimeout(() => {
        if (seq.current !== id) return;
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => {
          if (seq.current === id) setMessage(null);
        });
      }, 3200);
    },
    [opacity],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {message ? (
        <Animated.View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[
            {
              position: 'absolute',
              left: gutter,
              right: gutter,
              bottom: 96,
              opacity,
              backgroundColor: color.toast,
              borderRadius: 10,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
            },
            elevation.overlay,
          ]}
        >
          <View style={{ backgroundColor: color.background, borderRadius: 10, padding: 1 }}>
            <StatusSymbol tone={message.tone} size={16} />
          </View>
          <Text variant="small" tint={color.onToast} style={{ flex: 1 }}>
            {message.text}
          </Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: StatusTone) => void {
  return useContext(ToastContext);
}

/** Re-render every minute (header clock). */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return tick;
}
