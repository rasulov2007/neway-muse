import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { keepFile } from '@/offline/files';

import { uuid } from './uuid';

/** A photo, video or PDF picked on the phone and kept in the app's storage until the TMS has it. */
export interface PickedMedia {
  uri: string;
  name: string;
  type: string;
  size: number | null;
  kind: 'image' | 'video' | 'pdf';
  /** Where its id goes once uploaded (a PTI checklist key …). */
  tag?: string | null;
}

export type MediaSource = 'camera' | 'library';

function extensionOf(type: string): string {
  if (type === 'application/pdf') return 'pdf';
  if (type === 'video/quicktime') return 'mov';
  if (type.startsWith('video/')) return 'mp4';
  if (type === 'image/png') return 'png';
  if (type === 'image/heic') return 'heic';
  return 'jpg';
}

/**
 * Takes a photo (or a short video when `video` is set) with the camera, or picks from the library.
 * The web build has no camera: it always opens the file picker. Returns null when the person
 * cancels or refuses the permission (the caller says why).
 */
export async function pickMedia(options: { source?: MediaSource; video?: boolean; prefix?: string; edit?: boolean } = {}): Promise<PickedMedia | { denied: true } | null> {
  const mediaTypes: ImagePicker.MediaType[] = options.video ? ['images', 'videos'] : ['images'];
  // edit: Android's free crop step after the photo (trim the table around a document). iOS only offers
  // a square crop, which would cut a card, so it is left out there.
  const pickerOptions: ImagePicker.ImagePickerOptions = { mediaTypes, quality: 0.7, videoMaxDuration: 60, allowsEditing: Boolean(options.edit) && Platform.OS === 'android' };
  let result: ImagePicker.ImagePickerResult;
  if (Platform.OS !== 'web' && options.source !== 'library') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { denied: true };
    result = await ImagePicker.launchCameraAsync(pickerOptions);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(pickerOptions);
  }
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const isVideo = asset.type === 'video';
  const type = asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
  const name = `${options.prefix ?? 'photo'}-${uuid().slice(0, 8)}.${extensionOf(type)}`;
  const kept = await keepFile(asset.uri, name);
  return { uri: kept.uri, name, type, size: kept.size ?? asset.fileSize ?? null, kind: isVideo ? 'video' : 'image' };
}

export function isDenied(value: unknown): value is { denied: true } {
  return Boolean(value && typeof value === 'object' && 'denied' in value);
}

/** The queue's file entry for a picked item. */
export function asQueueFile(media: PickedMedia) {
  return { uri: media.uri, name: media.name, type: media.type, size: media.size, tag: media.tag ?? null };
}
