import { FileText } from 'lucide-react';
import { useFileObjectUrl, type FileRef } from '@/lib/files';

/**
 * An image document, shown from the file store with the session or from a legacy inline copy.
 * While the bytes are on their way, a quiet placeholder keeps the row's shape.
 */
export function DocumentThumbnail({
  doc,
  alt,
  className,
}: {
  doc: FileRef;
  alt: string;
  className?: string;
}) {
  const src = useFileObjectUrl(doc);
  if (!src) return <FileText aria-hidden className="size-4 text-faint" />;
  return <img src={src} alt={alt} className={className} />;
}
