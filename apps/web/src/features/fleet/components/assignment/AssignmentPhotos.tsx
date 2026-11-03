import { Camera, ImageOff, ImagePlus, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ASSIGNMENT_PHOTO_MAX_BYTES,
  ASSIGNMENT_PHOTO_MAX_COUNT,
  type AssignmentPhoto,
  type AssignmentPhotoUpload,
} from '@neway/shared';
import { IconButton, cn } from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { openFile, readAsDataUrl, useFileObjectUrl } from '@/lib/files';

/**
 * Pickup and drop photos of an assignment (2026-10-08).
 *
 * The picker takes several images at once and, on a phone, offers the camera or the library
 * (`accept="image/*"` without `capture`, so the person chooses). Each image is uploaded the moment
 * it is chosen; the record links the uploaded ids when the dialog is confirmed, so nothing is
 * attached to the assignment before then.
 */

/** A thumbnail of a stored image, fetched with the session; HEIC (no browser preview) shows its name. */
export function PhotoThumb({
  url,
  fileName,
  onRemove,
}: {
  url: string;
  fileName: string;
  onRemove?: () => void;
}) {
  const src = useFileObjectUrl({ fileUrl: url });
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border border-line bg-nw-panel">
      <button
        type="button"
        className="flex size-full items-center justify-center"
        onClick={() => openFile({ fileUrl: url, fileName })}
        aria-label={`Open ${fileName}`}
        title={fileName}
      >
        {src && !broken ? (
          <img
            src={src}
            alt={fileName}
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : broken ? (
          <span className="flex flex-col items-center gap-1 px-1 text-center text-[10px] text-muted">
            <ImageOff className="size-4" aria-hidden />
            <span className="line-clamp-2 break-all">{fileName}</span>
          </span>
        ) : (
          <span className="text-[10px] text-muted">Loading…</span>
        )}
      </button>
      {onRemove ? (
        <IconButton
          size="sm"
          variant="secondary"
          label={`Remove ${fileName}`}
          className="absolute top-0.5 right-0.5"
          onClick={onRemove}
        >
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Read-only row of linked photos. */
export function PhotoStrip({ photos, label }: { photos: AssignmentPhoto[]; label: string }) {
  if (photos.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <PhotoThumb key={p.id} url={p.url} fileName={p.fileName} />
        ))}
      </div>
    </div>
  );
}

/** Choose and upload photos; reports the uploaded list (ids are linked by the caller's save). */
export function PhotoPicker({
  truckId,
  label,
  value,
  onChange,
  onBusyChange,
}: {
  truckId: string;
  label: string;
  value: AssignmentPhotoUpload[];
  onChange: (next: AssignmentPhotoUpload[]) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The latest list, so uploads that finish one after another all land.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const pick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const chosen = Array.from(files);
    const room = ASSIGNMENT_PHOTO_MAX_COUNT - latest.current.length;
    if (chosen.length > room) {
      setError(`Up to ${ASSIGNMENT_PHOTO_MAX_COUNT} photos.`);
      chosen.splice(room);
    }
    setBusy((n) => n + chosen.length);
    onBusyChange?.(true);
    for (const file of chosen) {
      try {
        if (file.type && !file.type.startsWith('image/')) {
          throw new Error(`${file.name} is not a photo.`);
        }
        if (file.size > ASSIGNMENT_PHOTO_MAX_BYTES) {
          throw new Error(`${file.name} is larger than 15 MB.`);
        }
        const content = await readAsDataUrl(file);
        const uploaded = await apiPost<AssignmentPhotoUpload>(
          `/trucks/${truckId}/assignment/photos`,
          { fileName: file.name || 'photo.jpg', content },
        );
        latest.current = [...latest.current, uploaded];
        onChange(latest.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The photo could not be uploaded.');
      } finally {
        setBusy((n) => {
          const left = n - 1;
          if (left === 0) onBusyChange?.(false);
          return left;
        });
      }
    }
  };

  const [over, setOver] = useState(false);
  const full = value.length >= ASSIGNMENT_PHOTO_MAX_COUNT;
  const open = () => {
    if (!full && busy === 0) input.current?.click();
  };
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      if (!full) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
      if (!full) void pick(event.dataTransfer?.files ?? null);
    },
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        // Nothing yet: one wide, friendly target - tap on a phone opens camera or library.
        <button
          type="button"
          onClick={open}
          disabled={busy > 0}
          {...dropProps}
          className={cn(
            'flex min-h-28 w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors',
            'border-nw-accent/40 bg-nw-accent-tint/40 hover:border-nw-accent hover:bg-nw-accent-tint',
            over && 'border-nw-accent bg-nw-accent-tint',
            busy > 0 && 'cursor-wait',
          )}
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-surface text-nw-accent">
            {busy > 0 ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Camera className="size-5" aria-hidden />}
          </span>
          <span className="text-sm font-semibold text-ink">{busy > 0 ? 'Uploading…' : label}</span>
          <span className="text-xs text-muted">Take a photo or choose from your library · or drop them here</span>
        </button>
      ) : (
        <div className="flex flex-col gap-1.5" {...dropProps}>
          <div className={cn('flex flex-wrap gap-2 rounded-lg p-1 transition-colors', over && 'bg-nw-accent-tint')}>
            {value.map((p) => (
              <PhotoThumb
                key={p.fileId}
                url={p.url}
                fileName={p.fileName}
                onRemove={() => onChange(value.filter((x) => x.fileId !== p.fileId))}
              />
            ))}
            {full ? null : (
              <button
                type="button"
                onClick={open}
                disabled={busy > 0}
                aria-label={label}
                className={cn(
                  'flex size-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-center transition-colors',
                  'border-nw-accent/40 bg-nw-accent-tint/40 text-nw-accent hover:border-nw-accent hover:bg-nw-accent-tint',
                  busy > 0 && 'cursor-wait',
                )}
              >
                {busy > 0 ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <ImagePlus className="size-5" aria-hidden />}
                <span className="text-xs font-semibold">{busy > 0 ? 'Uploading…' : 'Add more'}</span>
              </button>
            )}
          </div>
          <span className="text-xs text-muted">
            {value.length} of {ASSIGNMENT_PHOTO_MAX_COUNT} photos{full ? ' - the most one record keeps' : ''}
          </span>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label={label}
        data-testid="assignment-photo-input"
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = '';
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted">JPEG, PNG, WebP or HEIC, up to 15 MB each.</p>
      )}
    </div>
  );
}
