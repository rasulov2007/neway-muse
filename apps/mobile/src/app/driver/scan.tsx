import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, View, StyleSheet, type LayoutRectangle } from 'react-native';

import { routes, type DriverLoadDetail, type DriverLoadsResponse } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { placeOf, sortedStops } from '@/features/loads';
import { t, tn } from '@/i18n';
import { documentScannerAvailable, scanWithDocumentScanner } from '@/lib/doc-scanner';
import { prepareDocument } from '@/lib/scan';
import { uuid } from '@/lib/uuid';
import { useQueue } from '@/offline/queue';
import { Button, Select, TextField } from '@/ui/controls';
import { Screen, useToast } from '@/ui/layout';
import { Icon, Text } from '@/ui/primitives';
import { color, radius, space } from '@/ui/tokens';

type DocType = 'bol' | 'pod' | 'lumper_receipt' | 'tonu' | 'layover' | 'detention' | 'other';
const DOC_TYPES: readonly DocType[] = ['bol', 'pod', 'lumper_receipt', 'tonu', 'layover', 'detention', 'other'];

/** The picker's words (the web TMS's load document types, same order of the driver's papers). */
function typeOptions(): Array<{ value: DocType; label: string }> {
  return [
    { value: 'bol', label: t('Bill of Lading (BOL)') },
    { value: 'pod', label: t('Proof of Delivery (POD)') },
    { value: 'lumper_receipt', label: t('Lumper receipt') },
    { value: 'tonu', label: t('TONU') },
    { value: 'layover', label: t('Layover') },
    { value: 'detention', label: t('Detention') },
    { value: 'other', label: t('Other') },
  ];
}

function shortName(type: DocType): string {
  return { bol: 'BOL', pod: 'POD', lumper_receipt: t('Lumper receipt'), tonu: 'TONU', layover: t('Layover'), detention: t('Detention'), other: t('Document') }[type];
}

const isDocType = (v: string | undefined): v is DocType => (DOC_TYPES as readonly string[]).includes(v ?? '');

interface Page {
  uri: string;
  width?: number;
  height?: number;
  /** The whole photo, before the page frame cropped it (the camera fallback only). */
  full?: Page;
}

/** A letter-size page (8.5 × 11) in the frame. */
const PAGE_RATIO = 8.5 / 11;

/** Where the page frame sits inside the camera box. */
function frameIn(box: { width: number; height: number }): LayoutRectangle {
  let width = box.width * 0.84;
  let height = width / PAGE_RATIO;
  if (height > box.height * 0.88) {
    height = box.height * 0.88;
    width = height * PAGE_RATIO;
  }
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * The photo cropped to the page frame. The preview fills its box (cover), so the frame is mapped
 * back onto the photo through the same scale; a little margin is kept so no edge is lost. A photo
 * whose orientation does not match the preview is left whole.
 */
async function cropToFrame(photo: Page, box: { width: number; height: number }): Promise<Page> {
  const pw = photo.width ?? 0;
  const ph = photo.height ?? 0;
  if (!pw || !ph || !box.width || !box.height || pw > ph !== box.width > box.height) return photo;
  const f = frameIn(box);
  const scale = Math.max(box.width / pw, box.height / ph);
  const offsetX = (pw * scale - box.width) / 2;
  const offsetY = (ph * scale - box.height) / 2;
  const margin = 0.03;
  const originX = Math.max(0, Math.round((f.x + offsetX) / scale - pw * margin));
  const originY = Math.max(0, Math.round((f.y + offsetY) / scale - ph * margin));
  const width = Math.min(pw - originX, Math.round(f.width / scale + pw * margin * 2));
  const height = Math.min(ph - originY, Math.round(f.height / scale + ph * margin * 2));
  if (width < 200 || height < 200) return photo;
  const image = await ImageManipulator.manipulate(photo.uri).crop({ originX, originY, width, height }).renderAsync();
  const saved = await image.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
  return { uri: saved.uri, width: saved.width, height: saved.height, full: photo };
}

/** Dimmed surroundings, the page frame with bold corners, and the hint (the camera fallback). */
function PageFrame({ box }: { box: { width: number; height: number } }) {
  const f = frameIn(box);
  const corner = 28;
  const line = 4;
  const dim = color.overlay;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: f.y, backgroundColor: dim }} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: f.y + f.height, bottom: 0, backgroundColor: dim }} />
      <View style={{ position: 'absolute', left: 0, width: f.x, top: f.y, height: f.height, backgroundColor: dim }} />
      <View style={{ position: 'absolute', right: 0, width: f.x, top: f.y, height: f.height, backgroundColor: dim }} />
      <View style={{ position: 'absolute', left: f.x, top: f.y, width: f.width, height: f.height, borderWidth: 1, borderColor: color.onCardLine, borderRadius: radius.sm }} />
      {[
        { left: f.x, top: f.y, borderLeftWidth: line, borderTopWidth: line, borderTopLeftRadius: radius.md },
        { left: f.x + f.width - corner, top: f.y, borderRightWidth: line, borderTopWidth: line, borderTopRightRadius: radius.md },
        { left: f.x, top: f.y + f.height - corner, borderLeftWidth: line, borderBottomWidth: line, borderBottomLeftRadius: radius.md },
        { left: f.x + f.width - corner, top: f.y + f.height - corner, borderRightWidth: line, borderBottomWidth: line, borderBottomRightRadius: radius.md },
      ].map((s, i) => (
        <View key={i} style={[{ position: 'absolute', width: corner, height: corner, borderColor: color.primary }, s]} />
      ))}
      <View style={{ position: 'absolute', top: space.sm, left: 0, right: 0, alignItems: 'center' }}>
        <View style={{ backgroundColor: color.overlay, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs }}>
          <Text variant="captionStrong" tint={color.onCard}>
            {t('Fit the page inside the frame')}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Sheet 04, mobile M7. Scan opens the camera in document mode: in a development or store build
 * that is the phone's own document scanner (ML Kit on Android, VisionKit on iOS: finds the edges,
 * straightens the page, cleans it up; several pages in one go). Expo Go has no such scanner, so
 * there the screen's own camera shows a page frame and crops each photo to it. Photos can also be
 * chosen from the gallery (the only path on the web). Each page can be previewed, rotated or
 * removed; Send keeps the files on the phone and hands them to the upload queue.
 */
export default function ScanDocuments() {
  const params = useLocalSearchParams<{ loadId?: string; type?: string; stopId?: string; replacesId?: string }>();
  const [loadId, setLoadId] = useState<string | null>(params.loadId || null);
  const [docType, setDocType] = useState<DocType>(isDocType(params.type) ? params.type : 'pod');
  const [stopId, setStopId] = useState<string | null>(params.stopId || null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pending, setPending] = useState<Page | null>(null);
  const [selected, setSelected] = useState(0);
  const nativeScanner = useMemo(() => documentScannerAvailable(), []);
  const [cameraOn, setCameraOn] = useState(Platform.OS !== 'web' && !nativeScanner);
  const [busy, setBusy] = useState<string | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const cameraRef = useRef<CameraView>(null);
  const launched = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const queue = useQueue();
  const toast = useToast();

  const active = useResource<DriverLoadsResponse>(params.loadId ? null : routes.driverLoads('active'));
  const detail = useResource<DriverLoadDetail>(loadId ? routes.driverLoad(loadId) : null);
  const load = detail.status === 'ready' ? detail.data : undefined;
  const loadNumber = load?.loadNumber ?? (active.status === 'ready' ? active.data.loads.find((l) => l.id === loadId)?.loadNumber : undefined);
  const stops = useMemo(() => (load ? sortedStops(load.stops) : []), [load]);

  const scan = async () => {
    setBusy('scan');
    try {
      const scanned = await scanWithDocumentScanner();
      if (scanned?.length) {
        setSelected(pages.length);
        setPages((p) => [...p, ...scanned]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : t('The scanner could not start.'), 'warning');
    } finally {
      setBusy(null);
    }
  };

  // Pressing Scan opens the document scanner straight away.
  useEffect(() => {
    if (!nativeScanner || launched.current) return;
    launched.current = true;
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeScanner]);

  const capture = async () => {
    if (!cameraRef.current) return;
    setBusy('capture');
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo) return;
      const whole = { uri: photo.uri, width: photo.width, height: photo.height };
      setPending(await cropToFrame(whole, box).catch(() => whole));
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 0.8, selectionLimit: 10 });
    if (result.canceled) return;
    const added = result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height }));
    setSelected(pages.length);
    setPages([...pages, ...added]);
    setCameraOn(false);
  };

  const usePending = (page: Page | null | undefined) => {
    if (!page) return;
    setSelected(pages.length);
    setPages([...pages, { uri: page.uri, width: page.width, height: page.height }]);
    setPending(null);
    setCameraOn(false);
  };

  const rotate = async () => {
    const page = pages[selected];
    if (!page) return;
    setBusy('rotate');
    try {
      const image = await ImageManipulator.manipulate(page.uri).rotate(90).renderAsync();
      const saved = await image.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
      setPages((p) => p.map((pg, i) => (i === selected ? { uri: saved.uri, width: saved.width, height: saved.height } : pg)));
    } catch {
      toast(t('Could not rotate this photo.'), 'warning');
    } finally {
      setBusy(null);
    }
  };

  const remove = () => {
    setPages((p) => p.filter((_, i) => i !== selected));
    setSelected((s) => Math.max(0, s - 1));
  };

  const send = async () => {
    if (!loadId || pages.length === 0) return;
    setBusy('send');
    try {
      const id = uuid();
      const key = uuid();
      const file = await prepareDocument(pages, `${docType}-${key.slice(0, 8)}`);
      const stop = stops.find((s) => s.id === stopId);
      await queue.enqueue({
        id,
        idempotencyKey: key,
        kind: 'load-document',
        title: t('{doc} · Load #{number}', { doc: shortName(docType), number: loadNumber ?? loadId }),
        subtitle: [tn(pages.length, '{count} page', '{count} pages'), stop ? placeOf(stop) : null].filter(Boolean).join(' · '),
        payload: { loadId, docType, stopId: stopId ?? null, pageCount: file.pageCount, replacesId: params.replacesId || null },
        files: [{ uri: file.uri, name: file.name, type: file.type, size: file.size }],
      });
      toast(t('Saved on phone. Uploading when there is a connection.'), 'success');
      router.replace('/driver/uploads');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('Could not save the pages.'), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const current = pending ?? pages[selected];
  const showCamera = cameraOn && !pending && Platform.OS !== 'web' && !nativeScanner;

  return (
    <Screen
      back
      title={t('Scan documents')}
      footer={
        pending ? (
          <View style={{ gap: space.xs }}>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Button style={{ flex: 1 }} variant="outline" icon="camera-retake-outline" label={t('Retake')} onPress={() => setPending(null)} />
              <Button style={{ flex: 1 }} icon="check" label={t('Use page')} onPress={() => usePending(pending)} />
            </View>
            {pending.full ? <Button variant="link" style={{ alignSelf: 'center' }} label={t('Keep the whole photo')} onPress={() => usePending(pending.full)} /> : null}
          </View>
        ) : pages.length ? (
          <Button
            icon="cloud-upload-outline"
            label={tn(pages.length, 'Send {count} page', 'Send {count} pages')}
            disabled={!loadId}
            loading={busy === 'send'}
            onPress={send}
          />
        ) : null
      }
    >
      <View style={{ gap: space.md }}>
        <Select label={t('Document type')} value={docType} options={typeOptions()} onChange={setDocType} />
        {params.loadId ? (
          <TextField label={t('Load number')} value={loadNumber ? `#${loadNumber}` : detail.status === 'loading' ? t('Loading…') : params.loadId} readOnly />
        ) : (
          <Select
            label={t('Load')}
            value={loadId}
            placeholder={active.status === 'loading' ? t('Loading…') : active.status === 'error' ? t('Your loads are not available') : t('Choose the load')}
            options={active.status === 'ready' ? active.data.loads.map((l) => ({ value: l.id, label: `#${l.loadNumber}`, description: `${placeOf(l.firstPickup)} → ${placeOf(l.lastDelivery)}` })) : []}
            onChange={(v) => {
              setLoadId(v);
              setStopId(null);
            }}
            error={active.status === 'error' ? (active.error.detail ?? active.error.title) : null}
          />
        )}
        {stops.length ? (
          <Select
            label={t('Stop')}
            value={stopId}
            placeholder={t('Which stop is this for?')}
            options={stops.map((s, i) => ({ value: s.id, label: `${i + 1}. ${s.kind === 'pickup' ? t('Pickup') : t('Delivery')} — ${placeOf(s)}`, description: s.facilityName }))}
            onChange={setStopId}
          />
        ) : null}
      </View>

      <View
        onLayout={(e) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
        style={{ marginTop: space.lg, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.ink, height: 420 }}
      >
        {showCamera ? (
          permission?.granted ? (
            <>
              <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back" />
              {box.width ? <PageFrame box={box} /> : null}
              <View style={{ position: 'absolute', bottom: space.lg, left: 0, right: 0, alignItems: 'center' }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('Take photo')}
                  disabled={busy === 'capture'}
                  onPress={capture}
                  style={{ width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: color.onCard, alignItems: 'center', justifyContent: 'center' }}
                >
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: busy === 'capture' ? color.onCardMuted : color.onCard }} />
                </Pressable>
              </View>
            </>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md, backgroundColor: color.subtle }}>
              <Icon name="camera-outline" size={40} tint={color.text2} />
              <Text variant="small" tint={color.text2} style={{ textAlign: 'center' }}>
                {permission?.canAskAgain === false ? t('Camera access is off for NeWay TMS. Turn it on in Settings, or choose photos instead.') : t('Allow the camera to scan documents.')}
              </Text>
              {permission?.canAskAgain !== false ? <Button label={t('Allow camera')} onPress={() => void requestPermission()} /> : null}
            </View>
          )
        ) : current ? (
          <Image source={{ uri: current.uri }} resizeMode="contain" style={{ flex: 1, backgroundColor: color.subtle }} accessibilityLabel={t('Page preview')} />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => (nativeScanner ? void scan() : Platform.OS === 'web' ? void pick() : setCameraOn(true))}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md, backgroundColor: color.primaryTint }}
          >
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: color.panel, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="file-document-outline" size={36} tint={color.primary} />
            </View>
            <Text variant="bodyStrong" tint={color.primaryInk} style={{ textAlign: 'center' }}>
              {Platform.OS === 'web' ? t('Choose photos of the pages') : t('Scan each page')}
            </Text>
            <Text variant="small" tint={color.primaryInk} style={{ textAlign: 'center' }}>
              {Platform.OS === 'web' ? t('The camera is not available here.') : t('The scanner finds the page edges and straightens it.')}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        {nativeScanner && !pending ? (
          <Button style={{ flex: 1 }} icon="file-document-multiple-outline" label={pages.length ? t('Scan more pages') : t('Scan pages')} loading={busy === 'scan'} onPress={() => void scan()} />
        ) : null}
        {!nativeScanner && !showCamera && Platform.OS !== 'web' && !pending ? (
          <Button style={{ flex: 1 }} variant="outline" icon="camera-outline" label={pages.length ? t('Add page') : t('Use camera')} onPress={() => setCameraOn(true)} />
        ) : null}
        {!pending ? <Button style={{ flex: 1 }} variant="outline" icon="image-multiple-outline" label={t('Gallery')} onPress={pick} /> : null}
      </View>

      {pages.length && !pending ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: space.md }}>
            {pages.map((p, i) => (
              <Pressable
                key={`${p.uri}${i}`}
                accessibilityRole="button"
                accessibilityLabel={t('Page {n}', { n: i + 1 })}
                accessibilityState={{ selected: i === selected }}
                onPress={() => {
                  setSelected(i);
                  setCameraOn(false);
                }}
                style={{ width: 64, height: 84, borderRadius: radius.md, overflow: 'hidden', borderWidth: i === selected ? 2 : StyleSheet.hairlineWidth, borderColor: i === selected ? color.primary : color.border }}
              >
                <Image source={{ uri: p.uri }} style={{ flex: 1 }} />
                <View style={{ position: 'absolute', bottom: 2, left: 2, backgroundColor: color.overlay, borderRadius: 4, paddingHorizontal: 4 }}>
                  <Text variant="caption" tint={color.onCard}>
                    {i + 1}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: space.lg }}>
            <Button variant="link" icon="rotate-right" label={t('Rotate')} loading={busy === 'rotate'} onPress={rotate} />
            <Button variant="link" icon="delete-outline" label={t('Remove page')} onPress={remove} />
          </View>
          {!loadId ? (
            <Text variant="small" tint={color.danger}>
              {t('Choose the load these pages belong to.')}
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
