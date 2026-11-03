import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { api } from '@/api/client';
import { t } from '@/i18n';
import { absoluteUrl } from '@/lib/config';
import { isDenied, pickMedia, type PickedMedia } from '@/lib/media';
import { openSignedLink } from '@/lib/open-file';

import { Button } from './controls';
import { useToast } from './layout';
import { Icon, StatusSymbol, Text } from './primitives';
import { color, radius, space } from './tokens';

/**
 * Photos (and a video or PDF) attached to a form, with the dashed "Add photo" tile from sheets 08
 * and 10. The files are already kept on the phone; removing one only drops it from the form.
 */
export function MediaStrip({
  items,
  onChange,
  max = 10,
  video = false,
  addLabel = t('Add photo'),
  prefix,
  tag,
  size = 96,
}: {
  items: PickedMedia[];
  onChange: (items: PickedMedia[]) => void;
  max?: number;
  video?: boolean;
  addLabel?: string;
  prefix?: string;
  tag?: string | null;
  size?: number;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const picked = await pickMedia({ video, prefix });
      if (isDenied(picked)) {
        toast(t('Camera access is off for NeWay. Turn it on in Settings to add a photo.'), 'warning');
        return;
      }
      if (picked) onChange([...items, { ...picked, tag: tag ?? null }]);
    } catch {
      toast(t('Could not add that file.'), 'warning');
    } finally {
      setBusy(false);
    }
  };
  const height = Math.round(size * 0.75);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      {items.map((m, i) => (
        <View key={`${m.uri}${i}`} style={{ width: size, height, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.subtle }}>
          {m.kind === 'image' ? (
            <Image source={{ uri: m.uri }} style={{ flex: 1 }} accessibilityLabel={t('Photo {n}', { n: i + 1 })} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
              <Icon name={m.kind === 'video' ? 'video-outline' : 'file-pdf-box'} size={26} tint={color.text2} />
              <Text variant="caption" tint={color.text2}>
                {m.kind === 'video' ? t('Video') : 'PDF'}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={m.kind === 'image' ? t('Remove photo {n}', { n: i + 1 }) : m.kind === 'video' ? t('Remove video {n}', { n: i + 1 }) : t('Remove PDF {n}', { n: i + 1 })}
            onPress={() => onChange(items.filter((_, j) => j !== i))}
            hitSlop={8}
            style={{ position: 'absolute', top: 4, right: 4, backgroundColor: color.background, borderRadius: 10, padding: 1 }}
          >
            <Icon name="close" size={16} />
          </Pressable>
        </View>
      ))}
      {items.length < max ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={addLabel}
          onPress={add}
          disabled={busy}
          style={({ pressed }) => ({
            width: size,
            height,
            borderRadius: radius.lg,
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: color.primary,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            backgroundColor: pressed ? color.subtlePressed : color.primaryTint,
          })}
        >
          {busy ? <ActivityIndicator size="small" color={color.text2} /> : <Icon name="camera-plus-outline" size={24} tint={color.primary} />}
          <Text variant="captionStrong" tint={color.primaryInk}>
            {addLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One photo of a personal document (CDL, medical card …), mobile M7: a large rounded card. Empty,
 * it shows what to photograph and two clear choices, Take photo and Choose from gallery (on the
 * web only the file picker). With a photo, it shows the picture large with "Ready" and Retake /
 * Remove. `shape="card"` is the ID-card proportion; `"page"` a sheet of paper.
 */
export function DocumentPhotoCard({
  value,
  onChange,
  what,
  prefix,
  shape = 'card',
}: {
  value: PickedMedia | null;
  onChange: (value: PickedMedia | null) => void;
  /** What to photograph, e.g. "CDL (front)". */
  what: string;
  prefix?: string;
  shape?: 'card' | 'page';
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'camera' | 'library' | null>(null);
  const take = async (source: 'camera' | 'library') => {
    setBusy(source);
    try {
      const picked = await pickMedia({ source, prefix, edit: true });
      if (isDenied(picked)) {
        toast(t('Camera access is off for NeWay. Turn it on in Settings, or choose a photo from the gallery.'), 'warning');
        return;
      }
      if (picked) onChange(picked);
    } catch {
      toast(t('Could not add that file.'), 'warning');
    } finally {
      setBusy(null);
    }
  };
  const aspectRatio = shape === 'card' ? 1.586 : 0.8;
  const web = Platform.OS === 'web';

  if (value) {
    return (
      <View style={{ gap: space.md }}>
        <View style={{ borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.subtle, aspectRatio, maxHeight: 440, borderWidth: 1, borderColor: color.border }}>
          {value.kind === 'image' ? (
            <Image source={{ uri: value.uri }} resizeMode="cover" style={{ flex: 1 }} accessibilityLabel={t('Photo of {what}', { what })} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs }}>
              <Icon name="file-pdf-box" size={48} tint={color.text2} />
              <Text variant="small" tint={color.text2}>
                {value.name}
              </Text>
            </View>
          )}
          <View style={{ position: 'absolute', top: space.md, left: space.md, flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: color.successBg, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs }}>
            <StatusSymbol tone="success" size={14} />
            <Text variant="captionStrong" tint={color.success}>
              {t('Ready to send')}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Button style={{ flex: 1 }} variant="outline" icon={web ? 'image-outline' : 'camera-retake-outline'} label={t('Retake')} loading={busy !== null} onPress={() => void take(web ? 'library' : 'camera')} />
          <Button style={{ flex: 1 }} variant="outline" icon="delete-outline" label={t('Remove')} onPress={() => onChange(null)} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ borderRadius: radius.xl, backgroundColor: color.primaryTint, padding: space.xl, gap: space.lg, alignItems: 'center' }}>
      <View style={{ width: '100%', aspectRatio, maxHeight: 220, borderRadius: radius.lg, borderWidth: 2, borderStyle: 'dashed', borderColor: color.primary, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: color.panel }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={shape === 'card' ? 'card-account-details-outline' : 'file-document-outline'} size={32} tint={color.primary} />
        </View>
        <Text variant="bodyStrong" style={{ textAlign: 'center', paddingHorizontal: space.md }}>
          {t('Add a photo of your {what}', { what })}
        </Text>
      </View>
      <Text variant="small" tint={color.primaryInk} style={{ textAlign: 'center' }}>
        {t('Lay it flat in good light, with all four corners in the frame and no glare.')}
      </Text>
      <View style={{ flexDirection: 'row', gap: space.md, alignSelf: 'stretch' }}>
        {web ? null : <Button style={{ flex: 1 }} icon="camera-outline" label={t('Take photo')} loading={busy === 'camera'} disabled={busy !== null} onPress={() => void take('camera')} />}
        <Button style={{ flex: 1 }} variant="outline" icon="image-multiple-outline" label={web ? t('Choose a file') : t('Gallery')} loading={busy === 'library'} disabled={busy !== null} onPress={() => void take('library')} />
      </View>
    </View>
  );
}

/**
 * An image the server keeps (PTI photo, receipt, message attachment): the screen asks for a
 * 5-minute signed link with this session, then shows it; a tap opens it full size. A file that is
 * not an image shows its icon and opens in the viewer.
 */
export function SignedImage({
  linkRoute,
  contentType,
  label,
  style,
}: {
  linkRoute: string;
  contentType?: string | null;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = !contentType || contentType.startsWith('image/');
  useEffect(() => {
    let live = true;
    if (!isImage) return;
    api
      .get<{ url: string }>(linkRoute)
      .then((l) => live && setUrl(absoluteUrl(l.url)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [linkRoute, isImage]);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={label ?? t('Open file')}
      onPress={() => void openSignedLink(linkRoute).catch(() => setFailed(true))}
      style={[{ borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.subtle, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      {isImage && url ? (
        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setFailed(true)} />
      ) : failed ? (
        <View style={{ alignItems: 'center', gap: 2, padding: space.sm }}>
          <Icon name="image-off-outline" size={24} tint={color.text3} />
          <Text variant="caption" tint={color.text3}>
            {t('Not available')}
          </Text>
        </View>
      ) : isImage ? (
        <ActivityIndicator size="small" color={color.text2} />
      ) : (
        <View style={{ alignItems: 'center', gap: 2, padding: space.sm }}>
          <Icon name={contentType?.includes('pdf') ? 'file-pdf-box' : contentType?.startsWith('video') ? 'video-outline' : 'file-outline'} size={28} tint={color.text2} />
          <Text variant="caption" tint={color.text2} numberOfLines={1}>
            {label ?? t('Open')}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
